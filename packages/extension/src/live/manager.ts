import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { parseDeckText, type HostToWebviewMessage, type LivePeer } from "@slidepix/core";
import { resolveMediaPath } from "@slidepix/core/assets";
import { replaceDocument, SlidePixEditorProvider, storeEmbeddedBytes, VIEW_TYPE } from "../editor";
import { revisionForText } from "../document-revision";
import { copyDeckSnapshot, deckRelativePath, mirrorPaths, missingMedia, referencedMedia, removeStaleMirrors, writeMirroredBytes } from "./asset-mirror";
import type { LiveDeckHost } from "./bridge";
import { colorForId } from "./color";
import { GuestSession } from "./guest-session";
import { HostSession } from "./host-session";
import { decodeInvite, encodeInvite, encodeJoinUri, fingerprint } from "./invite";
import { LIVE_LIMITS } from "./limits";
import { LiveFileSystemProvider, liveDocumentUri } from "./live-fs";
import { openLiveEndpoint, type LiveEndpoint, type RelayConfig } from "./transport";

type HostBinding = {
  document: vscode.TextDocument;
  session: HostSession;
  endpoint: LiveEndpoint;
  invite: string;
  peers: LivePeer[];
};

type GuestBinding = {
  uri: vscode.Uri;
  session: GuestSession;
  endpoint: LiveEndpoint;
  ticket: string;
  secret: Buffer;
  peers: LivePeer[];
  self?: LivePeer;
  hostName: string;
  status: "joined" | "reconnecting" | "ended";
  canEdit: boolean;
  deckPath?: string;
  linkedRoots: string[];
  stopping: boolean;
  reconnecting: boolean;
};

export class LiveCollaboration implements LiveDeckHost {
  readonly files = new LiveFileSystemProvider();
  private readonly hosts = new Map<string, HostBinding>();
  private readonly guests = new Map<string, GuestBinding>();
  private readonly statusBar: vscode.StatusBarItem;
  private warnedEmbed = false;

  constructor(private readonly context: vscode.ExtensionContext, private readonly editor: SlidePixEditorProvider) {
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
    this.statusBar.command = "slidepix.copyLiveInvite";
    this.statusBar.tooltip = "SlidePix live collaboration";
  }

  register(): vscode.Disposable {
    const root = path.join(this.context.globalStorageUri.fsPath, "live");
    void removeStaleMirrors(root).catch(() => undefined);
    return vscode.Disposable.from(
      vscode.workspace.registerFileSystemProvider("slidepix-live", this.files, { isCaseSensitive: true }),
      vscode.window.registerUriHandler({ handleUri: (uri) => { void this.join(uri.query ? new URLSearchParams(uri.query).get("invite") ?? undefined : undefined); } }),
      this.statusBar,
      { dispose: () => { void this.stop(); } }
    );
  }

  locate(document: vscode.TextDocument): { deckPath: string; linkedRoots: string[] } | undefined {
    const guest = this.guests.get(document.uri.authority);
    if (document.uri.scheme === "slidepix-live" && guest?.deckPath) return { deckPath: guest.deckPath, linkedRoots: guest.linkedRoots };
    return undefined;
  }

  isGuest(document: vscode.TextDocument): boolean {
    return document.uri.scheme === "slidepix-live" && this.guests.has(document.uri.authority);
  }

  canUseManim(document: vscode.TextDocument): boolean {
    return !this.isGuest(document);
  }

