import { createHash } from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import { parseDeckText, type Deck, type HostToWebviewMessage, type WebviewToHostMessage } from "@slidepix/core";
import { deckAssetDirectory } from "@slidepix/core/assets";
import { exportPdf, exportPng } from "./renderer";
import { PresentationServer } from "./presentation";
import { presenterHtml } from "./presenter";

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
        vscode.Uri.file(deckAssetDirectory(document.uri.fsPath))
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
    const session = new PresentationServer(parsed.deck, document.uri.fsPath, (index) => presenterPanel?.webview.postMessage({ type: "state", index }));
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
    const assetUri = panel.webview.asWebviewUri(vscode.Uri.file(deckAssetDirectory(document.uri.fsPath))).toString();
    const message: HostToWebviewMessage = parsed.ok
      ? { version: 1, type: "deck", text, deck: parsed.deck, uri: assetUri }
      : { version: 1, type: "invalidDeck", text, message: parsed.message, uri: assetUri };
    void panel.webview.postMessage(message);
  }

  private async receive(document: vscode.TextDocument, panel: vscode.WebviewPanel, message: WebviewToHostMessage): Promise<void> {
    if (!message || message.version !== 1) return;
    if (message.type === "ready") return this.postDeck(document, panel);
    if (message.type === "replaceDocument") {
      const edit = new vscode.WorkspaceEdit();
      const end = document.lineAt(Math.max(0, document.lineCount - 1)).range.end;
      edit.replace(document.uri, new vscode.Range(new vscode.Position(0, 0), end), message.text);
      await vscode.workspace.applyEdit(edit);
      return;
    }
    if (message.type === "importAsset") return this.importAsset(document, panel, message);
    if (message.type === "command") {
      const parsed = parseDeckText(document.getText());
      if (message.command === "save") return void document.save();
      if (message.command === "configureMcp") return void vscode.commands.executeCommand("slidepix.configureMcp");
      if (!parsed.ok) return void vscode.window.showErrorMessage(parsed.message);
      if (message.command === "exportPdf") return exportPdf(this.context, parsed.deck, document.uri.fsPath);
      if (message.command === "exportPng") return exportPng(this.context, parsed.deck, document.uri.fsPath, message.slideIds);
      if (message.command === "present") return this.present(document, false);
      if (message.command === "presenter") return this.present(document, true);
    }
  }

  private async importAsset(document: vscode.TextDocument, panel: vscode.WebviewPanel, message: Extract<WebviewToHostMessage, { type: "importAsset" }>): Promise<void> {
    const response: HostToWebviewMessage = { version: 1, type: "assetImported", requestId: message.requestId };
    try {
      const bytes = Buffer.from(message.base64, "base64");
      if (bytes.byteLength > 100 * 1024 * 1024) throw new Error("Media files are limited to 100 MB per import.");
      const hash = createHash("sha256").update(bytes).digest("hex");
      const extension = safeExtension(message.name, message.mime);
      const reference = `${hash}${extension}`;
      const directory = vscode.Uri.file(deckAssetDirectory(document.uri.fsPath));
      await vscode.workspace.fs.createDirectory(directory);
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(directory, reference), bytes);
      response.reference = reference;
    } catch (error) {
      response.error = error instanceof Error ? error.message : "Could not import asset";
    }
    await panel.webview.postMessage(response);
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
