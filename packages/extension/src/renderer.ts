import { access, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import * as path from "node:path";
import * as vscode from "vscode";
import type * as Playwright from "playwright-core";
import type { Deck } from "@slidepix/core";
import { PresentationServer } from "./presentation";

export async function installRenderer(context: vscode.ExtensionContext, forcePrompt = true): Promise<string | undefined> {
  const root = vscode.Uri.joinPath(context.globalStorageUri, "playwright").fsPath;
  await mkdir(root, { recursive: true });
  process.env.PLAYWRIGHT_BROWSERS_PATH = root;
  const expected = playwright().chromium.executablePath();
  try { await access(expected); return expected; } catch { /* install below */ }
  if (forcePrompt) {
    const answer = await vscode.window.showInformationMessage(
      "SlidePix PDF/PNG export needs a pinned Chromium renderer (a few hundred MB). Download it now?",
      { modal: true },
      "Download"
    );
    if (answer !== "Download") return undefined;
  }
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Downloading SlidePix renderer", cancellable: false }, async () => {
    const cli = path.join(context.extensionUri.fsPath, "vendor", "playwright-core", "cli.js");
    await run(process.execPath, [cli, "install", "chromium"], {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PLAYWRIGHT_BROWSERS_PATH: root
    });
    await access(expected);
    return expected;
  });
}

export async function exportPdf(context: vscode.ExtensionContext, deck: Deck, deckPath: string): Promise<void> {
  const executablePath = await installRenderer(context);
  if (!executablePath) return;
  const destination = await vscode.window.showSaveDialog({
    filters: { PDF: ["pdf"] },
    defaultUri: vscode.Uri.file(deckPath.replace(/\.slidepix\.json$/i, ".pdf"))
  });
  if (!destination) return;
  const server = new PresentationServer(deck, deckPath);
  await server.start();
  const browser = await playwright().chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    await page.goto(server.url("/print"), { waitUntil: "networkidle" });
    await page.emulateMedia({ media: "screen" });
    const visibleSlideCount = Math.max(1, deck.slides.filter((slide) => !slide.hidden).length);
    await page.pdf({ path: destination.fsPath, width: `${deck.size.width}px`, height: `${deck.size.height}px`, pageRanges: `1-${visibleSlideCount}`, printBackground: true, preferCSSPageSize: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
    void vscode.window.showInformationMessage(`Exported ${path.basename(destination.fsPath)}`);
  } finally {
    await browser.close();
    server.dispose();
  }
}

export async function exportPng(context: vscode.ExtensionContext, deck: Deck, deckPath: string, slideIds?: string[]): Promise<void> {
  const executablePath = await installRenderer(context);
  if (!executablePath) return;
  const destination = await vscode.window.showSaveDialog({
    filters: { PNG: ["png"] },
    defaultUri: vscode.Uri.file(deckPath.replace(/\.slidepix\.json$/i, slideIds?.length === 1 ? `-${slideIds[0]!.slice(0, 6)}.png` : ".png"))
  });
  if (!destination) return;
  const server = new PresentationServer(deck, deckPath);
  await server.start();
  const browser = await playwright().chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: Math.max(800, deck.size.width), height: Math.max(600, deck.size.height) }, deviceScaleFactor: 1 });
    const query = slideIds?.length ? `&ids=${encodeURIComponent(slideIds.join(","))}` : "";
    await page.goto(`${server.url("/contact")}${query}`, { waitUntil: "networkidle" });
    if (slideIds?.length === 1) {
      await page.locator(".slidepix-slide").first().screenshot({ path: destination.fsPath, type: "png" });
    } else {
      await page.screenshot({ path: destination.fsPath, fullPage: true, type: "png" });
    }
    void vscode.window.showInformationMessage(`Exported ${path.basename(destination.fsPath)}`);
  } finally {
    await browser.close();
    server.dispose();
  }
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "ignore", "pipe"] });
    let errorText = "";
    child.stderr.on("data", (chunk) => { errorText += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(errorText || `Renderer installer exited with code ${code}`)));
  });
}

function playwright(): typeof Playwright {
  return require(path.join(__dirname, "..", "vendor", "playwright-core")) as typeof Playwright;
}
