import * as vscode from "vscode";
import { createDeck, parseDeckText, serializeDeck } from "@slidepix/core";
import { uniqueDeckFilename } from "./create-deck";
import { SlidePixEditorProvider, VIEW_TYPE } from "./editor";
import { exportPdf, exportPng, installRenderer } from "./renderer";
import { exportPptx } from "./pptx-export-command";
import { exportWeb } from "./web-export-command";
import { configureGitCollaboration, removeGitCollaboration, resolveGitConflict } from "./git-collaboration";

export function activate(context: vscode.ExtensionContext): void {
  const editor = new SlidePixEditorProvider(context);
  context.subscriptions.push(
    editor.register(),
    vscode.commands.registerCommand("slidepix.createDeck", (selected?: vscode.Uri) => createDeckCommand(selected, editor)),
    vscode.commands.registerCommand("slidepix.exportPdf", () => withDeck(editor, (deck, document) => exportPdf(context, deck, document.uri.fsPath))),
    vscode.commands.registerCommand("slidepix.exportPng", () => withDeck(editor, (deck, document) => exportPng(context, deck, document.uri.fsPath))),
    vscode.commands.registerCommand("slidepix.exportPptx", () => withDeck(editor, (deck, document) => exportPptx(context, deck, document.uri.fsPath))),
    vscode.commands.registerCommand("slidepix.exportWeb", () => withDeck(editor, (deck, document) => exportWeb(deck, document.uri.fsPath))),
    vscode.commands.registerCommand("slidepix.present", () => editor.currentDocument() && editor.present(editor.currentDocument()!, false)),
    vscode.commands.registerCommand("slidepix.presenter", () => editor.currentDocument() && editor.present(editor.currentDocument()!, true)),
    vscode.commands.registerCommand("slidepix.installRenderer", () => installRenderer(context)),
    vscode.commands.registerCommand("slidepix.configureMcp", () => configureMcp(context)),
    vscode.commands.registerCommand("slidepix.configureGitCollaboration", () => reportGitError("configure Git collaboration", () => configureGitCollaboration(context, editor.currentDocument()))),
    vscode.commands.registerCommand("slidepix.removeGitCollaboration", () => reportGitError("remove Git collaboration", () => removeGitCollaboration(context, editor.currentDocument()))),
    vscode.commands.registerCommand("slidepix.resolveGitConflict", () => reportGitError("resolve the Git conflict", () => resolveGitConflict(editor.currentDocument())))
  );
}

export function deactivate(): void {}

async function reportGitError(action: string, operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`SlidePix could not ${action}: ${detail}`);
  }
}

async function createDeckCommand(selected: vscode.Uri | undefined, editor: SlidePixEditorProvider): Promise<void> {
  const directory = await deckCreationDirectory(selected, editor);
  if (!directory) return void vscode.window.showWarningMessage("Open a workspace folder before creating a SlidePix deck.");
  const destination = await uniqueUntitledDeckUri(directory);
  await vscode.workspace.fs.writeFile(destination, Buffer.from(serializeDeck(createDeck()), "utf8"));
  await vscode.commands.executeCommand("vscode.openWith", destination, VIEW_TYPE);
}

async function uniqueUntitledDeckUri(directory: vscode.Uri): Promise<vscode.Uri> {
  let names: string[] = [];
  try { names = (await vscode.workspace.fs.readDirectory(directory)).map(([name]) => name); }
  catch { /* An unreadable folder still gets untitled.slidepix.json. */ }
  return vscode.Uri.joinPath(directory, uniqueDeckFilename(names));
}

async function deckCreationDirectory(selected: vscode.Uri | undefined, editor: SlidePixEditorProvider): Promise<vscode.Uri | undefined> {
  const candidate = asFileUri(selected) ?? asFileUri(editor.currentDocument()?.uri) ?? asFileUri(activeEditorUri());
  if (candidate) {
    try {
      const stat = await vscode.workspace.fs.stat(candidate);
      return stat.type & vscode.FileType.Directory ? candidate : vscode.Uri.joinPath(candidate, "..");
    } catch { /* Fall back to the workspace root. */ }
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

function activeEditorUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputNotebook) return input.uri;
  return vscode.window.activeTextEditor?.document.uri;
}

function asFileUri(value: unknown): vscode.Uri | undefined {
  return value instanceof vscode.Uri && value.scheme === "file" ? value : undefined;
}

async function withDeck(editor: SlidePixEditorProvider, action: (deck: import("@slidepix/core").Deck, document: vscode.TextDocument) => Promise<unknown>): Promise<void> {
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
