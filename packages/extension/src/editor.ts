import { createHash } from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import { parseDeckText, serializeDeck, type Deck, type HostToWebviewMessage, type WebviewToHostMessage } from "@slidepix/core";
import { deckAssetDirectory, resolveMediaPath } from "@slidepix/core/assets";

import { exportPptx } from "./pptx-export-command";
import { exportWeb } from "./web-export-command";
import { PresentationServer } from "./presentation";
import { presenterHtml } from "./presenter";
import { cssFontFamily, discoverSystemFontFamilies } from "./fonts";
import { revisionForText } from "./document-revision";
import type { LiveDeckHost } from "./live/bridge";
import { emptyDocumentHistory, historyFlags, recordDocumentEdit, redoDocument, undoDocument, type DocumentHistory } from "./document-history";
import type { ExportResult } from "./export-result";
import { EditorResolveRecovery } from "./editor-recovery";
import {
  applyManimRender,
  applyManimScript,
  createStarterScript,
  deleteManimScript,
  findManimElement,
  listScenesForScript,
  ManimCancelled,
  relativeDeckReference,
  runManimRender,
  takenManimOutputStems
} from "./manim-host";
import { ensureManimLaunch, promptManimSetup } from "./manim-setup";
import { assignManimBasenames, manimDeckStem, manimRenderConcurrency, mapWithConcurrency } from "./manim-render";

export const VIEW_TYPE = "slidepix.deckEditor";

export class SlidePixEditorProvider implements vscode.CustomTextEditorProvider {
  private readonly panels = new Map<string, Set<vscode.WebviewPanel>>();
  private readonly sessions = new Map<string, PresentationServer>();
  private readonly presenterPanels = new Map<string, vscode.WebviewPanel>();
  private readonly presentationReloads = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly histories = new Map<string, DocumentHistory>();
  private activeDocument?: vscode.TextDocument;
  private outputChannel?: vscode.OutputChannel;
  private manimRenderInFlight = false;
  private live?: LiveDeckHost;
  private readonly recovery = new EditorResolveRecovery<vscode.Tab>({
    isResolved: (key) => this.panels.has(key),
    hasDocument: (key) => vscode.workspace.textDocuments.some((document) => document.uri.toString() === key),
    reopen: (tab) => reopenUnsyncedEditor(tab),
    report: (error) => void vscode.window.showErrorMessage(`SlidePix could not reopen the deck: ${error instanceof Error ? error.message : String(error)}`)
  });

  constructor(private readonly context: vscode.ExtensionContext) {}

  attachLive(live: LiveDeckHost): void {
    this.live = live;
  }

  postTo(document: vscode.TextDocument, message: HostToWebviewMessage): void {
    for (const panel of this.panels.get(document.uri.toString()) ?? []) void panel.webview.postMessage(message);
  }

  embedLinkedMedia(document: vscode.TextDocument, elementIds?: string[]): Promise<void> {
    return this.embedMedia(document, elementIds);
  }

  locationOf(document: vscode.TextDocument): { deckPath: string; linkedRoots: string[] } {
    const located = this.paths(document);
    return { deckPath: located.deckPath, linkedRoots: located.roots };
  }

  showLog(): void {
    const channel = this.getOutputChannel();
    channel.show(false);
    const version = String((this.context.extension.packageJSON as { version?: string }).version ?? "unknown");
    this.log(`SlidePix ${version} activated`);
  }

  log(message: string, level: "info" | "warn" | "error" = "info"): void {
    const prefix = level === "error" ? "ERROR" : level === "warn" ? "WARN" : "INFO";
    this.getOutputChannel().appendLine(`${new Date().toISOString()} ${prefix} ${message}`);
    if (level === "error") this.getOutputChannel().show(false);
  }

  private watchTab(tab: vscode.Tab): void {
    if (!tab.isActive || !(tab.input instanceof vscode.TabInputCustom) || tab.input.viewType !== VIEW_TYPE || tab.input.uri.scheme !== "file") return;
    this.recovery.watch(tab.input.uri.toString(), tab);
  }

