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
  takenManimOutputStems,
  type ManimRenderHooks
} from "./manim-host";
import { ensureManimLaunch, promptManimSetup } from "./manim-setup";

export const VIEW_TYPE = "slidepix.deckEditor";

export class SlidePixEditorProvider implements vscode.CustomTextEditorProvider {
  private readonly panels = new Map<string, Set<vscode.WebviewPanel>>();
  private readonly sessions = new Map<string, PresentationServer>();
  private readonly histories = new Map<string, DocumentHistory>();
  private activeDocument?: vscode.TextDocument;
  private outputChannel?: vscode.OutputChannel;
  private manimRenderInFlight = false;
  private readonly recovery = new EditorResolveRecovery<vscode.Tab>({
    isResolved: (key) => this.panels.has(key),
    hasDocument: (key) => vscode.workspace.textDocuments.some((document) => document.uri.toString() === key),
    reopen: (tab) => reopenUnsyncedEditor(tab),
    report: (error) => void vscode.window.showErrorMessage(`SlidePix could not reopen the deck: ${error instanceof Error ? error.message : String(error)}`)
  });

  constructor(private readonly context: vscode.ExtensionContext) {}

  private watchTab(tab: vscode.Tab): void {
    if (!tab.isActive || !(tab.input instanceof vscode.TabInputCustom) || tab.input.viewType !== VIEW_TYPE || tab.input.uri.scheme !== "file") return;
    this.recovery.watch(tab.input.uri.toString(), tab);
  }

