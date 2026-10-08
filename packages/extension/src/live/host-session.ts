import { parseDeckText, type LivePeer } from "@slidepix/core";
import { colorForId } from "./color";
import { fingerprint, secretsMatch } from "./invite";
import { LIVE_LIMITS } from "./limits";
import { HostSequencer, type LiveEdit } from "./sync";
import { sha256, type LiveEndpoint, type LiveLink } from "./transport";
import type { ControlFrame } from "./wire";

export type HostHooks = {
  displayName: string;
  deckName: string;
  relativePath: string;
  secret: Buffer;
  requireApproval: boolean;
  endpointId: string;
  getText(): string;
  applyText(text: string, baseRevision: string): Promise<boolean>;
  approve(name: string, fingerprint: string): Promise<boolean>;
  storeAsset(bytes: Uint8Array, name: string, mime: string): Promise<string>;
  readAsset(reference: string, storage: "embedded" | "linked"): Promise<Uint8Array | undefined>;
  allowAsset(reference: string, storage: "embedded" | "linked"): boolean;
  embedMedia(elementIds?: string[]): Promise<void>;
  save(): Promise<void>;
  revisionOf(text: string): string;
  onPeers(peers: LivePeer[]): void;
  onStatus(message: string): void;
};

type Peer = {
  link: LiveLink;
  name: string;
  presence?: Extract<ControlFrame, { type: "presence" }>;
  seenAt: number;
  presenceMarks: number[];
  transfers: Map<string, { name: string; mime: string; size: number; sha256: string; bytes?: Uint8Array }>;
};

export class HostSession {
  readonly sequencer: HostSequencer;
  applying = false;
  private readonly peers = new Map<string, Peer>();
  private readonly approved = new Set<string>();
  private readonly banned = new Set<string>();
  private readonly failures = new Map<string, number>();
  private localPresence?: Extract<ControlFrame, { type: "presence" }>;
  private broadcastTimer: ReturnType<typeof setTimeout> | undefined;
  private expireTimer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  constructor(private readonly hooks: HostHooks) {
    this.sequencer = new HostSequencer(hooks.revisionOf);
    this.sequencer.remember(hooks.getText());
    this.expireTimer = setInterval(() => this.expirePresence(), 5_000);
  }

  listen(endpoint: LiveEndpoint): void {
    endpoint.accept((link) => { void this.admit(link); });
  }

  onDocument(text: string): void {
    if (this.applying || this.stopped) return;
    if (!this.sequencer.remember(text)) return;
    this.scheduleBroadcast();
  }

  setLocalPresence(frame: Extract<ControlFrame, { type: "presence" }>): void {
    this.localPresence = { ...frame, peerId: this.hooks.endpointId, name: this.hooks.displayName };
    void this.relay(this.hooks.endpointId, this.localPresence);
    this.publish();
  }

  async stop(message = "The host ended the session."): Promise<void> {
    this.stopped = true;
    if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
    if (this.expireTimer) clearInterval(this.expireTimer);
    await Promise.all([...this.peers.values()].map(async (peer) => {
      await peer.link.send({ type: "bye", message }).catch(() => undefined);
      peer.link.close();
    }));
    this.peers.clear();
    this.publish();
  }

  peerCount(): number {
    return this.peers.size;
  }

