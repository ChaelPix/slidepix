import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { createDeck, parseDeckText, serializeDeck } from "@slidepix/core";
import { uniqueDeckFilename } from "./create-deck";
import { SlidePixEditorProvider, VIEW_TYPE } from "./editor";
import { exportPptx } from "./pptx-export-command";
import { exportWeb } from "./web-export-command";
import { configureGitCollaboration, removeGitCollaboration, resolveGitConflict } from "./git-collaboration";
import { mcpTargets, mergeMcpTarget, slidepixMcpProcess, type McpTarget } from "./mcp-config";

export function activate(context: vscode.ExtensionContext): void {
  const editor = new SlidePixEditorProvider(context);
  context.subscriptions.push(
    editor.register(),
    vscode.commands.registerCommand("slidepix.createDeck", (selected?: vscode.Uri) => createDeckCommand(selected, editor)),
    vscode.commands.registerCommand("slidepix.exportPptx", () => withDeck(editor, (deck, document) => exportPptx(context, deck, document.uri.fsPath))),
    vscode.commands.registerCommand("slidepix.exportWeb", () => withDeck(editor, (deck, document) => exportWeb(deck, document.uri.fsPath))),
    vscode.commands.registerCommand("slidepix.present", () => editor.currentDocument() && editor.present(editor.currentDocument()!, false)),
    vscode.commands.registerCommand("slidepix.presenter", () => editor.currentDocument() && editor.present(editor.currentDocument()!, true)),
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
  const server = slidepixMcpProcess(
    process.execPath,
    vscode.Uri.joinPath(context.extensionUri, "dist", "mcp.cjs").fsPath,
    vscode.Uri.joinPath(context.globalStorageUri, "playwright").fsPath
  );
  const userDirectory = path.resolve(context.globalStorageUri.fsPath, "..", "..");
  const targets = mcpTargets(os.homedir(), userDirectory, process.platform);
  const choice = await vscode.window.showInformationMessage(
    "Add the read-only SlidePix MCP server for Cursor, VS Code, Codex, Claude Code, and Claude Desktop? New chats in those apps can then list, inspect, and render decks.",
    "Add",
    "Cancel"
  );
  if (choice !== "Add") return;
  const written: string[] = [];
  const failed: string[] = [];
  for (const target of targets) {
    try {
      await writeMcpTarget(target, server);
      written.push(target.filePath);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      failed.push(`${target.filePath}: ${detail}`);
    }
  }
  if (!written.length) return void vscode.window.showErrorMessage(`SlidePix could not install MCP. ${failed.join(" ")}`);
  const summary = `SlidePix MCP was added for ${written.length} app${written.length === 1 ? "" : "s"}. Start a new chat to use list_slides, inspect_slides, and render_slides.`;
  void vscode.window.showInformationMessage(failed.length ? `${summary} Skipped: ${failed.join(" ")}` : summary);
}

async function writeMcpTarget(target: McpTarget, server: ReturnType<typeof slidepixMcpProcess>): Promise<void> {
  const merged = mergeMcpTarget(await readOptionalText(target.filePath), target, server);
  const destination = vscode.Uri.file(target.filePath);
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(target.filePath)));
  await vscode.workspace.fs.writeFile(destination, Buffer.from(merged, "utf8"));
}

async function readOptionalText(filePath: string): Promise<string | undefined> {
  try {
    return Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(filePath))).toString("utf8");
  } catch {
    return undefined;
  }
}