  register(): vscode.Disposable {
    const provider = vscode.window.registerCustomEditorProvider(VIEW_TYPE, this, { supportsMultipleEditorsPerDocument: true, webviewOptions: { retainContextWhenHidden: true } });
    const changes = vscode.workspace.onDidChangeTextDocument((event) => this.updatePanels(event.document));
    const tabs = vscode.window.tabGroups.onDidChangeTabs((event) => { for (const tab of [...event.opened, ...event.changed]) this.watchTab(tab); });
    for (const group of vscode.window.tabGroups.all) for (const tab of group.tabs) this.watchTab(tab);
    return vscode.Disposable.from(provider, changes, tabs, this.recovery, { dispose: () => { for (const session of this.sessions.values()) session.dispose(); } });
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
        vscode.Uri.file(deckAssetDirectory(document.uri.fsPath)),
        ...workspaceRootUris(document)
      ]
    };
    panel.webview.html = this.webviewHtml(panel.webview);
    panel.onDidChangeViewState(() => { if (panel.active) this.activeDocument = document; });
    panel.onDidDispose(() => {
      set.delete(panel);
      if (!set.size) {
        this.panels.delete(key);
        this.histories.delete(key);
      }
    });
    panel.webview.onDidReceiveMessage((message: WebviewToHostMessage) => void this.receive(document, panel, message));
  }

  currentDocument(): vscode.TextDocument | undefined { return this.activeDocument; }

  async present(document: vscode.TextDocument, presenter = false): Promise<void> {
    const parsed = parseDeckText(document.getText());
    if (!parsed.ok) return void vscode.window.showErrorMessage(parsed.message);
    const key = document.uri.toString();
    this.sessions.get(key)?.dispose();
    let presenterPanel: vscode.WebviewPanel | undefined;
    const session = new PresentationServer(parsed.deck, document.uri.fsPath, (index) => presenterPanel?.webview.postMessage({ type: "state", index }), linkedRoots(document));
    await session.start();
    this.sessions.set(key, session);
    if (!presenter) {
      await vscode.env.openExternal(vscode.Uri.parse(session.url("/audience")));
      return;
    }
    presenterPanel = vscode.window.createWebviewPanel("slidepix.presenter", "SlidePix Presenter", vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
    presenterPanel.webview.html = presenterHtml(session, parsed.deck);
    presenterPanel.webview.onDidReceiveMessage((message: { command?: "next" | "previous" | "first" | "last" }) => {
      if (message.command === "next" || message.command === "previous") session.control(message.command);
      else if (message.command) session.command(message.command);
    });
    presenterPanel.onDidDispose(() => session.dispose());
    await vscode.env.openExternal(vscode.Uri.parse(session.url("/audience")));
  }

  private updatePanels(document: vscode.TextDocument): void {
    const set = this.panels.get(document.uri.toString());
    if (!set) return;
    for (const panel of set) this.postDeck(document, panel);
  }

  private postDeck(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    const text = document.getText();
    const parsed = parseDeckText(text);
    const revision = revisionForText(text);
    const assetUri = panel.webview.asWebviewUri(vscode.Uri.file(deckAssetDirectory(document.uri.fsPath))).toString();
    const linkedUri = panel.webview.asWebviewUri(vscode.Uri.file(path.dirname(document.uri.fsPath))).toString();
    const flags = this.historyState(document.uri);
    const message: HostToWebviewMessage = parsed.ok
      ? { version: 2, type: "deck", text, deck: parsed.deck, revision, uri: assetUri, linkedUri, ...flags }
      : { version: 2, type: "invalidDeck", text, revision, message: parsed.message, gitConflict: hasGitConflictMarkers(text), uri: assetUri, linkedUri };
    void panel.webview.postMessage(message);
  }

  private async receive(document: vscode.TextDocument, panel: vscode.WebviewPanel, message: WebviewToHostMessage): Promise<void> {
    if (!message || message.version !== 2) {
      panel.webview.html = this.webviewHtml(panel.webview);
      return;
    }
    if (message.type === "ready") return this.postDeck(document, panel);
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
      await panel.webview.postMessage(editResult(message.requestId, applied, nextText, applied ? undefined : "applyFailed", applied ? undefined : "VS Code rejected the document edit.", this.historyState(document.uri)));
      return;
    }
    if (message.type === "history") {
      await this.applyHistory(document, panel, message.command, message.requestId);
      return;
    }
    if (message.type === "importAsset") return this.importAsset(document, panel, message);
    if (message.type === "selectMedia") return this.selectMedia(document, panel, message);
    if (message.type === "linkMedia") return this.resolveMedia(document, panel, message, vscode.Uri.parse(message.uri));
    if (message.type === "embedMedia") return this.embedMedia(document, message.elementIds);
    if (message.type === "selectFont") return this.selectFont(panel, message);
    if (message.type === "selectManimScript") return this.selectManimScript(document, panel, message);
    if (message.type === "createManimScript") return this.createManimScript(document, panel, message);
    if (message.type === "openManimScript") return this.openManimScript(document, message);
    if (message.type === "listManimScenes") return this.listManimScenes(document, panel, message);
    if (message.type === "renderManim") return this.renderManim(document, panel, message);
    if (message.type === "renderAllManim") return this.renderAllManim(document, panel, message);
    if (message.type === "setupManim") return this.setupManim(document);
    if (message.type === "command") {
      if (message.command === "undo" || message.command === "redo") return this.applyHistory(document, panel, message.command);
      if (message.command === "save") return void document.save();
      if (message.command === "configureMcp") return void vscode.commands.executeCommand("slidepix.configureMcp");
      if (message.command === "resolveGitConflict") return void vscode.commands.executeCommand("slidepix.resolveGitConflict");
      if (message.command === "openTextEditor") return void vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside });
      const parsed = parseDeckText(document.getText());
      if (!parsed.ok) return void vscode.window.showErrorMessage(parsed.message);
      if (message.command === "exportPptx") return this.runExport(panel, message.requestId, "PowerPoint export", () => exportPptx(this.context, parsed.deck, document.uri.fsPath));
      if (message.command === "exportWeb") return this.runExport(panel, message.requestId, "Web export", () => exportWeb(parsed.deck, document.uri.fsPath));
      if (message.command === "present") return this.present(document, false);
      if (message.command === "presenter") return this.present(document, true);
    }
    if (message.type === "saveExport") {
      const destination = await vscode.window.showSaveDialog({
        filters: message.format === "pdf" ? { PDF: ["pdf"] } : { PNG: ["png"] },
        defaultUri: vscode.Uri.file(document.uri.fsPath.replace(/\.slidepix\.json$/i, message.format === "pdf" ? ".pdf" : ".png"))
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
      this.outputChannel = vscode.window.createOutputChannel("SlidePix");
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
    if (step) {
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
      response.reference = await storeEmbeddedBytes(document.uri.fsPath, bytes, message.name, message.mime);
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

  private async manimLaunch(document: vscode.TextDocument) {
    const configured = vscode.workspace.getConfiguration("slidepix").get<string>("manim.executable", "") ?? "";
    const log = this.manimLog();
    log.channel.show(true);
    return ensureManimLaunch(document.uri.fsPath, configured, log.append);
  }

  private async setupManim(document: vscode.TextDocument): Promise<void> {
    const log = this.manimLog();
    log.channel.show(true);
    try {
      await promptManimSetup(document.uri.fsPath, log.append);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not set up Manim.";
      log.append(`\n${message}\n`);
      void vscode.window.showErrorMessage(message);
    }
  }

  private async selectManimScript(document: vscode.TextDocument, panel: vscode.WebviewPanel, message: Extract<WebviewToHostMessage, { type: "selectManimScript" }>): Promise<void> {
    const response: HostToWebviewMessage = { version: 2, type: "manimScriptSelected", requestId: message.requestId };
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
    try {
      const absolutePath = resolveMediaPath(document.uri.fsPath, message.script, "linked", linkedRoots(document));
      await vscode.window.showTextDocument(vscode.Uri.file(absolutePath), { viewColumn: vscode.ViewColumn.Beside });
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : "Could not open the Manim script.");
    }
  }

  private async listManimScenes(document: vscode.TextDocument, panel: vscode.WebviewPanel, message: Extract<WebviewToHostMessage, { type: "listManimScenes" }>): Promise<void> {
    const response: HostToWebviewMessage = { version: 2, type: "manimScenesListed", requestId: message.requestId };
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
    const notify = async (status: "progress" | "success" | "error" | "dismiss", text?: string) => {
      await panel.webview.postMessage({ version: 2, type: "notify", notificationId: message.requestId, status, message: text } satisfies HostToWebviewMessage);
    };
    await notify("progress", "Rendering Manim…");
    try {
      const rendered = await this.renderManimElements(document, [message.elementId]);
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
    if (!ready.length) {
      response.error = skipped ? "No Manim element has both a script and a scene." : "This deck has no Manim elements.";
      await panel.webview.postMessage(response);
      return;
    }
    try {
      const rendered = await this.renderManimElements(document, ready);
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

  private async renderManimElements(document: vscode.TextDocument, elementIds: string[]): Promise<{ results: { elementId: string; settingsFingerprint: string }[]; cancelled: boolean; error?: string }> {
    if (this.manimRenderInFlight) throw new Error("A Manim render is already running.");
    this.manimRenderInFlight = true;
    try {
    const log = this.manimLog();
    log.channel.show(true);
    const launch = await this.manimLaunch(document);
    if (!launch) return { results: [], cancelled: true };
    const results: { elementId: string; settingsFingerprint: string }[] = [];
    let cancelled = false;
    let reported = 0;
    let failure: string | undefined;
    try {
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Rendering Manim",
      cancellable: true
    }, async (progress, token) => {
      const signal = abortFrom(token);
      try {
        for (const [index, elementId] of elementIds.entries()) {
          if (signal.aborted) throw new ManimCancelled();
          const baseText = document.getText();
          const baseRevision = revisionForText(baseText);
          const parsed = parseDeckText(baseText);
          if (!parsed.ok) throw new Error(parsed.message);
          const located = findManimElement(parsed.deck, elementId);
          if (!located) throw new Error("Manim element not found.");
          const label = located.element.scene || located.element.script || elementId;
          reported = 0;
          progress.report({ message: `${index + 1}/${elementIds.length} ${label}` });
          log.append(`\n--- ${label} ---\n`);
          const hooks: ManimRenderHooks = {
            signal,
            onOutput: (text) => log.append(text),
            onProgress: (percent) => {
              const delta = percent - reported;
              if (delta > 0) progress.report({ increment: delta, message: `${index + 1}/${elementIds.length} ${label} ${percent}%` });
              reported = percent;
            }
          };
          const rendered = await runManimRender({
            deckPath: document.uri.fsPath,
            element: located.element,
            slideTitle: parsed.deck.slides[located.slideIndex]?.title ?? "",
            launch,
            allowedLinkedRoots: linkedRoots(document),
            takenStems: takenManimOutputStems(parsed.deck, elementId),
            hooks
          });
          const embeddedReference = await storeNamedAsset(document.uri.fsPath, rendered.bytes, rendered.fileName);
          applyManimRender(parsed.deck, elementId, embeddedReference);
          if (!await replaceDocument(document, serializeDeck(parsed.deck), baseRevision)) {
            throw new Error("The deck changed while Manim was rendering. Retry after reviewing the latest deck.");
          }
          this.recordHistory(document.uri, baseText, document.getText());
          results.push({ elementId, settingsFingerprint: rendered.settingsFingerprint });
          log.append(`Embedded ${embeddedReference}\n`);
        }
      } catch (error) {
        if (error instanceof ManimCancelled) {
          cancelled = true;
          return;
        }
        throw error;
      }
    });
    } catch (error) {
      failure = error instanceof Error ? error.message : "Manim render failed.";
    }
    return { results, cancelled, error: failure };
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

async function storeEmbeddedBytes(deckPath: string, bytes: Uint8Array, name: string, mime: string): Promise<string> {
  const hash = createHash("sha256").update(bytes).digest("hex");
  const reference = `${hash}${safeExtension(name, mime)}`;
  const directory = vscode.Uri.file(deckAssetDirectory(deckPath));
  await vscode.workspace.fs.createDirectory(directory);
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(directory, reference), bytes);
  return reference;
}

async function replaceDocument(document: vscode.TextDocument, text: string, baseRevision: string): Promise<boolean> {
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