  private async admit(link: LiveLink): Promise<void> {
    const hello = link.takeHello();
    link.onFrame((frame) => { void this.onFrame(link, frame); });
    if (!hello || hello.protocol !== 1) return link.close();
    if (this.banned.has(link.remoteId)) return link.close();
    if (!secretsMatch(hello.secret, this.hooks.secret)) {
      const count = (this.failures.get(link.remoteId) ?? 0) + 1;
      this.failures.set(link.remoteId, count);
      if (count >= LIVE_LIMITS.secretFailures) this.banned.add(link.remoteId);
      return link.close();
    }
    if (!this.approved.has(link.remoteId)) {
      if (this.peers.size >= LIVE_LIMITS.maxGuests) return link.close();
      const allowed = this.hooks.requireApproval
        ? await this.hooks.approve(hello.name, fingerprint(link.remoteId))
        : true;
      if (!allowed || this.stopped) return link.close();
      this.approved.add(link.remoteId);
    }
    const previous = this.peers.get(link.remoteId);
    previous?.link.close();
    this.peers.set(link.remoteId, { link, name: hello.name.slice(0, 80), seenAt: Date.now(), presenceMarks: [], transfers: new Map() });
    link.onAsset((asset) => { void this.onAsset(link, asset); });
    const current = this.sequencer.current();
    await link.send({ type: "welcome", protocol: 1, revision: current.revision, text: current.text, hostName: this.hooks.displayName, deckName: this.hooks.deckName, relativePath: this.hooks.relativePath });
    if (this.localPresence) await link.send(this.localPresence).catch(() => undefined);
    for (const [id, peer] of this.peers) {
      if (id === link.remoteId || !peer.presence) continue;
      await link.send({ ...peer.presence, peerId: id, name: peer.name }).catch(() => undefined);
    }
    this.hooks.onStatus(`${hello.name} joined.`);
    this.publish();
    void link.closed.then(() => this.drop(link.remoteId, link));
  }

  private drop(id: string, link: LiveLink): void {
    const peer = this.peers.get(id);
    if (!peer || peer.link !== link) return;
    this.peers.delete(id);
    this.publish();
    void this.relay(id, { type: "presence", peerId: id, name: peer.name, elementIds: [] });
  }

  private async onFrame(link: LiveLink, frame: ControlFrame): Promise<void> {
    const peer = this.peers.get(link.remoteId);
    if (!peer || peer.link !== link) return;
    if (frame.type === "edit") return this.acceptEdit(link, frame);
    if (frame.type === "presence") return this.takePresence(peer, frame);
    if (frame.type === "assetRequest") return this.serveAsset(link, frame);
    if (frame.type === "assetUpload") {
      const transfer = peer.transfers.get(frame.requestId) ?? { name: frame.name, mime: frame.mime, size: frame.size, sha256: frame.sha256 };
      transfer.name = frame.name;
      transfer.mime = frame.mime;
      transfer.size = frame.size;
      transfer.sha256 = frame.sha256;
      peer.transfers.set(frame.requestId, transfer);
      if (transfer.bytes) await this.finishUpload(link, peer, frame.requestId);
      return;
    }
    if (frame.type === "embedMedia") {
      await this.hooks.embedMedia(frame.elementIds);
      return;
    }
    if (frame.type === "save") {
      try {
        await this.hooks.save();
        await link.send({ type: "saved", ok: true });
      } catch (error) {
        await link.send({ type: "saved", ok: false, message: error instanceof Error ? error.message : "Could not save." });
      }
    }
  }

