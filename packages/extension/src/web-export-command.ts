import * as path from "node:path";
import * as vscode from "vscode";
import type { Deck } from "@slidepix/core";
import { buildWebExport, pathExists, WebExportDestinationExistsError } from "./web-export";

export async function exportWeb(deck: Deck, deckPath: string): Promise<void> {
  while (true) {
    const destination = await vscode.window.showSaveDialog({
      title: "Export SlidePix web folder",
      defaultUri: vscode.Uri.file(deckPath.replace(/\.slidepix\.json$/i, "-web")),
      saveLabel: "Export"
    });
    if (!destination) return;
    if (await pathExists(destination.fsPath)) {
      await vscode.window.showWarningMessage("That web export folder already exists. Choose another folder name.");
      continue;
    }

    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Exporting SlidePix web folder", cancellable: false },
        () => buildWebExport(deck, deckPath, destination.fsPath, workspaceRoots(deckPath))
      );
      void vscode.window.showInformationMessage(`Exported ${path.basename(destination.fsPath)} with ${result.assetCount} asset${result.assetCount === 1 ? "" : "s"}.`);
      return;
    } catch (error) {
      if (error instanceof WebExportDestinationExistsError) {
        await vscode.window.showWarningMessage("That web export folder was created while exporting. Choose another folder name.");
        continue;
      }
      const message = error instanceof Error ? error.message : "Unknown export error";
      void vscode.window.showErrorMessage(`Could not export web presentation: ${message}`);
      return;
    }
  }
}

function workspaceRoots(deckPath: string): string[] {
  const roots = vscode.workspace.workspaceFolders
    ?.map((folder) => folder.uri)
    .filter((uri) => uri.scheme === "file")
    .map((uri) => uri.fsPath) ?? [];
  return roots.length ? roots : [path.dirname(deckPath)];
}
