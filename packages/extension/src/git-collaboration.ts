import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import * as vscode from "vscode";
import { mergeDecks, parseDeckText, type DeckMergeResolution } from "@slidepix/core";
import { revisionForText } from "./document-revision";

const execFile = promisify(execFileCallback);
const ATTRIBUTES_START = "# BEGIN SlidePix";
const ATTRIBUTES_END = "# END SlidePix";
export const MANAGED_ATTRIBUTES = `${ATTRIBUTES_START}\n*.slidepix.json text eol=lf merge=slidepix\n${ATTRIBUTES_END}`;
const MANAGED_MARKER = "slidepix.gitcollaboration";
const DRIVER_NAME = "SlidePix semantic deck merge";

export async function configureGitCollaboration(context: vscode.ExtensionContext, document?: vscode.TextDocument): Promise<void> {
  if (!document) return void vscode.window.showWarningMessage("Open a SlidePix deck inside a Git repository first.");
  const root = await findGitRoot(document.uri.fsPath);
  if (!root) return void vscode.window.showErrorMessage("The active SlidePix deck is not inside a Git repository, or Git is unavailable.");
  const driver = driverCommand(context);
  const attributesPath = path.join(root, ".gitattributes");
  const currentAttributes = await readOptionalFile(attributesPath);
  const nextAttributes = addManagedAttributes(currentAttributes);
  const detail = [
    `Repository: ${root}`,
    "",
    ".gitattributes patch:",
    attributesPatch(currentAttributes),
    "",
    "Repository-local Git configuration:",
    `merge.slidepix.name = ${DRIVER_NAME}`,
    `merge.slidepix.driver = ${driver}`
  ].join("\n");
  const choice = await vscode.window.showInformationMessage("Configure reliable SlidePix Git merging for this repository?", { modal: true, detail }, "Configure");
  if (choice !== "Configure") return;

  await installMergeDriver(context);
  await vscode.workspace.fs.writeFile(vscode.Uri.file(attributesPath), Buffer.from(nextAttributes, "utf8"));
  await git(root, ["config", "--local", "merge.slidepix.name", DRIVER_NAME]);
  await git(root, ["config", "--local", "merge.slidepix.driver", driver]);
  await git(root, ["config", "--local", MANAGED_MARKER, "true"]);
  void vscode.window.showInformationMessage("SlidePix Git collaboration is configured for this repository.");
}

export async function removeGitCollaboration(context: vscode.ExtensionContext, document?: vscode.TextDocument): Promise<void> {
  if (!document) return void vscode.window.showWarningMessage("Open a SlidePix deck inside the configured Git repository first.");
  const root = await findGitRoot(document.uri.fsPath);
  if (!root) return void vscode.window.showErrorMessage("The active SlidePix deck is not inside a Git repository, or Git is unavailable.");
  const expectedDriver = driverCommand(context);
  const configuredName = await gitValue(root, "merge.slidepix.name");
  const configuredDriver = await gitValue(root, "merge.slidepix.driver");
  const marker = await gitValue(root, MANAGED_MARKER);
  const choice = await vscode.window.showWarningMessage("Remove SlidePix Git collaboration from this repository?", { modal: true, detail: `Repository: ${root}\n\nThe managed .gitattributes block and matching repository-local Git settings will be removed.` }, "Remove");
  if (choice !== "Remove") return;

  const attributesPath = path.join(root, ".gitattributes");
  const currentAttributes = await readOptionalFile(attributesPath);
  const nextAttributes = removeManagedAttributes(currentAttributes);
  if (nextAttributes !== currentAttributes) await vscode.workspace.fs.writeFile(vscode.Uri.file(attributesPath), Buffer.from(nextAttributes, "utf8"));
  else if (hasManagedMarkers(currentAttributes)) void vscode.window.showWarningMessage("The SlidePix .gitattributes block was customized or incomplete, so it was preserved for manual review.");

  if (ownsGitConfiguration(marker, configuredName, configuredDriver, expectedDriver)) {
    await gitUnset(root, "merge.slidepix.name");
    await gitUnset(root, "merge.slidepix.driver");
    await gitUnset(root, MANAGED_MARKER);
    void vscode.window.showInformationMessage("SlidePix Git collaboration was removed from this repository.");
  } else if (!marker && !configuredName && !configuredDriver) {
    void vscode.window.showInformationMessage("No matching SlidePix Git collaboration settings were present in this repository.");
  } else {
    void vscode.window.showWarningMessage("The .gitattributes block was removed, but customized Git merge settings were preserved.");
  }
}

