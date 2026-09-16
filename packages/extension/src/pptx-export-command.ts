import * as path from "node:path";
import * as vscode from "vscode";
import type { Deck } from "@slidepix/core";
import { buildPptxExport } from "./pptx-export";
import { workspaceRoots } from "./renderer";

let reportChannel: vscode.OutputChannel | undefined;

export async function exportPptx(context: vscode.ExtensionContext, deck: Deck, deckPath: string): Promise<void> {
  let destination = await vscode.window.showSaveDialog({
    title: "Export SlidePix PowerPoint",
    filters: { PowerPoint: ["pptx"] },
    defaultUri: vscode.Uri.file(deckPath.replace(/\.slidepix\.json$/i, ".pptx")),
    saveLabel: "Export"
  });
  if (!destination) return;
  if (!destination.fsPath.toLowerCase().endsWith(".pptx")) destination = vscode.Uri.file(`${destination.fsPath}.pptx`);

  try {
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Exporting editable PowerPoint", cancellable: false },
      () => buildPptxExport(deck, deckPath, destination!.fsPath, workspaceRoots(deckPath))
    );
    const summary = `Exported ${path.basename(destination.fsPath)} with ${result.nativeObjectCount} native editable object${result.nativeObjectCount === 1 ? "" : "s"}.`;
    if (!result.warnings.length) {
      void vscode.window.showInformationMessage(summary);
      return;
    }
    const channel = powerPointReportChannel(context);
    channel.clear();
    channel.appendLine(`SlidePix PowerPoint export: ${destination.fsPath}`);
    channel.appendLine(`${result.slideCount} slide${result.slideCount === 1 ? "" : "s"}, ${result.nativeObjectCount} native object${result.nativeObjectCount === 1 ? "" : "s"}`);
    channel.appendLine("");
    for (const warning of result.warnings) {
      const location = [warning.slideId ? `slide ${warning.slideId}` : undefined, warning.elementId ? `element ${warning.elementId}` : undefined].filter(Boolean).join(", ");
      channel.appendLine(`- [${warning.code}]${location ? ` (${location})` : ""} ${warning.message}`);
    }
    const action = await vscode.window.showWarningMessage(`${summary} ${result.warnings.length} approximation warning${result.warnings.length === 1 ? "" : "s"}.`, "Show Details");
    if (action === "Show Details") channel.show(true);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown export error";
    void vscode.window.showErrorMessage(`Could not export PowerPoint: ${message}`);
  }
}

function powerPointReportChannel(context: vscode.ExtensionContext): vscode.OutputChannel {
  if (!reportChannel) {
    reportChannel = vscode.window.createOutputChannel("SlidePix PowerPoint Export");
    context.subscriptions.push(reportChannel);
  }
  return reportChannel;
}