  register(): vscode.Disposable {
    const provider = vscode.window.registerCustomEditorProvider(VIEW_TYPE, this, { supportsMultipleEditorsPerDocument: true, webviewOptions: { retainContextWhenHidden: true } });
    const changes = vscode.workspace.onDidChangeTextDocument((event) => this.updatePanels(event.document));
    const saves = vscode.workspace.onDidSaveTextDocument((document) => this.schedulePresentationReload(document.uri.toString(), true));
    const tabs = vscode.window.tabGroups.onDidChangeTabs((event) => { for (const tab of [...event.opened, ...event.changed]) this.watchTab(tab); });
    for (const group of vscode.window.tabGroups.all) for (const tab of group.tabs) this.watchTab(tab);
    return vscode.Disposable.from(provider, changes, saves, tabs, this.recovery, { dispose: () => { for (const timer of this.presentationReloads.values()) clearTimeout(timer); for (const session of this.sessions.values()) session.dispose(); } });
  }

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    this.activeDocument = document;
    const key = document.uri.toString();
    this.recovery.resolved(key);
    const set = this.panels.get(key) ?? new Set<vscode.WebviewPanel>();
    set.add(panel);
    this.panels.set(key, set);
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
        vscode.Uri.file(deckAssetDirectory(this.paths(document).deckPath)),
        ...this.resourceRoots(document)
      ]
    };
    panel.webview.html = this.webviewHtml(panel.webview);
    this.log(`opened ${document.uri.fsPath}`);
    panel.onDidChangeViewState(() => { if (panel.active) this.activeDocument = document; });
    panel.onDidDispose(() => {
      set.delete(panel);
      if (!set.size) {
        this.panels.delete(key);
        this.histories.delete(key);
        this.log(`closed ${document.uri.toString()}`);
        void this.live?.panelClosed(document);
      }
    });
    panel.webview.onDidReceiveMessage((message: WebviewToHostMessage) => {
      void this.receive(document, panel, message).catch((error: unknown) => {
        const text = error instanceof Error ? error.message : String(error);
        this.log(`webview message failed: ${text}`, "error");
        void vscode.window.showErrorMessage(`SlidePix: ${text}`);
      });
    });
  }

  currentDocument(): vscode.TextDocument | undefined { return this.activeDocument; }

  async present(document: vscode.TextDocument, presenter = false): Promise<void> {
    this.log(presenter ? "command presenter" : "command present");
    const parsed = parseDeckText(document.getText());
    if (!parsed.ok) {
      this.log(parsed.message, "error");
      return void vscode.window.showErrorMessage(parsed.message);
    }
    const key = document.uri.toString();
    const running = this.sessions.get(key);
    if (running?.isRunning()) {
      running.replaceDeck(parsed.deck);
      this.log("presentation hot reload");
      if (presenter) this.attachPresenter(key, running, parsed.deck);
      if (!running.hasAudience()) await vscode.env.openExternal(vscode.Uri.parse(running.url("/audience")));
      return;
    }
    running?.dispose();
    const located = this.paths(document);
    await this.live?.ensureAssets(document);
    const session = new PresentationServer(parsed.deck, located.deckPath, (index) => {
      this.presenterPanels.get(key)?.webview.postMessage({ type: "state", index });
    }, located.roots, () => this.deckForPresentation(key, located.deckPath));
    await session.start();
    this.sessions.set(key, session);
    if (presenter) this.attachPresenter(key, session, parsed.deck);
    await vscode.env.openExternal(vscode.Uri.parse(session.url("/audience")));
  }

  private attachPresenter(key: string, session: PresentationServer, deck: Deck): vscode.WebviewPanel {
    const current = this.presenterPanels.get(key);
    if (current) {
      current.webview.html = presenterHtml(session, deck);
      return current;
    }
    const presenterPanel = vscode.window.createWebviewPanel("slidepix.presenter", "SlidePix Presenter", vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
    this.presenterPanels.set(key, presenterPanel);
    presenterPanel.webview.html = presenterHtml(session, deck);
    presenterPanel.webview.onDidReceiveMessage((message: { command?: "next" | "previous" | "first" | "last" }) => {
      if (message.command === "next" || message.command === "previous") session.control(message.command);
      else if (message.command) session.command(message.command);
    });
    presenterPanel.onDidDispose(() => { if (this.presenterPanels.get(key) === presenterPanel) this.presenterPanels.delete(key); });
    return presenterPanel;
  }

  private updatePanels(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    const session = this.sessions.get(key);
    if (session?.isRunning()) {
      const parsed = parseDeckText(document.getText());
      if (parsed.ok) session.deck = parsed.deck;
      this.schedulePresentationReload(key);
    }
    this.live?.documentChanged(document);
    const set = this.panels.get(key);
    if (!set) return;
    for (const panel of set) this.postDeck(document, panel);
  }

  private schedulePresentationReload(key: string, immediate = false): void {
    const session = this.sessions.get(key);
    if (!session?.isRunning()) return;
    const pending = this.presentationReloads.get(key);
    if (pending) clearTimeout(pending);
    const reload = () => {
      this.presentationReloads.delete(key);
      if (session.isRunning()) session.reloadAudience();
    };
    if (immediate) reload();
    else this.presentationReloads.set(key, setTimeout(reload, 400));
  }

  private async deckForPresentation(key: string, deckPath: string): Promise<Deck | undefined> {
    const open = vscode.workspace.textDocuments.find((item) => item.uri.toString() === key);
    const buffer = open ? parseDeckText(open.getText()) : undefined;
    let saved: Deck | undefined;
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(deckPath));
      const parsed = parseDeckText(Buffer.from(bytes).toString("utf8"));
      if (parsed.ok) saved = parsed.deck;
    } catch { /* the deck may not be on disk yet */ }
    if (open?.isDirty && buffer?.ok) return buffer.deck;
    return saved ?? (buffer?.ok ? buffer.deck : undefined);
  }

  private postDeck(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    const text = document.getText();
    const parsed = parseDeckText(text);
    const revision = revisionForText(text);
    const located = this.paths(document);
    const assetUri = panel.webview.asWebviewUri(vscode.Uri.file(deckAssetDirectory(located.deckPath))).toString();
    const linkedUri = panel.webview.asWebviewUri(vscode.Uri.file(path.dirname(located.deckPath))).toString();
    const flags = this.historyState(document.uri);
    const message: HostToWebviewMessage = parsed.ok
      ? { version: 2, type: "deck", text, deck: parsed.deck, revision, uri: assetUri, linkedUri, ...flags }
      : { version: 2, type: "invalidDeck", text, revision, message: parsed.message, gitConflict: hasGitConflictMarkers(text), uri: assetUri, linkedUri };
    void panel.webview.postMessage(message);
  }

  private async receive(document: vscode.TextDocument, panel: vscode.WebviewPanel, message: WebviewToHostMessage): Promise<void> {
    if (!message || message.version !== 2) {
      this.log(`rejected webview message version ${message && "version" in message ? String(message.version) : "missing"}`, "error");
      panel.webview.html = this.webviewHtml(panel.webview);
      return;
    }
    if (message.type !== "replaceDocument") {
      const detail = message.type === "command" ? `command ${message.command}` : message.type;
      this.log(`<- ${detail}`);
    }
    if (message.type === "ready") {
      this.postDeck(document, panel);
      this.live?.announce(document);
      return;
    }
    if (message.type === "replaceDocument") {
      const currentText = document.getText();
      const currentRevision = revisionForText(currentText);
      if (message.baseRevision !== currentRevision) {
        await panel.webview.postMessage(editResult(message.requestId, false, currentText, "stale", "The deck changed before this edit could be applied.", this.historyState(document.uri)));
        return;
      }
      const incoming = parseDeckText(message.text);
      if (!incoming.ok) {
        await panel.webview.postMessage(editResult(message.requestId, false, currentText, "invalid", incoming.message, this.historyState(document.uri)));
        return;
      }
      const applied = await replaceDocument(document, message.text, currentRevision);
      const nextText = document.getText();
      if (applied) this.recordHistory(document.uri, currentText, nextText);
      else this.log("replaceDocument rejected: VS Code did not apply the edit", "warn");
      await panel.webview.postMessage(editResult(message.requestId, applied, nextText, applied ? undefined : "applyFailed", applied ? undefined : "VS Code rejected the document edit.", this.historyState(document.uri)));
      return;
    }
    if (message.type === "history") {
      await this.applyHistory(document, panel, message.command, message.requestId);
      return;
    }
    if (message.type === "presence") return this.live?.presence(document, message);
    if (message.type === "importAsset") {
      if (this.live?.isGuest(document)) return this.importGuestAsset(document, panel, message);
      return this.importAsset(document, panel, message);
    }
    if (message.type === "selectMedia") return this.selectMedia(document, panel, message);
    if (message.type === "linkMedia") return this.resolveMedia(document, panel, message, vscode.Uri.parse(message.uri));
    if (message.type === "embedMedia") {
      if (await this.live?.embedOnHost(document, message.elementIds)) return;
      return this.embedMedia(document, message.elementIds);
    }
    if (message.type === "selectFont") return this.selectFont(panel, message);
    if (message.type === "selectManimScript") return this.selectManimScript(document, panel, message);
    if (message.type === "createManimScript") return this.createManimScript(document, panel, message);
    if (message.type === "openManimScript") return this.openManimScript(document, message);
    if (message.type === "listManimScenes") return this.listManimScenes(document, panel, message);
    if (message.type === "renderManim") return this.renderManim(document, panel, message);
    if (message.type === "renderAllManim") return this.renderAllManim(document, panel, message);
    if (message.type === "setupManim") return this.setupManim(document, panel);
    if (message.type === "command") {
      if (message.command === "undo" || message.command === "redo") return this.applyHistory(document, panel, message.command);
      if (message.command === "save") return this.live?.isGuest(document) ? this.live.saveOnHost(document) : void document.save();
      if (message.command === "startLive") return this.live?.start(document);
      if (message.command === "copyLiveInvite") return this.live?.copyInvite(document);
      if (message.command === "stopLive") return this.live?.stop(document);
      if (message.command === "saveLiveCopy") return this.live?.saveCopy(document);
      if (message.command === "configureMcp") return void vscode.commands.executeCommand("slidepix.configureMcp");
      if (message.command === "resolveGitConflict") return void vscode.commands.executeCommand("slidepix.resolveGitConflict");
      if (message.command === "openTextEditor") return void vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside });
      const parsed = parseDeckText(document.getText());
      if (!parsed.ok) return void vscode.window.showErrorMessage(parsed.message);
      if (message.command === "exportPptx" || message.command === "exportWeb") await this.live?.ensureAssets(document);
      const located = this.paths(document);
      if (message.command === "exportPptx") return this.runExport(panel, message.requestId, "PowerPoint export", () => exportPptx(this.context, parsed.deck, located.deckPath));
      if (message.command === "exportWeb") return this.runExport(panel, message.requestId, "Web export", () => exportWeb(parsed.deck, located.deckPath));
      if (message.command === "present") return this.present(document, false);
      if (message.command === "presenter") return this.present(document, true);
    }
    if (message.type === "saveExport") {
      const destination = await vscode.window.showSaveDialog({
        filters: message.format === "pdf" ? { PDF: ["pdf"] } : { PNG: ["png"] },
        defaultUri: vscode.Uri.file(this.paths(document).deckPath.replace(/\.slidepix\.json$/i, message.format === "pdf" ? ".pdf" : ".png"))
      });
      if (destination) {
        const bytes = Buffer.from(message.data.replace(/^data:[^;]+;base64,/, ""), "base64");
        await vscode.workspace.fs.writeFile(destination, bytes);
        void vscode.window.showInformationMessage(`Exported ${message.format.toUpperCase()}`);
      }
      return;
    }
    if (message.type === "log") {
      const channel = this.getOutputChannel();
      const ts = new Date().toISOString();
      const prefix = message.level === "error" ? "[ERROR]" : message.level === "warn" ? "[WARN] " : "[INFO] ";
      channel.appendLine(`${ts} ${prefix} ${message.message}`);
      if (message.level === "error") channel.show(true);
      return;
    }
  }

  private getOutputChannel(): vscode.OutputChannel {
    if (!this.outputChannel) {
      this.outputChannel = vscode.window.createOutputChannel("SlidePix", { log: true });
      this.context.subscriptions.push(this.outputChannel);
    }
    return this.outputChannel;
  }

  private async runExport(panel: vscode.WebviewPanel, requestId: string | undefined, label: string, exportAction: () => Promise<ExportResult>): Promise<void> {
    try {
      const result = await exportAction();
      if (!requestId) return;
      await panel.webview.postMessage({
        version: 2,
        type: "notify",
        notificationId: requestId,
        status: result.status === "cancelled" ? "dismiss" : result.status,
        message: result.status === "cancelled" ? undefined : result.message
      } satisfies HostToWebviewMessage);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (requestId) {
        await panel.webview.postMessage({ version: 2, type: "notify", notificationId: requestId, status: "error", message: `${label} failed: ${detail}` } satisfies HostToWebviewMessage);
        return;
      }
      throw error;
    }
  }

  private async applyHistory(document: vscode.TextDocument, panel: vscode.WebviewPanel, command: "undo" | "redo", requestId?: string): Promise<void> {
    const currentText = document.getText();
    const step = command === "undo"
      ? undoDocument(this.historyFor(document.uri), currentText)
      : redoDocument(this.historyFor(document.uri), currentText);
    let error: string | undefined;
    if (step && "error" in step) error = step.error;
    else if (step) {
      const previous = this.historyFor(document.uri);
      this.setHistory(document.uri, step.history);
      const applied = await replaceDocument(document, step.text, revisionForText(currentText));
      if (!applied) {
        this.setHistory(document.uri, previous);
        error = "VS Code rejected the document edit.";
      }
    }
    const text = document.getText();
    const parsed = parseDeckText(text);
    const flags = this.historyState(document.uri);
    if (!requestId) return;
    await panel.webview.postMessage({
      version: 2,
      type: "historyResult",
      requestId,
      command,
      ok: !error && parsed.ok,
      revision: revisionForText(text),
      text,
      deck: parsed.ok ? parsed.deck : undefined,
      error: error ?? (parsed.ok ? undefined : parsed.message),
      ...flags
    } satisfies HostToWebviewMessage);
  }

  private historyFor(uri: vscode.Uri): DocumentHistory {
    return this.histories.get(uri.toString()) ?? emptyDocumentHistory();
  }

  private setHistory(uri: vscode.Uri, history: DocumentHistory): void {
    this.histories.set(uri.toString(), history);
  }

  private recordHistory(uri: vscode.Uri, previousText: string, nextText: string): void {
    this.setHistory(uri, recordDocumentEdit(this.historyFor(uri), previousText, nextText));
  }

  private historyState(uri: vscode.Uri): { canUndo: boolean; canRedo: boolean } {
    return historyFlags(this.historyFor(uri));
  }

  private paths(document: vscode.TextDocument): { deckPath: string; roots: string[] } {
    const located = this.live?.locate(document);
    if (located) return { deckPath: located.deckPath, roots: located.linkedRoots };
    return { deckPath: document.uri.fsPath, roots: linkedRoots(document) };
  }

  private resourceRoots(document: vscode.TextDocument): vscode.Uri[] {
    const located = this.live?.locate(document);
    if (located) {
      const media = located.linkedRoots[0] ?? path.dirname(located.deckPath);
      return [vscode.Uri.file(path.dirname(located.deckPath)), vscode.Uri.file(media)];
    }
    return workspaceRootUris(document);
  }

  private async importGuestAsset(document: vscode.TextDocument, panel: vscode.WebviewPanel, message: Extract<WebviewToHostMessage, { type: "importAsset" }>): Promise<void> {
    const response: HostToWebviewMessage = { version: 2, type: "assetImported", requestId: message.requestId };
    const bytes = Buffer.from(message.base64, "base64");
    const stored = await this.live?.importAsset(document, bytes, message.name, message.mime);
    if (stored && "reference" in stored) {
      response.reference = stored.reference;
      response.storage = stored.storage;
    } else response.error = stored?.error ?? "Could not upload media.";
    await panel.webview.postMessage(response);
  }

  private async selectFont(panel: vscode.WebviewPanel, message: Extract<WebviewToHostMessage, { type: "selectFont" }>): Promise<void> {
    const response: HostToWebviewMessage = { version: 2, type: "fontSelected", requestId: message.requestId };
    try {
      const families = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Finding system fonts…" }, discoverSystemFontFamilies);
      const items = families.map((family) => ({ label: family, description: cssFontFamily(family), family: cssFontFamily(family) }));
      const picked = await vscode.window.showQuickPick(items, {
        title: "SlidePix system font",
        placeHolder: "Type to filter fonts installed on this computer",
        matchOnDescription: true
      });
      response.family = picked?.family;
    } catch (error) {
      response.error = error instanceof Error ? error.message : "Could not discover system fonts";
    }
    await panel.webview.postMessage(response);
  }

  private async importAsset(document: vscode.TextDocument, panel: vscode.WebviewPanel, message: Extract<WebviewToHostMessage, { type: "importAsset" }>): Promise<void> {
    const response: HostToWebviewMessage = { version: 2, type: "assetImported", requestId: message.requestId };
    try {
      const bytes = Buffer.from(message.base64, "base64");
      if (bytes.byteLength > 100 * 1024 * 1024) throw new Error("Media files are limited to 100 MB per import.");
      response.reference = await storeEmbeddedBytes(this.paths(document).deckPath, bytes, message.name, message.mime);
      response.storage = "embedded";
    } catch (error) {
      response.error = error instanceof Error ? error.message : "Could not import asset";
    }
    await panel.webview.postMessage(response);
  }

  private async selectMedia(document: vscode.TextDocument, panel: vscode.WebviewPanel, message: Extract<WebviewToHostMessage, { type: "selectMedia" }>): Promise<void> {
    const filters: Record<string, string[]> = message.kind === "image"
      ? { Images: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"] }
      : { Videos: ["mp4", "webm", "mov", "m4v", "ogv"] };
    const picked = await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFiles: true, canSelectFolders: false, filters, defaultUri: workspaceRootUris(document)[0] });
    if (!picked?.[0]) return void panel.webview.postMessage({ version: 2, type: "assetImported", requestId: message.requestId } satisfies HostToWebviewMessage);
    await this.resolveMedia(document, panel, message, picked[0]);
  }

  private async resolveMedia(document: vscode.TextDocument, panel: vscode.WebviewPanel, message: Extract<WebviewToHostMessage, { type: "selectMedia" | "linkMedia" }>, uri: vscode.Uri): Promise<void> {
    const response: HostToWebviewMessage = { version: 2, type: "assetImported", requestId: message.requestId };
    try {
      if (uri.scheme !== "file") throw new Error("Only local workspace files can be linked.");
      const kind = mediaKind(uri.fsPath);
      if (kind !== message.kind) throw new Error(`Choose a supported ${message.kind} file.`);
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > 100 * 1024 * 1024) throw new Error("Media files are limited to 100 MB.");
      if (this.live?.isGuest(document)) {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const stored = await this.live.importAsset(document, bytes, path.basename(uri.fsPath), "");
        if ("error" in stored) throw new Error(stored.error);
        response.reference = stored.reference;
        response.storage = stored.storage;
        await panel.webview.postMessage(response);
        return;
      }
      const roots = linkedRoots(document);
      const resolved = path.resolve(uri.fsPath);
      const insideWorkspace = roots.some((root) => isInside(root, resolved));
      if (insideWorkspace) {
        response.reference = path.relative(path.dirname(document.uri.fsPath), resolved).replaceAll(path.sep, "/");
        response.storage = "linked";
      } else {
        const bytes = await vscode.workspace.fs.readFile(uri);
        response.reference = await storeEmbeddedBytes(document.uri.fsPath, bytes, path.basename(uri.fsPath), "");
        response.storage = "embedded";
        void vscode.window.showInformationMessage("The selected file is outside the open workspace, so SlidePix embedded a safe copy.");
      }
    } catch (error) {
      response.error = error instanceof Error ? error.message : "Could not add media";
    }
    await panel.webview.postMessage(response);
  }

  private manimLog(): { channel: vscode.OutputChannel; append: (text: string) => void } {
    const channel = this.getOutputChannel();
    return { channel, append: (text) => channel.append(text) };
  }

  private refuseManim(document: vscode.TextDocument): boolean {
    if (this.live?.canUseManim(document) !== false) return false;
    void vscode.window.showInformationMessage("Manim runs on the host during live collaboration.");
    return true;
  }

  private async manimLaunch(document: vscode.TextDocument) {
    const configured = vscode.workspace.getConfiguration("slidepix").get<string>("manim.executable", "") ?? "";
    const log = this.manimLog();
    log.channel.show(false);
    return ensureManimLaunch(document.uri.fsPath, configured, log.append);
  }

  private async setupManim(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const log = this.manimLog();
    log.channel.show(false);
    if (this.refuseManim(document)) return;
    this.log("opening Manim setup");
    const notify = (status: "progress" | "success" | "error" | "dismiss", text?: string) => panel.webview.postMessage({ version: 2, type: "notify", notificationId: "manim-setup", status, message: text } satisfies HostToWebviewMessage);
    await notify("progress", "Choose how to set up Manim");
    try {
      const launch = await promptManimSetup(document.uri.fsPath, (text) => {
        log.append(text);
      });
      this.log(launch ? `Manim setup ready: ${launch.command} ${launch.args.join(" ")}` : "Manim setup finished without a saved launcher");
      await notify(launch ? "success" : "dismiss", launch ? `Manim is ready: ${launch.command}` : undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not set up Manim.";
      this.log(message, "error");
      await notify("error", message);
      void vscode.window.showErrorMessage(message);
    }
  }

  private async selectManimScript(document: vscode.TextDocument, panel: vscode.WebviewPanel, message: Extract<WebviewToHostMessage, { type: "selectManimScript" }>): Promise<void> {
    const response: HostToWebviewMessage = { version: 2, type: "manimScriptSelected", requestId: message.requestId };
    if (this.refuseManim(document)) { response.error = "Manim runs on the host during live collaboration."; return void panel.webview.postMessage(response); }
    try {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        canSelectFiles: true,
        canSelectFolders: false,
        filters: { Python: ["py"] },
        defaultUri: workspaceRootUris(document)[0]
      });
      if (!picked?.[0]) return void panel.webview.postMessage(response);
      const resolved = path.resolve(picked[0].fsPath);
      const roots = linkedRoots(document);
      if (!roots.some((root) => isInside(root, resolved))) throw new Error("Manim scripts must stay inside an open workspace root.");
      response.script = relativeDeckReference(document.uri.fsPath, resolved);
      const listed = await listScenesForScript(document.uri.fsPath, response.script, roots);
      response.scenes = listed.scenes;
    } catch (error) {
      response.error = error instanceof Error ? error.message : "Could not choose a Manim script";
    }
    await panel.webview.postMessage(response);
  }

  private async createManimScript(document: vscode.TextDocument, panel: vscode.WebviewPanel, message: Extract<WebviewToHostMessage, { type: "createManimScript" }>): Promise<void> {
    const response: HostToWebviewMessage = { version: 2, type: "manimScriptCreated", requestId: message.requestId };
    if (this.refuseManim(document)) { response.error = "Manim runs on the host during live collaboration."; return void panel.webview.postMessage(response); }
    let createdPath: string | undefined;
    let linked = false;
    try {
      const created = await createStarterScript(document.uri.fsPath);
      createdPath = created.absolutePath;
      response.script = created.reference;
      response.scene = created.scene;
      response.scenes = created.scenes;
      const baseText = document.getText();
      const baseRevision = revisionForText(baseText);
      const parsed = parseDeckText(baseText);
      if (!parsed.ok) throw new Error(parsed.message);
      applyManimScript(parsed.deck, message.elementId, created.reference, created.scene);
      if (!await replaceDocument(document, serializeDeck(parsed.deck), baseRevision)) {
        throw new Error("The deck changed before the starter script could be linked.");
      }
      linked = true;
      this.recordHistory(document.uri, baseText, document.getText());
      await vscode.window.showTextDocument(vscode.Uri.file(created.absolutePath), { viewColumn: vscode.ViewColumn.Beside });
    } catch (error) {
      if (createdPath && !linked) await deleteManimScript(createdPath).catch(() => undefined);
      response.error = error instanceof Error ? error.message : "Could not create a Manim script";
    }
    await panel.webview.postMessage(response);
  }

  private async openManimScript(document: vscode.TextDocument, message: Extract<WebviewToHostMessage, { type: "openManimScript" }>): Promise<void> {
    if (this.refuseManim(document)) return;
    try {
      const absolutePath = resolveMediaPath(document.uri.fsPath, message.script, "linked", linkedRoots(document));
      await vscode.window.showTextDocument(vscode.Uri.file(absolutePath), { viewColumn: vscode.ViewColumn.Beside });
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : "Could not open the Manim script.");
    }
  }

  private async listManimScenes(document: vscode.TextDocument, panel: vscode.WebviewPanel, message: Extract<WebviewToHostMessage, { type: "listManimScenes" }>): Promise<void> {
    const response: HostToWebviewMessage = { version: 2, type: "manimScenesListed", requestId: message.requestId };
    if (this.refuseManim(document)) { response.error = "Manim runs on the host during live collaboration."; return void panel.webview.postMessage(response); }
    try {
      const listed = await listScenesForScript(document.uri.fsPath, message.script, linkedRoots(document));
      response.scenes = listed.scenes;
      response.contentFingerprint = listed.contentFingerprint;
    } catch (error) {
      response.error = error instanceof Error ? error.message : "Could not inspect the Manim script";
    }
    await panel.webview.postMessage(response);
  }

  private async renderManim(document: vscode.TextDocument, panel: vscode.WebviewPanel, message: Extract<WebviewToHostMessage, { type: "renderManim" }>): Promise<void> {
    const response: HostToWebviewMessage = { version: 2, type: "manimRenderResult", requestId: message.requestId, ok: false, elementId: message.elementId };
    if (this.refuseManim(document)) { response.error = "Manim runs on the host during live collaboration."; return void panel.webview.postMessage(response); }
    const notify = async (status: "progress" | "success" | "error" | "dismiss", text?: string, progress?: number, elementId?: string, elementProgress?: number) => {
      await panel.webview.postMessage({ version: 2, type: "notify", notificationId: message.requestId, status, message: text, progress, elementId, elementProgress } satisfies HostToWebviewMessage);
    };
    await notify("progress", "Rendering Manim…", 0, message.elementId, 0);
    try {
      const rendered = await this.renderManimElements(document, [message.elementId], (update) => {
        void notify("progress", `Rendering ${update.label}… ${update.percent}%`, update.overall, update.elementId, update.percent);
      });
      if (rendered.cancelled) throw new ManimCancelled();
      if (rendered.error) throw new Error(rendered.error);
      const one = rendered.results[0];
      if (!one) throw new Error("Manim element not found.");
      response.ok = true;
      response.settingsFingerprint = one.settingsFingerprint;
      await notify("success", "Manim render complete.");
    } catch (error) {
      if (error instanceof ManimCancelled) {
        await notify("dismiss");
        response.error = error.message;
      } else {
        response.error = error instanceof Error ? error.message : "Manim render failed.";
        await notify("error", response.error);
      }
    }
    await panel.webview.postMessage(response);
  }

  private async renderAllManim(document: vscode.TextDocument, panel: vscode.WebviewPanel, message: Extract<WebviewToHostMessage, { type: "renderAllManim" }>): Promise<void> {
    const response: HostToWebviewMessage = { version: 2, type: "manimRenderAllResult", requestId: message.requestId, ok: false, rendered: 0, skipped: 0 };
    if (this.refuseManim(document)) { response.error = "Manim runs on the host during live collaboration."; return void panel.webview.postMessage(response); }
    const parsed = parseDeckText(document.getText());
    if (!parsed.ok) {
      response.error = parsed.message;
      await panel.webview.postMessage(response);
      return;
    }
    const ready: string[] = [];
    let skipped = 0;
    for (const slide of parsed.deck.slides) {
      for (const element of slide.elements) {
        if (element.type !== "manim") continue;
        if (element.script?.trim() && element.scene?.trim()) ready.push(element.id);
        else skipped += 1;
      }
    }
    response.skipped = skipped;
    this.log(`render all: ${ready.length} ready, ${skipped} skipped`);
    await panel.webview.postMessage({ version: 2, type: "notify", notificationId: message.requestId, status: "progress", message: ready.length ? `Rendering ${ready.length} Manim scene${ready.length === 1 ? "" : "s"}…` : "No Manim scenes to render", progress: 0 } satisfies HostToWebviewMessage);
    if (!ready.length) {
      response.error = skipped ? "No Manim element has both a script and a scene." : "This deck has no Manim elements.";
      await panel.webview.postMessage(response);
      return;
    }
    try {
      const rendered = await this.renderManimElements(document, ready, (update) => {
        void panel.webview.postMessage({ version: 2, type: "notify", notificationId: message.requestId, status: "progress", message: `Rendering ${update.total} Manim scenes… ${update.overall}%`, progress: update.overall, elementId: update.elementId, elementProgress: update.percent } satisfies HostToWebviewMessage);
      });
      response.rendered = rendered.results.length;
      response.results = rendered.results;
      response.ok = !rendered.cancelled && !rendered.error;
      if (rendered.cancelled) response.error = "Manim render cancelled.";
      else if (rendered.error) response.error = rendered.error;
    } catch (error) {
      response.error = error instanceof Error ? error.message : "Manim render failed.";
      response.rendered = 0;
    }
    await panel.webview.postMessage(response);
  }

  private async renderManimElements(document: vscode.TextDocument, elementIds: string[], onSceneProgress?: (update: { elementId: string; index: number; total: number; percent: number; overall: number; label: string }) => void): Promise<{ results: { elementId: string; settingsFingerprint: string }[]; cancelled: boolean; error?: string }> {
    if (this.manimRenderInFlight) throw new Error("A Manim render is already running.");
    this.manimRenderInFlight = true;
    try {
    const log = this.manimLog();
    log.channel.show(true);
    const launch = await this.manimLaunch(document);
    if (!launch) return { results: [], cancelled: false, error: "Manim setup was dismissed." };
    const started = parseDeckText(document.getText());
    if (!started.ok) return { results: [], cancelled: false, error: started.message };
    const jobs = elementIds.flatMap((elementId) => {
      const located = findManimElement(started.deck, elementId);
      if (!located) return [];
      const ownSource = located.element.outputMedia?.src;
      return [{
        elementId,
        located,
        label: located.element.scene || located.element.script || elementId,
        ownStem: ownSource ? path.basename(ownSource).replace(/\.[^.]+$/, "") : undefined
      }];
    });
    if (!jobs.length) return { results: [], cancelled: false, error: "Manim element not found." };
    const deckName = manimDeckStem(document.uri.fsPath);
    const basenames = assignManimBasenames(jobs.map((job) => ({
      id: job.elementId,
      deckName,
      slideTitle: started.deck.slides[job.located.slideIndex]?.title ?? "",
      scene: job.located.element.scene,
      ownStem: job.ownStem
    })), takenManimOutputStems(started.deck, ""));
    const results: { elementId: string; settingsFingerprint: string }[] = [];
    const failures: string[] = [];
    let cancelled = false;
    const percents = jobs.map(() => 0);
    let reportedOverall = 0;
    try {
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Rendering Manim",
      cancellable: true
    }, async (progress, token) => {
      const signal = abortFrom(token);
      const cores = manimRenderConcurrency(jobs.length);
      progress.report({ message: jobs.length > 1 ? `${jobs.length} scenes on ${cores} cores` : jobs[0]!.label });
      const settled = await mapWithConcurrency(jobs, manimRenderConcurrency(jobs.length), async (job, index) => {
        if (signal.aborted) return { cancelled: true as const };
        const outputBasename = basenames.get(job.elementId);
        log.append(`\n--- ${job.label} ---\n`);
        try {
          const rendered = await runManimRender({
            deckPath: document.uri.fsPath,
            element: job.located.element,
            slideTitle: started.deck.slides[job.located.slideIndex]?.title ?? "",
            launch,
            allowedLinkedRoots: linkedRoots(document),
            outputBasename,
            hooks: {
              signal,
              onStart: (pid) => log.append(`[${job.label}] process ${pid}\n`),
              onOutput: (text) => {
                for (const line of text.split("\n")) if (line) log.append(`[${job.label}] ${line}\n`);
              },
              onProgress: (percent) => {
                percents[index] = percent;
                const overall = Math.round(percents.reduce((sum, value) => sum + value, 0) / jobs.length);
                const delta = overall - reportedOverall;
                if (delta > 0) progress.report({ increment: delta, message: `${job.label} ${percent}%` });
                reportedOverall = Math.max(reportedOverall, overall);
                onSceneProgress?.({ elementId: job.elementId, index, total: jobs.length, percent, overall, label: job.label });
              }
            }
          });
          const embeddedReference = await storeNamedAsset(document.uri.fsPath, rendered.bytes, rendered.fileName);
          log.append(`[${job.label}] Embedded ${embeddedReference}\n`);
          return { ok: true as const, elementId: job.elementId, embeddedReference, settingsFingerprint: rendered.settingsFingerprint };
        } catch (error) {
          if (error instanceof ManimCancelled || signal.aborted) return { cancelled: true as const };
          const message = error instanceof Error ? error.message : "Manim render failed.";
          log.append(`[${job.label}] ${message}\n`);
          return { ok: false as const, label: job.label, message };
        }
      });
      const succeeded = settled.flatMap((item) => "ok" in item && item.ok ? [item] : []);
      for (const item of settled) {
        if ("cancelled" in item) cancelled = true;
        if ("ok" in item && !item.ok) failures.push(`${item.label}: ${item.message}`);
      }
      if (!succeeded.length) return;
      const latestText = document.getText();
      const latestRevision = revisionForText(latestText);
      const latest = parseDeckText(latestText);
      if (!latest.ok) throw new Error(latest.message);
      for (const item of succeeded) applyManimRender(latest.deck, item.elementId, item.embeddedReference);
      if (!await replaceDocument(document, serializeDeck(latest.deck), latestRevision)) {
        throw new Error("The deck changed while Manim was rendering. Retry after reviewing the latest deck.");
      }
      this.recordHistory(document.uri, latestText, document.getText());
      for (const item of succeeded) results.push({ elementId: item.elementId, settingsFingerprint: item.settingsFingerprint });
    });
    } catch (error) {
      if (error instanceof ManimCancelled) cancelled = true;
      else failures.push(error instanceof Error ? error.message : "Manim render failed.");
    }
    return { results, cancelled, error: failures.length ? failures.join("\n") : undefined };
    } finally {
      this.manimRenderInFlight = false;
    }
  }

  private async embedMedia(document: vscode.TextDocument, elementIds?: string[]): Promise<void> {
    const baseText = document.getText();
    const baseRevision = revisionForText(baseText);
    const parsed = parseDeckText(baseText);
    if (!parsed.ok) return void vscode.window.showErrorMessage(parsed.message);
    try {
      const wanted = elementIds?.length ? new Set(elementIds) : undefined;
      const roots = linkedRoots(document);
      let count = 0;
      for (const slide of parsed.deck.slides) {
        if (!wanted && slide.backgroundImage?.storage === "linked") {
          const source = resolveMediaPath(document.uri.fsPath, slide.backgroundImage.src, "linked", roots);
          const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(source));
          slide.backgroundImage.src = await storeEmbeddedBytes(document.uri.fsPath, bytes, path.basename(source), "");
          slide.backgroundImage.storage = "embedded";
          count += 1;
        }
        for (const element of slide.elements) {
          if ((element.type !== "image" && element.type !== "video") || element.storage !== "linked" || (wanted && !wanted.has(element.id))) continue;
          const source = resolveMediaPath(document.uri.fsPath, element.src, "linked", roots);
          const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(source));
          element.src = await storeEmbeddedBytes(document.uri.fsPath, bytes, path.basename(source), "");
          element.storage = "embedded";
          count += 1;
        }
      }
      if (!count) return void vscode.window.showInformationMessage("No linked media needed embedding.");
      if (!await replaceDocument(document, serializeDeck(parsed.deck), baseRevision)) {
        return void vscode.window.showWarningMessage("The deck changed while media was being embedded. No document changes were applied; retry Embed after reviewing the latest deck.");
      }
      this.recordHistory(document.uri, baseText, document.getText());
      void vscode.window.showInformationMessage(`Embedded ${count} media element${count === 1 ? "" : "s"} in ${path.basename(deckAssetDirectory(document.uri.fsPath))}.`);
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? `Could not embed media: ${error.message}` : "Could not embed media.");
    }
  }

  private webviewHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomUUID().replaceAll("-", "");
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "webview.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "webview.css"));
    const media = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media"));
    return `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: blob:; media-src ${webview.cspSource} blob:; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src ${webview.cspSource} data: blob:;"><link rel="stylesheet" href="${style}"></head><body data-media="${media}"><script nonce="${nonce}" type="module" src="${script}"></script></body></html>`;
  }
}

