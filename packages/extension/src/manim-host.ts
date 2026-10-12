import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  DEFAULT_MANIM_SCENE_NAME,
  MANIM_STARTER_SCRIPT,
  manimElementAspectRatio,
  type Deck,
  type ManimElement
} from "@slidepix/core";
import { resolveMediaPath } from "@slidepix/core/assets";
import { buildManimArgv, discoverManimScenes, findRenderedMedia, manimDeckStem, manimOutputBasename, manimProcessEnv, manimSpawnFailure, splitManimOutput, type ManimLaunch, renderFingerprintForElement, scriptContentFingerprint } from "./manim-render.js";

const MAX_MEDIA_BYTES = 100 * 1024 * 1024;

export function findManimElement(deck: Deck, elementId: string): { slideIndex: number; element: ManimElement } | undefined {
  for (const [slideIndex, slide] of deck.slides.entries()) {
    const element = slide.elements.find((item) => item.id === elementId && item.type === "manim");
    if (element?.type === "manim") return { slideIndex, element };
  }
  return undefined;
}

export function relativeDeckReference(deckPath: string, absolutePath: string): string {
  return path.relative(path.dirname(deckPath), absolutePath).replaceAll(path.sep, "/");
}

export async function uniqueManimScriptPath(deckPath: string): Promise<string> {
  const directory = path.dirname(deckPath);
  const base = path.basename(deckPath, ".slidepix.json");
  let candidate = path.join(directory, `${base}.manim.py`);
  let counter = 2;
  while (await pathExists(candidate)) {
    candidate = path.join(directory, `${base}-${counter}.manim.py`);
    counter += 1;
  }
  return candidate;
}

export async function readManimScript(deckPath: string, scriptReference: string, allowedLinkedRoots: string[]): Promise<{ absolutePath: string; source: string }> {
  const absolutePath = resolveMediaPath(deckPath, scriptReference, "linked", allowedLinkedRoots);
  const source = await readFile(absolutePath, "utf8");
  return { absolutePath, source };
}

export async function listScenesForScript(deckPath: string, scriptReference: string, allowedLinkedRoots: string[]) {
  const { source } = await readManimScript(deckPath, scriptReference, allowedLinkedRoots);
  return { scenes: discoverManimScenes(source), contentFingerprint: scriptContentFingerprint(source) };
}

export type ManimRenderHooks = {
  onOutput?: (text: string) => void;
  onProgress?: (percent: number) => void;
  onStart?: (pid: number) => void;
  signal?: AbortSignal;
};

export class ManimCancelled extends Error {
  constructor() {
    super("Manim render cancelled.");
    this.name = "ManimCancelled";
  }
}

export function takenManimOutputStems(deck: Deck, elementId: string): string[] {
  const stems: string[] = [];
  for (const slide of deck.slides) {
    for (const element of slide.elements) {
      if (element.type !== "manim" || element.id === elementId || !element.outputMedia?.src) continue;
      const base = path.basename(element.outputMedia.src);
      stems.push(base.replace(/\.[^.]+$/, ""));
    }
  }
  return stems;
}

export async function runManimRender(options: {
  deckPath: string;
  element: ManimElement;
  slideTitle: string;
  launch: ManimLaunch;
  allowedLinkedRoots: string[];
  takenStems?: readonly string[];
  outputBasename?: string;
  hooks?: ManimRenderHooks;
}): Promise<{ bytes: Uint8Array; fileName: string; settingsFingerprint: string }> {
  const { deckPath, element, slideTitle, launch, allowedLinkedRoots, hooks } = options;
  if (!element.script?.trim()) throw new Error("Choose a Manim script before rendering.");
  if (!element.scene?.trim()) throw new Error("Enter a scene class name before rendering.");
  const { absolutePath, source } = await readManimScript(deckPath, element.script, allowedLinkedRoots);
  const scenes = discoverManimScenes(source);
  if (!scenes.includes(element.scene)) {
    throw new Error(`Scene "${element.scene}" was not found in ${element.script}.`);
  }

  const mediaDir = await mkdtemp(path.join(os.tmpdir(), "slidepix-manim-"));
  const outputName = options.outputBasename ?? manimOutputBasename(manimDeckStem(deckPath), slideTitle, element.scene, options.takenStems ?? []);
  const invocation = buildManimArgv(launch, {
    scriptPath: absolutePath,
    scene: element.scene,
    output: element.output,
    orientation: element.orientation,
    quality: element.quality,
    transparent: element.transparent,
    mediaDir,
    outputName
  });

  try {
    await execManim(invocation, hooks);
    const rendered = await findRenderedMedia(mediaDir, outputName);
    if (!rendered) throw new Error(`Manim finished without producing ${outputName}.`);
    const bytes = await readFile(rendered);
    if (bytes.byteLength > MAX_MEDIA_BYTES) throw new Error("Rendered media exceeds the 100 MB limit.");
    const extension = path.extname(rendered).toLowerCase() || (element.output === "image" ? ".png" : ".mp4");
    return {
      bytes,
      fileName: `${outputName}${extension}`,
      settingsFingerprint: renderFingerprintForElement(element, source)
    };
  } finally {
    await rm(mediaDir, { recursive: true, force: true });
  }
}

