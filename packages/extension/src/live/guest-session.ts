import { parseDeckText, type Deck, type LivePeer } from "@slidepix/core";
import { missingMedia } from "./asset-mirror";
import { colorForId } from "./color";
import { LIVE_LIMITS } from "./limits";
import { GuestSync } from "./sync";
import { sha256, type LiveLink } from "./transport";
import type { ControlFrame } from "./wire";

export type GuestHooks = {
  displayName: string;
  secret: Buffer;
  revisionOf(text: string): string;
  requestId(): string;
  getText(): string;
  applyText(text: string, baseRevision: string): Promise<boolean>;
  prepareMirror(relativePath: string, text: string): Promise<{ deckPath: string; linkedRoots: string[] }>;
  writeAsset(reference: string, storage: "embedded" | "linked", bytes: Uint8Array, sha256: string): Promise<void>;
  onPeers(peers: LivePeer[], self: LivePeer, hostName: string): void;
  onAssets(references: string[]): void;
  onError(message: string): void;
  onEnded(message: string): void;
  onDisconnected(): void;
  canEdit(value: boolean): void;
};

type Download = {
  reference: string;
  storage: "embedded" | "linked";
  sha256?: string;
  size?: number;
  bytes?: Uint8Array;
  resolve: (bytes: Uint8Array) => void;
  reject: (error: Error) => void;
};

export class GuestSession {
  applying = false;
  canEdit = true;
  private sync?: GuestSync;
  private link?: LiveLink;
  private hostName = "Host";
  private selfId = "";
  private readonly peers = new Map<string, LivePeer>();
  private readonly downloads = new Map<string, Download>();
  private readonly uploads = new Map<string, { resolve: (reference: string) => void; reject: (error: Error) => void }>();
  private flushWaiters: Array<() => void> = [];

  constructor(private readonly hooks: GuestHooks) {}

  attach(link: LiveLink, selfId: string): void {
    this.link?.close();
    this.link = link;
    this.selfId = selfId;
    this.canEdit = true;
    link.onFrame((frame) => { void this.onFrame(frame); });
    link.onAsset((asset) => { this.onAsset(asset); });
    void link.send({ type: "hello", protocol: 1, name: this.hooks.displayName, secret: this.hooks.secret.toString("base64url") });
    void link.closed.then(() => { if (this.link === link && this.canEdit) this.hooks.onDisconnected(); });
  }

  onDocument(text: string): void {
    if (this.applying || !this.sync || !this.canEdit || !this.link) return;
    const edit = this.sync.localEdit(text);
    if (edit) void this.link.send({ type: "edit", ...edit }).catch((error: unknown) => this.hooks.onError(error instanceof Error ? error.message : "Could not send the edit."));
    this.releaseFlush();
  }

  setPresence(frame: Extract<ControlFrame, { type: "presence" }>): void {
    if (!this.link || !this.canEdit) return;
    void this.link.send({ ...frame, name: this.hooks.displayName }).catch(() => undefined);
  }

  async uploadAsset(bytes: Uint8Array, name: string, mime: string): Promise<string> {
    const link = this.requireLink();
    if (bytes.byteLength > LIVE_LIMITS.maxAssetBytes) throw new Error("Media files are limited to 100 MB.");
    const requestId = this.hooks.requestId();
    const hash = sha256(bytes);
    const result = new Promise<string>((resolve, reject) => this.uploads.set(requestId, { resolve, reject }));
    await link.send({ type: "assetUpload", requestId, name, mime, size: bytes.byteLength, sha256: hash });
    await link.sendAsset(requestId, bytes, hash);
    return result;
  }

  async embedMedia(elementIds?: string[]): Promise<void> {
    await this.requireLink().send({ type: "embedMedia", elementIds });
  }

  async saveHost(): Promise<void> {
    const link = this.requireLink();
    const request = new Promise<void>((resolve, reject) => {
      this.saveWaiter = { resolve, reject };
    });
    await link.send({ type: "save" });
    await request;
  }

  async ensureAssets(items: { reference: string; storage: "embedded" | "linked" }[]): Promise<void> {
    const stored: string[] = [];
    for (const item of items) {
      const requestId = this.hooks.requestId();
      const bytes = await new Promise<Uint8Array>((resolve, reject) => {
        this.downloads.set(requestId, { ...item, resolve, reject });
        void this.link?.send({ type: "assetRequest", requestId, reference: item.reference, storage: item.storage }).catch(reject);
      });
      await this.hooks.writeAsset(item.reference, item.storage, bytes, sha256(bytes));
      stored.push(item.reference);
    }
    if (stored.length) this.hooks.onAssets(stored);
  }