function safeExtension(name: string, mime: string): string {
  const fromName = path.extname(name).toLowerCase();
  if (/^\.[a-z0-9]{1,8}$/.test(fromName)) return fromName;
  const known: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov" };
  return known[mime] ?? ".bin";
}

async function storeNamedAsset(deckPath: string, bytes: Uint8Array, fileName: string): Promise<string> {
  const base = path.basename(fileName);
  if (base !== fileName || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(base)) throw new Error("Unsafe Manim output name.");
  const directory = vscode.Uri.file(deckAssetDirectory(deckPath));
  await vscode.workspace.fs.createDirectory(directory);
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(directory, base), bytes);
  return base;
}

function abortFrom(token: vscode.CancellationToken): AbortSignal {
  const controller = new AbortController();
  if (token.isCancellationRequested) controller.abort();
  token.onCancellationRequested(() => controller.abort());
  return controller.signal;
}

export async function storeEmbeddedBytes(deckPath: string, bytes: Uint8Array, name: string, mime: string): Promise<string> {
  const hash = createHash("sha256").update(bytes).digest("hex");
  const reference = `${hash}${safeExtension(name, mime)}`;
  const directory = vscode.Uri.file(deckAssetDirectory(deckPath));
  await vscode.workspace.fs.createDirectory(directory);
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(directory, reference), bytes);
  return reference;
}