async function execManim(invocation: ManimLaunch, hooks: ManimRenderHooks = {}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (hooks.signal?.aborted) {
      reject(new ManimCancelled());
      return;
    }
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
      env: manimProcessEnv()
    });
    if (child.pid !== undefined) hooks.onStart?.(child.pid);
    let tail = "";
    let pending = "";
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const flushLog = () => {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = undefined;
      if (!pending) return;
      const text = pending;
      pending = "";
      hooks.onOutput?.(text);
    };
    const enqueueLog = (text: string) => {
      pending += text.endsWith("\n") ? text : `${text}\n`;
      if (pending.length > 100_000) pending = pending.slice(-50_000);
      if (!flushTimer) flushTimer = setTimeout(flushLog, 200);
    };
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      hooks.signal?.removeEventListener("abort", onAbort);
      flushLog();
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => {
      stopManim(child);
      finish(new ManimCancelled());
    };
    hooks.signal?.addEventListener("abort", onAbort);
    const push = (chunk: Buffer | string) => {
      const split = splitManimOutput(String(chunk));
      if (split.log || split.percent !== undefined) tail = (tail + (split.log || `${split.percent}%`)).slice(-12_000);
      if (split.log) enqueueLog(split.log);
      if (split.percent !== undefined) hooks.onProgress?.(split.percent);
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", push);
    child.stderr?.on("data", push);
    child.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        finish(new Error("Could not find Manim. Use Set up Manim to locate it, or install uv and Manim Community."));
        return;
      }
      finish(error);
    });
    child.on("close", (code) => {
      if (hooks.signal?.aborted) finish(new ManimCancelled());
      else if (code === 0) finish();
      else {
        const detail = tail.trim();
        finish(new Error(manimSpawnFailure(detail)
          ? "Manim is not installed. The virtualenv is missing or does not contain manim. Use Set up Manim to install it."
          : detail || `Manim exited with code ${code ?? "unknown"}.`));
      }
    });
  });
}

function stopManim(child: ReturnType<typeof spawn>): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(target));
    return true;
  } catch {
    return false;
  }
}

export async function createStarterScript(deckPath: string): Promise<{ absolutePath: string; reference: string; scene: string; scenes: string[] }> {
  const absolutePath = await uniqueManimScriptPath(deckPath);
  await vscode.workspace.fs.writeFile(vscode.Uri.file(absolutePath), new TextEncoder().encode(MANIM_STARTER_SCRIPT));
  const reference = relativeDeckReference(deckPath, absolutePath);
  const scenes = discoverManimScenes(MANIM_STARTER_SCRIPT);
  return { absolutePath, reference, scene: DEFAULT_MANIM_SCENE_NAME, scenes };
}

export async function deleteManimScript(absolutePath: string): Promise<void> {
  await vscode.workspace.fs.delete(vscode.Uri.file(absolutePath), { recursive: false, useTrash: false });
}

export function applyManimRender(deck: Deck, elementId: string, embeddedReference: string): Deck {
  const located = findManimElement(deck, elementId);
  if (!located) throw new Error("Manim element not found.");
  located.element.outputMedia = { src: embeddedReference, storage: "embedded" };
  if (located.element.lockAspectRatio) {
    located.element.aspectRatio = manimElementAspectRatio(located.element.orientation);
  }
  return deck;
}

export function applyManimScript(deck: Deck, elementId: string, script: string, scene?: string): Deck {
  const located = findManimElement(deck, elementId);
  if (!located) throw new Error("Manim element not found.");
  located.element.script = script;
  if (scene) located.element.scene = scene;
  return deck;
}