  async start(document: vscode.TextDocument): Promise<void> {
    if (document.uri.scheme !== "file" || document.isUntitled) {
      void vscode.window.showWarningMessage("Save the deck as a file before sharing it.");
      return;
    }
    const existing = this.hosts.get(document.uri.toString());
    if (existing) return this.copyInvite(document);
    const relay = relayConfig();
    let endpoint: LiveEndpoint;
    try {
      endpoint = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Connecting to the SlidePix network…" }, () => openLiveEndpoint(relay));
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : "Live collaboration is not available on this platform.");
      return;
    }
    if (!endpoint.online) {
      void vscode.window.showWarningMessage("SlidePix is not connected to a relay. Only people on this network may be able to join.");
    }
    const secret = randomBytes(32);
    const invite = encodeInvite(endpoint.ticket, secret);
    const roots = workspaceRoots(document);
    const binding: HostBinding = {
      document,
      endpoint,
      invite,
      peers: [],
      session: undefined as unknown as HostSession
    };
    binding.session = new HostSession({
      displayName: displayName(),
      deckName: path.basename(document.uri.fsPath),
      relativePath: deckRelativePath(document.uri.fsPath, roots),
      secret,
      requireApproval: vscode.workspace.getConfiguration("slidepix").get<boolean>("live.requireApproval", true) ?? true,
      endpointId: endpoint.id,
      getText: () => document.getText(),
      applyText: (text, base) => replaceDocument(document, text, base),
      approve: (name, id) => this.approve(name, id, path.basename(document.uri.fsPath)),
      storeAsset: (bytes, name, mime) => storeEmbeddedBytes(document.uri.fsPath, bytes, name, mime),
      readAsset: (reference, storage) => this.readHostAsset(document.uri.fsPath, roots, reference, storage),
      allowAsset: (reference, storage) => this.assetIsReferenced(binding, reference, storage),
      embedMedia: (elementIds) => this.editor.embedLinkedMedia(document, elementIds),
      save: async () => { await document.save(); },
      revisionOf: revisionForText,
      onPeers: (peers) => { binding.peers = peers; this.announce(document); this.refreshStatus(); },
      onStatus: (message) => this.editor.log(message)
    });
    binding.session.listen(endpoint);
    this.hosts.set(document.uri.toString(), binding);
    await vscode.env.clipboard.writeText(invite);
    this.announce(document);
    this.refreshStatus();
    const action = await vscode.window.showInformationMessage(`Invitation copied. Fingerprint ${fingerprint(endpoint.id)}.`, "Copy again", "Stop");
    if (action === "Copy again") await this.copyInvite(document);
    if (action === "Stop") await this.stop(document);
  }

  async join(inviteText?: string): Promise<void> {
    let clipboard = "";
    try { clipboard = await vscode.env.clipboard.readText(); } catch { clipboard = ""; }
    const seeded = inviteText ?? (decodeInvite(clipboard) ? clipboard.trim() : "");
    const entered = inviteText ? seeded : await vscode.window.showInputBox({ title: "Join SlidePix live collaboration", prompt: "Paste a SlidePix live invitation", value: seeded, ignoreFocusOut: true });
    if (!entered) return;
    const invite = decodeInvite(entered);
    if (!invite) {
      void vscode.window.showErrorMessage("That SlidePix invitation is not valid.");
      return;
    }
    const relay = relayConfig();
    let endpoint: LiveEndpoint;
    try {
      endpoint = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Joining the SlidePix session…" }, () => openLiveEndpoint(relay));
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : "Live collaboration is not available on this platform.");
      return;
    }
    const sessionId = randomUUID();
    const binding: GuestBinding = {
      uri: liveDocumentUri(sessionId, "deck.slidepix.json"),
      session: undefined as unknown as GuestSession,
      endpoint,
      ticket: invite.ticket,
      secret: invite.secret,
      peers: [],
      hostName: "Host",
      status: "joined",
      canEdit: true,
      linkedRoots: [],
      stopping: false,
      reconnecting: false
    };
    binding.session = new GuestSession({
      displayName: displayName(),
      secret: invite.secret,
      revisionOf: revisionForText,
      requestId: () => randomUUID(),
      getText: () => this.guestDocument(binding)?.getText() ?? "",
      applyText: async (text, base) => {
        const document = this.guestDocument(binding);
        if (!document) return false;
        const applied = await replaceDocument(document, text, base);
        if (applied) await document.save();
        return applied;
      },
      prepareMirror: (relativePath, text) => this.prepareMirror(binding, sessionId, relativePath, text),
      writeAsset: async (reference, storage, bytes, hash) => {
        if (!binding.deckPath) throw new Error("The shared deck is not ready.");
        await writeMirroredBytes(binding.deckPath, { reference, storage }, bytes, binding.linkedRoots, hash);
      },
      onPeers: (peers, self, hostName) => {
        binding.peers = peers;
        binding.self = self;
        binding.hostName = hostName;
        const document = this.guestDocument(binding);
        if (document) this.announce(document);
        this.refreshStatus();
      },
      onAssets: (references) => {
        const document = this.guestDocument(binding);
        if (document) this.editor.postTo(document, { version: 2, type: "assetsUpdated", references });
      },
      onError: (message) => void vscode.window.showErrorMessage(`SlidePix live: ${message}`),
      onDisconnected: () => { void this.reconnect(binding); },
      onEnded: (message) => {
        binding.status = "ended";
        binding.canEdit = false;
        const document = this.guestDocument(binding);
        if (document) this.announce(document);
        void vscode.window.showWarningMessage(`${message} You can save a copy of the deck.`, "Save a copy").then((choice) => {
          if (choice && document) void this.saveCopy(document);
        });
      },
      canEdit: (value) => { binding.canEdit = value; }
    });
    this.guests.set(sessionId, binding);
    try {
      const link = await endpoint.connect(invite.ticket);
      binding.session.attach(link, endpoint.id);
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : "Could not join the live session.");
      await endpoint.close().catch(() => undefined);
      this.guests.delete(sessionId);
    }
  }

  async copyInvite(document: vscode.TextDocument): Promise<void> {
    const host = this.hosts.get(document.uri.toString());
    const guest = this.guests.get(document.uri.authority);
    const invite = host?.invite;
    if (!invite) {
      if (guest) void vscode.window.showInformationMessage("Ask the host to copy the invitation.");
      else void vscode.window.showInformationMessage("Start a live session before copying an invitation.");
      return;
    }
    await vscode.env.clipboard.writeText(invite);
    void vscode.window.showInformationMessage("SlidePix invitation copied.");
  }

  async stop(document?: vscode.TextDocument): Promise<void> {
    if (!document) {
      await Promise.all([...this.hosts.keys()].map((key) => this.stopHost(key)));
      await Promise.all([...this.guests.values()].map((guest) => this.stopGuest(guest)));
      return;
    }
    if (this.hosts.has(document.uri.toString())) await this.stopHost(document.uri.toString());
    const guest = this.guests.get(document.uri.authority);
    if (guest) await this.stopGuest(guest);
  }

  async saveCopy(document: vscode.TextDocument): Promise<void> {
    const guest = this.guests.get(document.uri.authority);
    if (!guest?.deckPath) return;
    const folder = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: "Save a copy" });
    if (!folder?.[0]) return;
    await copyDeckSnapshot(guest.deckPath, folder[0].fsPath, guest.linkedRoots);
    void vscode.window.showInformationMessage(`Saved a copy in ${folder[0].fsPath}.`);
  }

  async saveOnHost(document: vscode.TextDocument): Promise<void> {
    const guest = this.guests.get(document.uri.authority);
    if (!guest) return void document.save();
    await guest.session.saveHost();
    await document.save();
  }

  async importAsset(document: vscode.TextDocument, bytes: Uint8Array, name: string, mime: string): Promise<{ reference: string; storage: "embedded" } | { error: string }> {
    const guest = this.guests.get(document.uri.authority);
    if (!guest?.deckPath) return { error: "The shared deck is not ready." };
    try {
      if (!this.warnedEmbed) {
        this.warnedEmbed = true;
        void vscode.window.showInformationMessage("During a live session, media is embedded in the host deck.");
      }
      const reference = await guest.session.uploadAsset(bytes, name, mime);
      await writeMirroredBytes(guest.deckPath, { reference, storage: "embedded" }, bytes, guest.linkedRoots);
      this.editor.postTo(document, { version: 2, type: "assetsUpdated", references: [reference] });
      return { reference, storage: "embedded" };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "Could not upload media." };
    }
  }

  async embedOnHost(document: vscode.TextDocument, elementIds?: string[]): Promise<boolean> {
    const guest = this.guests.get(document.uri.authority);
    if (!guest) return false;
    await guest.session.embedMedia(elementIds);
    return true;
  }

  presence(document: vscode.TextDocument, presence: { slideId?: string; elementIds: string[]; editingElementId?: string; preview?: { slideId: string; poses: { id: string; x: number; y: number; width: number; height: number; rotation: number }[] } }): void {
    const frame = { type: "presence" as const, slideId: presence.slideId, elementIds: presence.elementIds, editingElementId: presence.editingElementId, preview: presence.preview, name: displayName() };
    const host = this.hosts.get(document.uri.toString());
    if (host) host.session.setLocalPresence(frame);
    this.guests.get(document.uri.authority)?.session.setPresence(frame);
  }

  async ensureAssets(document: vscode.TextDocument): Promise<void> {
    const guest = this.guests.get(document.uri.authority);
    if (!guest?.deckPath) return;
    const parsed = parseDeckText(document.getText());
    if (!parsed.ok) return;
    const missing = await missingMedia(guest.deckPath, parsed.deck, guest.linkedRoots);
    if (missing.length) await guest.session.ensureAssets(missing);
  }

  announce(document: vscode.TextDocument): void {
    this.editor.postTo(document, this.collaborationMessage(document));
  }

  documentChanged(document: vscode.TextDocument): void {
    const host = this.hosts.get(document.uri.toString());
    if (host && !host.session.applying) host.session.onDocument(document.getText());
    const guest = this.guests.get(document.uri.authority);
    if (guest && !guest.session.applying) guest.session.onDocument(document.getText());
  }

  async panelClosed(document: vscode.TextDocument): Promise<void> {
    const guest = this.guests.get(document.uri.authority);
    if (guest) await guest.session.flush(LIVE_LIMITS.guestFlushMs);
    if (!this.hosts.has(document.uri.toString())) return;
    const remaining = vscode.window.tabGroups.all.flatMap((group) => group.tabs).some((tab) => tab.input instanceof vscode.TabInputCustom && tab.input.uri.toString() === document.uri.toString());
    if (remaining) return;
    const stop = await vscode.window.showWarningMessage(`Close the live session for ${path.basename(document.uri.fsPath)}? Guests will be disconnected.`, "Stop session", "Keep sharing");
    if (stop === "Stop session") await this.stop(document);
  }

  private async prepareMirror(binding: GuestBinding, sessionId: string, relativePath: string, text: string): Promise<{ deckPath: string; linkedRoots: string[] }> {
    if (binding.deckPath) return { deckPath: binding.deckPath, linkedRoots: binding.linkedRoots };
    const storageRoot = path.join(this.context.globalStorageUri.fsPath, "live", sessionId);
    const paths = mirrorPaths(storageRoot, relativePath);
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(path.dirname(paths.deckPath), { recursive: true });
    await writeFile(paths.deckPath, text, "utf8");
    this.files.mount(sessionId, paths.workspace);
    binding.deckPath = paths.deckPath;
    binding.linkedRoots = [paths.workspace];
    binding.session.deckPath = paths.deckPath;
    binding.session.linkedRoots = binding.linkedRoots;
    const uri = liveDocumentUri(sessionId, relativePath);
    binding.uri = uri;
    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);
    this.refreshStatus();
    return { deckPath: paths.deckPath, linkedRoots: binding.linkedRoots };
  }

  private async reconnect(binding: GuestBinding): Promise<void> {
    if (binding.stopping || binding.status === "ended" || binding.reconnecting) return;
    binding.reconnecting = true;
    binding.status = "reconnecting";
    const document = this.guestDocument(binding);
    if (document) this.announce(document);
    const started = Date.now();
    let delay = 1000;
    while (!binding.stopping && binding.status === "reconnecting" && Date.now() - started < LIVE_LIMITS.reconnectMaxMs) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      try {
        const link = await binding.endpoint.connect(binding.ticket);
        binding.status = "joined";
        binding.reconnecting = false;
        binding.session.attach(link, binding.endpoint.id);
        return;
      } catch {
        delay = Math.min(30_000, delay * 2);
      }
    }
    binding.reconnecting = false;
    if (!binding.stopping && binding.status === "reconnecting") {
      binding.status = "ended";
      binding.canEdit = false;
      if (document) this.announce(document);
    }
  }

  private collaborationMessage(document: vscode.TextDocument): HostToWebviewMessage {
    const host = this.hosts.get(document.uri.toString());
    if (host) {
      return {
        version: 2,
        type: "collaboration",
        status: "hosting",
        role: "host",
        canEdit: true,
        hostName: displayName(),
        self: { id: host.endpoint.id, name: displayName(), color: colorForId(host.endpoint.id), elementIds: [] },
        peers: host.peers
      };
    }
    const guest = this.guests.get(document.uri.authority);
    if (guest) {
      return {
        version: 2,
        type: "collaboration",
        status: guest.status,
        role: "guest",
        canEdit: guest.canEdit,
        hostName: guest.hostName,
        self: guest.self,
        peers: guest.peers
      };
    }
    return { version: 2, type: "collaboration", status: "off", role: "none", canEdit: true, peers: [] };
  }

  private async stopHost(key: string): Promise<void> {
    const host = this.hosts.get(key);
    if (!host) return;
    this.hosts.delete(key);
    await host.session.stop();
    await host.endpoint.close().catch(() => undefined);
    this.announce(host.document);
    this.refreshStatus();
  }

  private async stopGuest(guest: GuestBinding): Promise<void> {
    guest.stopping = true;
    guest.status = "ended";
    guest.canEdit = false;
    await guest.session.flush(LIVE_LIMITS.guestFlushMs);
    guest.session.close();
    await guest.endpoint.close().catch(() => undefined);
    this.guests.delete(guest.uri.authority);
    this.files.unmount(guest.uri.authority);
    const document = this.guestDocument(guest);
    if (document) this.announce(document);
    this.refreshStatus();
  }

  private guestDocument(binding: GuestBinding): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find((document) => document.uri.toString() === binding.uri.toString());
  }

  private async approve(name: string, id: string, deckName: string): Promise<boolean> {
    const choice = await Promise.race([
      vscode.window.showInformationMessage(`${name} wants to join “${deckName}” (${id}).`, { modal: true }, "Allow", "Deny"),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), LIVE_LIMITS.approvalTimeoutMs))
    ]);
    return choice === "Allow";
  }

  private assetIsReferenced(binding: HostBinding, reference: string, storage: "embedded" | "linked"): boolean {
    const texts = binding.session.sequencer.knownTexts();
    return texts.some((text) => {
      const parsed = parseDeckText(text);
      return parsed.ok && referencedMedia(parsed.deck).some((item) => item.reference === reference && item.storage === storage);
    });
  }

  private async readHostAsset(deckPath: string, roots: string[], reference: string, storage: "embedded" | "linked"): Promise<Uint8Array | undefined> {
    try {
      return await readFile(resolveMediaPath(deckPath, reference, storage, roots));
    } catch {
      return undefined;
    }
  }

  private refreshStatus(): void {
    const hostCount = [...this.hosts.values()].reduce((sum, host) => sum + host.peers.length, 0);
    const guestCount = this.guests.size;
    const total = hostCount + guestCount;
    if (!this.hosts.size && !guestCount) {
      this.statusBar.hide();
      return;
    }
    this.statusBar.text = `$(broadcast) SlidePix Live · ${Math.max(total, this.hosts.size ? hostCount : 1)}`;
    this.statusBar.show();
  }
}

function relayConfig(): RelayConfig {
  const config = vscode.workspace.getConfiguration("slidepix");
  const mode = config.get<string>("live.relayMode", "default");
  const urls = config.get<string[]>("live.relayUrls", []) ?? [];
  if (mode === "disabled") return { mode: "disabled", urls: [] };
  if (mode === "custom") return { mode: "custom", urls };
  return { mode: "default", urls: [] };
}

function displayName(): string {
  const configured = vscode.workspace.getConfiguration("slidepix").get<string>("live.displayName", "") ?? "";
  const fallback = os.userInfo().username || "Guest";
  return (configured.trim() || fallback).slice(0, 80);
}

function workspaceRoots(document: vscode.TextDocument): string[] {
  const folders = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath).filter((item) => item) ?? [];
  return folders.length ? folders : [path.dirname(document.uri.fsPath)];
}