export async function replaceDocument(document: vscode.TextDocument, text: string, baseRevision: string): Promise<boolean> {
  if (revisionForText(document.getText()) !== baseRevision) return false;
  const end = document.lineAt(Math.max(0, document.lineCount - 1)).range.end;
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, new vscode.Range(new vscode.Position(0, 0), end), text);
  return vscode.workspace.applyEdit(edit);
}

async function reopenUnsyncedEditor(tab: vscode.Tab): Promise<void> {
  if (!(tab.input instanceof vscode.TabInputCustom)) return;
  const { uri, viewType } = tab.input;
  const head = await vscode.workspace.fs.readFile(uri).then((bytes) => bytes.subarray(0, 3));
  const encoding = head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? "utf8bom" : "utf8";
  // An explicit encoding routes through the workbench file resolve, which is
  // what synchronizes a model Cursor opened without extension-host sync.
  await vscode.workspace.openTextDocument(uri, { encoding });
  const current = vscode.window.tabGroups.all.flatMap((group) => group.tabs).find((candidate) =>
    candidate.input instanceof vscode.TabInputCustom && candidate.input.viewType === viewType && candidate.input.uri.toString() === uri.toString() && candidate.group.viewColumn === tab.group.viewColumn);
  if (current) await vscode.window.tabGroups.close(current, true);
  await vscode.commands.executeCommand("vscode.openWith", uri, viewType, { viewColumn: tab.group.viewColumn, preserveFocus: false });
}

