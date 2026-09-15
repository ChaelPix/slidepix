import * as vscode from "vscode";
import { createDeck, parseDeckText, serializeDeck } from "@slidepix/core";
import { SlidePixEditorProvider, VIEW_TYPE } from "./editor";
import { exportPdf, exportPng, installRenderer } from "./renderer";
import { exportWeb } from "./web-export-command";

export function activate(context: vscode.ExtensionContext): void {
  const editor = new SlidePixEditorProvider(context);
  context.subscriptions.push(
    editor.register(),
    vscode.commands.registerCommand("slidepix.createDeck", () => createDeckCommand()),
    vscode.commands.registerCommand("slidepix.exportPdf", () => withDeck(editor, (deck, document) => exportPdf(context, deck, document.uri.fsPath))),
    vscode.commands.registerCommand("slidepix.exportPng", () => withDeck(editor, (deck, document) => exportPng(context, deck, document.uri.fsPath))),
    vscode.commands.registerCommand("slidepix.exportWeb", () => withDeck(editor, (deck, document) => exportWeb(deck, document.uri.fsPath))),
    vscode.commands.registerCommand("slidepix.present", () => editor.currentDocument() && editor.present(editor.currentDocument()!, false)),
    vscode.commands.registerCommand("slidepix.presenter", () => editor.currentDocument() && editor.present(editor.currentDocument()!, true)),
    vscode.commands.registerCommand("slidepix.installRenderer", () => installRenderer(context)),
    vscode.commands.registerCommand("slidepix.configureMcp", () => configureMcp(context))
  );
}

export function deactivate(): void {}

async function createDeckCommand(): Promise<void> {
  let destination = await vscode.window.showSaveDialog({ filters: { "SlidePix deck": ["json"] }, defaultUri: vscode.Uri.file("untitled.slidepix.json") });
  if (!destination) return;
  if (!destination.fsPath.endsWith(".slidepix.json")) destination = vscode.Uri.file(`${destination.fsPath.replace(/\.json$/i, "")}.slidepix.json`);
  const title = destination.path.split("/").pop()?.replace(/\.slidepix\.json$/i, "") || "Untitled deck";
  await vscode.workspace.fs.writeFile(destination, Buffer.from(serializeDeck(createDeck(title)), "utf8"));
  await vscode.commands.executeCommand("vscode.openWith", destination, VIEW_TYPE);
}

async function withDeck(editor: SlidePixEditorProvider, action: (deck: import("@slidepix/core").Deck, document: vscode.TextDocument) => Promise<void>): Promise<void> {
  const document = editor.currentDocument();
  if (!document) return void vscode.window.showWarningMessage("Open a SlidePix deck first.");
  const parsed = parseDeckText(document.getText());
  if (!parsed.ok) return void vscode.window.showErrorMessage(parsed.message);
  await action(parsed.deck, document);
}

async function configureMcp(context: vscode.ExtensionContext): Promise<void> {
  const renderer = await installRenderer(context);
  if (!renderer) return;
  const server = vscode.Uri.joinPath(context.extensionUri, "dist", "mcp.cjs").fsPath;
  const browsers = vscode.Uri.joinPath(context.globalStorageUri, "playwright").fsPath;
  const command = process.execPath;
  const common = { command, args: [server], env: { ELECTRON_RUN_AS_NODE: "1", PLAYWRIGHT_BROWSERS_PATH: browsers } };
  const config = {
    vscode: { servers: { slidepix: { type: "stdio", ...common } } },
    cursor: { mcpServers: { slidepix: common } }
  };
  const text = JSON.stringify(config, null, 2);
  const choice = await vscode.window.showInformationMessage("SlidePix MCP configuration is ready. It will not modify your workspace automatically.", "Copy", "Preview");
  if (choice === "Copy") await vscode.env.clipboard.writeText(text);
  if (choice === "Preview") await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: "json", content: text }));
}
