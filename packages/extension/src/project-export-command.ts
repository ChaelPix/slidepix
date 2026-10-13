import * as path from "node:path";
import { writeFile } from "node:fs/promises";
import * as vscode from "vscode";
import type { Deck } from "@slidepix/core";
import type { ExportResult } from "./export-result";
import { buildProjectArchive, deckHasManimMedia } from "./project-export";

export async function exportProject(deck: Deck, deckPath: string): Promise<ExportResult> {
  const includeManimMedia = await chooseManimMedia(deck);
  if (includeManimMedia === "cancelled") return { status: "cancelled" };
  const destination = await vscode.window.showSaveDialog({
    title: "Export SlidePix project",
    defaultUri: vscode.Uri.file(deckPath.replace(/\.slidepix\.json$/i, ".zip")),
    filters: { "SlidePix project": ["zip"] },
    saveLabel: "Export"
  });
  if (!destination) return { status: "cancelled" };

  try {
    const archive = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Exporting SlidePix project", cancellable: false },
      () => buildProjectArchive(deck, deckPath, workspaceRoots(deckPath), { includeManimMedia })
    );
    await writeFile(destination.fsPath, archive.bytes);
    const message = `Exported ${path.basename(destination.fsPath)} with ${archive.fileCount} file${archive.fileCount === 1 ? "" : "s"}.`;
    void vscode.window.showInformationMessage(message);
    return { status: "success", message };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown export error";
    void vscode.window.showErrorMessage(`Could not export project: ${message}`);
    return { status: "error", message: `Project export failed: ${message}` };
  }
}

async function chooseManimMedia(deck: Deck): Promise<boolean | "cancelled"> {
  if (!deckHasManimMedia(deck)) return true;
  const choice = await vscode.window.showInformationMessage(
    "Include rendered Manim media in the project zip? Skip it when a render file was deleted.",
    { modal: true },
    "Export Manim media",
    "Skip Manim media"
  );
  if (choice === "Export Manim media") return true;
  if (choice === "Skip Manim media") return false;
  return "cancelled";
}

function workspaceRoots(deckPath: string): string[] {
  const roots = vscode.workspace.workspaceFolders
    ?.map((folder) => folder.uri)
    .filter((uri) => uri.scheme === "file")
    .map((uri) => uri.fsPath) ?? [];
  return roots.length ? roots : [path.dirname(deckPath)];
}