function workspaceRootUris(document: vscode.TextDocument): vscode.Uri[] {
  const roots = vscode.workspace.workspaceFolders?.map((folder) => folder.uri).filter((uri) => uri.scheme === "file") ?? [];
  return roots.length ? roots : [vscode.Uri.file(path.dirname(document.uri.fsPath))];
}

function linkedRoots(document: vscode.TextDocument): string[] {
  return workspaceRootUris(document).map((uri) => uri.fsPath);
}

function isInside(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}

function mediaKind(filePath: string): "image" | "video" | undefined {
  const extension = path.extname(filePath).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".avif"].includes(extension)) return "image";
  if ([".mp4", ".webm", ".mov", ".m4v", ".ogv"].includes(extension)) return "video";
  return undefined;
}

function hasGitConflictMarkers(text: string): boolean {
  return /^(?:<{7}|={7}|>{7})(?: |$)/m.test(text);
}

function editResult(
  requestId: string,
  accepted: boolean,
  text: string,
  reason?: "stale" | "invalid" | "applyFailed",
  message?: string,
  flags?: { canUndo: boolean; canRedo: boolean }
): Extract<HostToWebviewMessage, { type: "documentEditResult" }> {
  const parsed = parseDeckText(text);
  return {
    version: 2,
    type: "documentEditResult",
    requestId,
    accepted,
    revision: revisionForText(text),
    text,
    deck: parsed.ok ? parsed.deck : undefined,
    reason,
    message: parsed.ok ? message : message ?? parsed.message,
    ...flags
  };
}
