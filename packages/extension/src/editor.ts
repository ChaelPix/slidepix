import { createHash } from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import { parseDeckText, serializeDeck, type Deck, type HostToWebviewMessage, type WebviewToHostMessage } from "@slidepix/core";
import { deckAssetDirectory, resolveMediaPath } from "@slidepix/core/assets";
import { exportPdf, exportPng } from "./renderer";
import { exportPptx } from "./pptx-export-command";
import { exportWeb } from "./web-export-command";
import { PresentationServer } from "./presentation";
import { presenterHtml } from "./presenter";
import { cssFontFamily, discoverSystemFontFamilies } from "./fonts";
import { revisionForText } from "./document-revision";

export const VIEW_TYPE = "slidepix.deckEditor";

export class SlidePixEditorProvider implements vscode.CustomTextEditorProvider {
  private readonly panels = new Map<string, Set<vscode.WebviewPanel>>();
  private readonly sessions = new Map<string, PresentationServer>();
  private activeDocument?: vscode.TextDocument;

  constructor(private readonly context: vscode.ExtensionContext) {}

  register(): vscode.Disposable {
    const provider = vscode.window.registerCustomEditorProvider(VIEW_TYPE, this, { supportsMultipleEditorsPerDocument: true, webviewOptions: { retainContextWhenHidden: true } });
    const changes = vscode.workspace.onDidChangeTextDocument((event) => this.updatePanels(event.document));
    return vscode.Disposable.from(provider, changes, { dispose: () => { for (const session of this.sessions.values()) session.dispose(); } });
  }

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    this.activeDocument = document;
    const key = document.uri.toString();
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
    panel.onDidDispose(() => { set.delete(panel); if (!set.size) this.panels.delete(key); });
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
    const message: HostToWebviewMessage = parsed.ok
      ? { version: 2, type: "deck", text, deck: parsed.deck, revision, uri: assetUri, linkedUri }
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
        await panel.webview.postMessage(editResult(message.requestId, false, currentText, "stale", "The deck changed before this edit could be applied."));
        return;
      }
      const incoming = parseDeckText(message.text);
      if (!incoming.ok) {
        await panel.webview.postMessage(editResult(message.requestId, false, currentText, "invalid", incoming.message));
        return;
      }
      const edit = new vscode.WorkspaceEdit();
      const end = document.lineAt(Math.max(0, document.lineCount - 1)).range.end;
      edit.replace(document.uri, new vscode.Range(new vscode.Position(0, 0), end), message.text);
      const applied = await vscode.workspace.applyEdit(edit);
      const nextText = document.getText();
      await panel.webview.postMessage(editResult(message.requestId, applied, nextText, applied ? undefined : "applyFailed", applied ? undefined : "VS Code rejected the document edit."));
      return;
    }
    if (message.type === "history") {
      try {
        await vscode.commands.executeCommand(message.command);
        const text = document.getText();
        const parsed = parseDeckText(text);
        await panel.webview.postMessage({
          version: 2,
          type: "historyResult",
          requestId: message.requestId,
          command: message.command,
          ok: parsed.ok,
          revision: revisionForText(text),
          text,
          deck: parsed.ok ? parsed.deck : undefined,
          error: parsed.ok ? undefined : parsed.message
        } satisfies HostToWebviewMessage);
      } catch (error) {
        const text = document.getText();
        const parsed = parseDeckText(text);
        await panel.webview.postMessage({
          version: 2,
          type: "historyResult",
          requestId: message.requestId,
          command: message.command,
          ok: false,
          revision: revisionForText(text),
          text,
          deck: parsed.ok ? parsed.deck : undefined,
          error: error instanceof Error ? error.message : `Could not ${message.command}.`
        } satisfies HostToWebviewMessage);
      }
      return;
    }
    if (message.type === "importAsset") return this.importAsset(document, panel, message);
    if (message.type === "selectMedia") return this.selectMedia(document, panel, message);
    if (message.type === "linkMedia") return this.resolveMedia(document, panel, message, vscode.Uri.parse(message.uri));
    if (message.type === "embedMedia") return this.embedMedia(document, message.elementIds);
    if (message.type === "selectFont") return this.selectFont(panel, message);
    if (message.type === "command") {
      if (message.command === "undo" || message.command === "redo") return void vscode.commands.executeCommand(message.command);
      if (message.command === "save") return void document.save();
      if (message.command === "configureMcp") return void vscode.commands.executeCommand("slidepix.configureMcp");
      if (message.command === "resolveGitConflict") return void vscode.commands.executeCommand("slidepix.resolveGitConflict");
      if (message.command === "openTextEditor") return void vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside });
      const parsed = parseDeckText(document.getText());
      if (!parsed.ok) return void vscode.window.showErrorMessage(parsed.message);
      if (message.command === "exportPdf") return exportPdf(this.context, parsed.deck, document.uri.fsPath);
      if (message.command === "exportPng") return exportPng(this.context, parsed.deck, document.uri.fsPath, message.slideIds);
      if (message.command === "exportPptx") return exportPptx(this.context, parsed.deck, document.uri.fsPath);
      if (message.command === "exportWeb") return exportWeb(parsed.deck, document.uri.fsPath);
      if (message.command === "present") return this.present(document, false);
      if (message.command === "presenter") return this.present(document, true);
    }
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

  private async embedMedia(document: vscode.TextDocument, elementIds?: string[]): Promise<void> {
    const baseText = document.getText();
    const baseRevision = revisionForText(baseText);
    const parsed = parseDeckText(baseText);
    if (!parsed.ok) return void vscode.window.showErrorMessage(parsed.message);
    try {
      const wanted = elementIds?.length ? new Set(elementIds) : undefined;
      const roots = linkedRoots(document);
      let count = 0;
      for (const slide of parsed.deck.slides) for (const element of slide.elements) {
        if ((element.type !== "image" && element.type !== "video") || element.storage !== "linked" || (wanted && !wanted.has(element.id))) continue;
        const source = resolveMediaPath(document.uri.fsPath, element.src, "linked", roots);
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(source));
        element.src = await storeEmbeddedBytes(document.uri.fsPath, bytes, path.basename(source), "");
        element.storage = "embedded";
        count += 1;
      }
      if (!count) return void vscode.window.showInformationMessage("No linked media needed embedding.");
      if (!await replaceDocument(document, serializeDeck(parsed.deck), baseRevision)) {
        return void vscode.window.showWarningMessage("The deck changed while media was being embedded. No document changes were applied; retry Embed after reviewing the latest deck.");
      }
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
    return `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: blob:; media-src ${webview.cspSource} blob:; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${style}"></head><body data-media="${media}"><script nonce="${nonce}" type="module" src="${script}"></script></body></html>`;
  }
}

function safeExtension(name: string, mime: string): string {
  const fromName = path.extname(name).toLowerCase();
  if (/^\.[a-z0-9]{1,8}$/.test(fromName)) return fromName;
  const known: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov" };
  return known[mime] ?? ".bin";
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
  message?: string
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
    message: parsed.ok ? message : message ?? parsed.message
  };
}