export async function resolveGitConflict(document?: vscode.TextDocument): Promise<void> {
  if (!document) return void vscode.window.showWarningMessage("Open the conflicted SlidePix deck first.");
  const workingRevision = revisionForText(document.getText());
  const root = await findGitRoot(document.uri.fsPath);
  if (!root) return void vscode.window.showErrorMessage("The active deck is not inside a Git repository, or Git is unavailable.");
  const relative = path.relative(root, document.uri.fsPath).replaceAll(path.sep, "/");
  const stages = await Promise.all([1, 2, 3].map((stage) => gitShowStage(root, stage, relative)));
  if (stages.some((text) => text === undefined)) return void vscode.window.showErrorMessage("Git does not have base, ours, and theirs stages for this deck.");
  const parsed = stages.map((text) => parseDeckText(text!));
  if (parsed.some((result) => !result.ok)) return void vscode.window.showErrorMessage("One of Git's stored deck versions is invalid and cannot be semantically merged.");
  const [base, ours, theirs] = parsed.map((result) => result.ok ? result.deck : undefined);
  if (!base || !ours || !theirs) return;

  const resolutions: Record<string, DeckMergeResolution> = {};
  let result = mergeDecks(base, ours, theirs, resolutions);
  while (!result.ok) {
    const conflict = result.conflicts[0];
    if (!conflict) return void vscode.window.showErrorMessage("SlidePix could not produce a valid merged deck.");
    const choice = await vscode.window.showQuickPick([
      { label: "Keep ours", description: preview(conflict.ours), resolution: "ours" as const },
      { label: "Use theirs", description: preview(conflict.theirs), resolution: "theirs" as const },
      { label: "Use base", description: preview(conflict.base), resolution: "base" as const }
    ], { title: `Resolve ${conflict.kind}: ${conflict.path}`, placeHolder: conflict.message });
    if (!choice) return;
    resolutions[conflict.id] = choice.resolution;
    result = mergeDecks(base, ours, theirs, resolutions);
  }

  const edit = new vscode.WorkspaceEdit();
  if (revisionForText(document.getText()) !== workingRevision) return void vscode.window.showWarningMessage("The deck changed while conflicts were being resolved. No resolution was applied; start the resolver again.");
  const end = document.lineAt(Math.max(0, document.lineCount - 1)).range.end;
  edit.replace(document.uri, new vscode.Range(new vscode.Position(0, 0), end), result.text);
  if (!await vscode.workspace.applyEdit(edit)) return void vscode.window.showErrorMessage("VS Code rejected the resolved SlidePix document.");
  const stage = await vscode.window.showInformationMessage("The SlidePix conflict is resolved and validated.", "Stage resolved file");
  if (stage === "Stage resolved file") {
    if (!await document.save()) return void vscode.window.showErrorMessage("The resolved deck could not be saved, so it was not staged.");
    await git(root, ["add", "--", relative]);
    void vscode.window.showInformationMessage("The resolved SlidePix deck was staged.");
  }
}