  private async acceptEdit(link: LiveLink, edit: LiveEdit): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      this.sequencer.remember(this.hooks.getText());
      const decision = this.sequencer.decide(edit);
      if (decision.kind === "rebase") {
        await link.send({ type: "rebase", requestId: edit.requestId, revision: decision.revision, text: decision.text });
        return;
      }
      if (decision.kind === "rejected") {
        await link.send({ type: "rejected", requestId: edit.requestId, reason: decision.reason, message: decision.message, revision: decision.revision, text: decision.text });
        return;
      }
      const current = this.hooks.getText();
      const base = this.hooks.revisionOf(current);
      if (base !== this.sequencer.current().revision) continue;
      this.applying = true;
      let applied = false;
      try {
        applied = await this.hooks.applyText(decision.text, base);
        if (applied) this.sequencer.remember(this.hooks.getText());
      } finally {
        this.applying = false;
      }
      if (!applied) continue;
      this.broadcastNow();
      return;
    }
    const current = this.sequencer.current();
    await link.send({ type: "rejected", requestId: edit.requestId, reason: "conflict", message: "The host could not apply the edit.", revision: current.revision, text: current.text });
  }

  private takePresence(peer: Peer, frame: Extract<ControlFrame, { type: "presence" }>): void {
    const now = Date.now();
    peer.presenceMarks = peer.presenceMarks.filter((mark) => now - mark < 1000);
    if (peer.presenceMarks.length >= LIVE_LIMITS.maxPresencePerSecond) return;
    peer.presenceMarks.push(now);
    peer.seenAt = now;
    peer.presence = frame;
    void this.relay(peer.link.remoteId, { ...frame, peerId: peer.link.remoteId, name: peer.name });
    this.publish();
  }

  private async relay(originId: string, frame: Extract<ControlFrame, { type: "presence" }>): Promise<void> {
    await Promise.all([...this.peers.entries()].filter(([id]) => id !== originId).map(([, peer]) => peer.link.send(frame).catch(() => undefined)));
  }

  private async serveAsset(link: LiveLink, frame: Extract<ControlFrame, { type: "assetRequest" }>): Promise<void> {
    if (!this.hooks.allowAsset(frame.reference, frame.storage)) {
      await link.send({ type: "assetMissing", requestId: frame.requestId, message: "That media is not part of the shared deck." });
      return;
    }
    const bytes = await this.hooks.readAsset(frame.reference, frame.storage);
    if (!bytes || bytes.byteLength > LIVE_LIMITS.maxAssetBytes) {
      await link.send({ type: "assetMissing", requestId: frame.requestId, message: "The media file is unavailable." });
      return;
    }
    const hash = sha256(bytes);
    await link.send({ type: "assetOffer", requestId: frame.requestId, reference: frame.reference, storage: frame.storage, size: bytes.byteLength, sha256: hash });
    await link.sendAsset(frame.requestId, bytes, hash);
  }

  private async onAsset(link: LiveLink, asset: { requestId: string; bytes: Uint8Array; sha256: string }): Promise<void> {
    const peer = this.peers.get(link.remoteId);
    if (!peer) return;
    const transfer = peer.transfers.get(asset.requestId) ?? { name: "upload", mime: "", size: asset.bytes.byteLength, sha256: asset.sha256 };
    transfer.bytes = asset.bytes;
    peer.transfers.set(asset.requestId, transfer);
    await this.finishUpload(link, peer, asset.requestId);
  }

  private async finishUpload(link: LiveLink, peer: Peer, requestId: string): Promise<void> {
    const upload = peer.transfers.get(requestId);
    if (!upload?.bytes || upload.name === "upload") return;
    if (upload.bytes.byteLength !== upload.size || sha256(upload.bytes) !== upload.sha256) {
      peer.transfers.delete(requestId);
      await link.send({ type: "assetRejected", requestId, message: "The uploaded media did not match its checksum." }).catch(() => undefined);
      return;
    }
    peer.transfers.delete(requestId);
    try {
      const reference = await this.hooks.storeAsset(upload.bytes, upload.name, upload.mime);
      await link.send({ type: "assetStored", requestId, reference, storage: "embedded" });
    } catch (error) {
      await link.send({ type: "assetRejected", requestId, message: error instanceof Error ? error.message : "Could not store media." }).catch(() => undefined);
    }
  }

  private scheduleBroadcast(): void {
    if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
    this.broadcastTimer = setTimeout(() => this.broadcastNow(), LIVE_LIMITS.stateDebounceMs);
  }

  private broadcastNow(): void {
    const text = this.hooks.getText();
    const parsed = parseDeckText(text);
    const revision = this.hooks.revisionOf(text);
    const frame: ControlFrame = parsed.ok
      ? { type: "state", revision, text }
      : { type: "invalid", message: parsed.message };
    for (const peer of this.peers.values()) void peer.link.send(frame).catch(() => undefined);
  }

  private expirePresence(): void {
    const now = Date.now();
    let changed = false;
    for (const peer of this.peers.values()) {
      if (peer.presence?.editingElementId && now - peer.seenAt > LIVE_LIMITS.editingLockMs) {
        peer.presence = { ...peer.presence, editingElementId: undefined };
        changed = true;
      }
    }
    if (changed) this.publish();
  }

  private publish(): void {
    const peers: LivePeer[] = [...this.peers.entries()].map(([id, peer]) => ({
      id,
      name: peer.name,
      color: colorForId(id),
      slideId: peer.presence?.slideId,
      elementIds: peer.presence?.elementIds ?? [],
      editingElementId: peer.presence?.editingElementId,
      preview: peer.presence?.preview
    }));
    this.hooks.onPeers(peers);
  }
}