  async flush(timeoutMs: number): Promise<void> {
    if (!this.sync?.inflight) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { this.flushWaiters = this.flushWaiters.filter((item) => item !== done); resolve(); }, timeoutMs);
      const done = () => { clearTimeout(timer); resolve(); };
      this.flushWaiters.push(done);
    });
  }

  close(): void {
    this.canEdit = false;
    this.link?.close();
  }

  private saveWaiter?: { resolve: () => void; reject: (error: Error) => void };

  private async onFrame(frame: ControlFrame): Promise<void> {
    if (frame.type === "welcome") return this.onWelcome(frame);
    if (frame.type === "state") return this.onStep(this.sync?.onState(frame.revision, frame.text));
    if (frame.type === "rebase") return this.onStep(this.sync?.onRebase(frame.revision, frame.text));
    if (frame.type === "rejected") return this.onStep(this.sync?.onRejected(frame.revision, frame.text, frame.message));
    if (frame.type === "invalid") {
      this.hooks.onError(frame.message);
      return;
    }
    if (frame.type === "presence") return this.onPresence(frame);
    if (frame.type === "assetOffer") return this.noteOffer(frame);
    if (frame.type === "assetMissing") return this.failDownload(frame.requestId, frame.message);
    if (frame.type === "assetStored") {
      this.uploads.get(frame.requestId)?.resolve(frame.reference);
      this.uploads.delete(frame.requestId);
      return;
    }
    if (frame.type === "assetRejected") {
      this.uploads.get(frame.requestId)?.reject(new Error(frame.message));
      this.uploads.delete(frame.requestId);
      return;
    }
    if (frame.type === "saved") {
      if (frame.ok) this.saveWaiter?.resolve();
      else this.saveWaiter?.reject(new Error(frame.message ?? "The host could not save."));
      this.saveWaiter = undefined;
      return;
    }
    if (frame.type === "bye") {
      this.canEdit = false;
      this.hooks.canEdit(false);
      this.hooks.onEnded(frame.message ?? "The host ended the session.");
      this.publish();
    }
  }

  private async onWelcome(frame: Extract<ControlFrame, { type: "welcome" }>): Promise<void> {
    this.hostName = frame.hostName;
    const mirror = await this.hooks.prepareMirror(frame.relativePath, frame.text);
    this.deckPath = mirror.deckPath;
    this.linkedRoots = mirror.linkedRoots;
    if (!this.sync) this.sync = new GuestSync(frame.text, this.hooks.revisionOf, this.hooks.requestId);
    await this.onStep(this.sync.onState(frame.revision, frame.text));
    this.hooks.canEdit(true);
    this.publish();
  }

  private async onStep(step: ReturnType<GuestSync["onState"]> | undefined): Promise<void> {
    if (!step) return;
    if (step.error) this.hooks.onError(step.error);
    const current = this.hooks.getText();
    if (step.documentText !== current) {
      this.applying = true;
      try {
        const applied = await this.hooks.applyText(step.documentText, this.hooks.revisionOf(current));
        if (!applied) this.hooks.onError("The shared deck could not be updated.");
      } finally {
        this.applying = false;
      }
    }
    if (step.edit && this.link) await this.link.send({ type: "edit", ...step.edit }).catch(() => undefined);
    this.releaseFlush();
    const parsed = parseDeckText(step.documentText);
    if (parsed.ok) void this.pullMissing(parsed.deck).catch((error: unknown) => this.hooks.onError(error instanceof Error ? error.message : "Could not fetch media."));
  }

  private async pullMissing(deck: Deck): Promise<void> {
    const deckPath = this.deckPath;
    if (!deckPath) return;
    const missing = await missingMedia(deckPath, deck, this.linkedRoots);
    if (missing.length) await this.ensureAssets(missing);
  }

  deckPath?: string;
  linkedRoots: string[] = [];

  private onPresence(frame: Extract<ControlFrame, { type: "presence" }>): void {
    const id = frame.peerId;
    if (!id || id === this.selfId) return;
    if (!frame.elementIds.length && !frame.slideId && !frame.editingElementId && !frame.preview) {
      this.peers.delete(id);
    } else {
      this.peers.set(id, {
        id,
        name: frame.name || "Guest",
        color: colorForId(id),
        slideId: frame.slideId,
        elementIds: frame.elementIds,
        editingElementId: frame.editingElementId,
        preview: frame.preview
      });
    }
    this.publish();
  }

  private noteOffer(frame: Extract<ControlFrame, { type: "assetOffer" }>): void {
    const download = this.downloads.get(frame.requestId);
    if (!download) return;
    download.sha256 = frame.sha256;
    download.size = frame.size;
    if (download.bytes) this.completeDownload(frame.requestId);
  }

  private onAsset(asset: { requestId: string; bytes: Uint8Array; sha256: string }): void {
    const download = this.downloads.get(asset.requestId);
    if (!download) return;
    download.bytes = asset.bytes;
    download.sha256 ??= asset.sha256;
    this.completeDownload(asset.requestId);
  }

  private completeDownload(requestId: string): void {
    const download = this.downloads.get(requestId);
    if (!download?.bytes || !download.sha256) return;
    this.downloads.delete(requestId);
    if (sha256(download.bytes) !== download.sha256) download.reject(new Error("The received media did not match its checksum."));
    else download.resolve(download.bytes);
  }

  private failDownload(requestId: string, message: string): void {
    const download = this.downloads.get(requestId);
    if (!download) return;
    this.downloads.delete(requestId);
    download.reject(new Error(message));
  }

  private publish(): void {
    const self: LivePeer = { id: this.selfId, name: this.hooks.displayName, color: colorForId(this.selfId), elementIds: [] };
    this.hooks.onPeers([...this.peers.values()], self, this.hostName);
  }

  private releaseFlush(): void {
    if (this.sync?.inflight) return;
    for (const waiter of this.flushWaiters.splice(0)) waiter();
  }

  private requireLink(): LiveLink {
    if (!this.link || !this.canEdit) throw new Error("The live session is not connected.");
    return this.link;
  }
}