export function addManagedAttributes(text: string): string {
  const start = text.indexOf(ATTRIBUTES_START);
  const end = text.indexOf(ATTRIBUTES_END);
  if ((start < 0) !== (end < 0) || (start >= 0 && end < start)) throw new Error("The existing .gitattributes contains an incomplete SlidePix managed block.");
  if (start >= 0) return `${text.slice(0, start)}${MANAGED_ATTRIBUTES}${text.slice(end + ATTRIBUTES_END.length)}`;
  const prefix = text.length && !text.endsWith("\n") ? `${text}\n` : text;
  return `${prefix}${prefix.length ? "\n" : ""}${MANAGED_ATTRIBUTES}\n`;
}

export function removeManagedAttributes(text: string): string {
  const start = text.indexOf(MANAGED_ATTRIBUTES);
  if (start < 0) return text;
  let before = text.slice(0, start);
  let after = text.slice(start + MANAGED_ATTRIBUTES.length);
  if (before.endsWith("\n\n")) before = before.slice(0, -1);
  if (after.startsWith("\n")) after = after.slice(1);
  return before + after;
}

export function driverCommand(context: vscode.ExtensionContext): string {
  const executable = shellQuote(process.execPath.replaceAll("\\", "/"));
  const script = shellQuote(vscode.Uri.joinPath(context.globalStorageUri, "git-tools", "slidepix-merge-driver.cjs").fsPath.replaceAll("\\", "/"));
  return `env ELECTRON_RUN_AS_NODE=1 ${executable} ${script} \"%O\" \"%A\" \"%B\"`;
}

export function ownsGitConfiguration(marker: string | undefined, configuredName: string | undefined, configuredDriver: string | undefined, expectedDriver: string): boolean {
  return marker === "true" && configuredName === DRIVER_NAME && configuredDriver === expectedDriver;
}

function attributesPatch(current: string): string {
  const start = current.indexOf(ATTRIBUTES_START);
  const end = current.indexOf(ATTRIBUTES_END, Math.max(0, start));
  const previous = start >= 0 && end >= start ? current.slice(start, end + ATTRIBUTES_END.length) : "";
  const removed = previous ? previous.split("\n").map((line) => `-${line}`).join("\n") : "";
  const added = MANAGED_ATTRIBUTES.split("\n").map((line) => `+${line}`).join("\n");
  return ["--- .gitattributes", "+++ .gitattributes", "@@ SlidePix managed block @@", removed, added].filter(Boolean).join("\n");
}

function hasManagedMarkers(text: string): boolean {
  return text.includes(ATTRIBUTES_START) || text.includes(ATTRIBUTES_END);
}

async function installMergeDriver(context: vscode.ExtensionContext): Promise<string> {
  const directory = vscode.Uri.joinPath(context.globalStorageUri, "git-tools");
  const source = vscode.Uri.joinPath(context.extensionUri, "dist", "merge-driver.cjs");
  const destination = vscode.Uri.joinPath(directory, "slidepix-merge-driver.cjs");
  await vscode.workspace.fs.createDirectory(directory);
  await vscode.workspace.fs.writeFile(destination, await vscode.workspace.fs.readFile(source));
  return driverCommand(context);
}

async function findGitRoot(filePath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFile("git", ["-C", path.dirname(filePath), "rev-parse", "--show-toplevel"], { encoding: "utf8" });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

async function gitValue(root: string, key: string): Promise<string | undefined> {
  try { return (await git(root, ["config", "--local", "--get", key])).trim() || undefined; } catch { return undefined; }
}

async function gitUnset(root: string, key: string): Promise<void> {
  try { await git(root, ["config", "--local", "--unset-all", key]); } catch { /* Already absent. */ }
}

async function gitShowStage(root: string, stage: number, relative: string): Promise<string | undefined> {
  try { return await git(root, ["show", `:${stage}:${relative}`]); } catch { return undefined; }
}

async function readOptionalFile(filePath: string): Promise<string> {
  try { return Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(filePath))).toString("utf8"); } catch { return ""; }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function preview(value: unknown): string {
  if (value === undefined) return "(deleted)";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}
