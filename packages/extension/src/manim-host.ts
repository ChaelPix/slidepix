import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { DEFAULT_MANIM_SCENE_NAME, MANIM_STARTER_SCRIPT, type Deck, type ManimElement } from "@slidepix/core";
import { resolveMediaPath } from "@slidepix/core/assets";
import { buildManimArgv, discoverManimScenes, findRenderedMedia, renderFingerprintForElement, scriptContentFingerprint } from "./manim-render.js";

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

export async function runManimRender(options: {
  deckPath: string;
  element: ManimElement;
  executable: string;
  allowedLinkedRoots: string[];
}): Promise<{ bytes: Uint8Array; fileName: string; settingsFingerprint: string }> {
  const { deckPath, element, executable, allowedLinkedRoots } = options;
  if (!element.script?.trim()) throw new Error("Choose a Manim script before rendering.");
  if (!element.scene?.trim()) throw new Error("Enter a scene class name before rendering.");
  const { absolutePath, source } = await readManimScript(deckPath, element.script, allowedLinkedRoots);
  const scenes = discoverManimScenes(source);
  if (!scenes.includes(element.scene)) {
    throw new Error(`Scene "${element.scene}" was not found in ${element.script}.`);
  }

  const mediaDir = await mkdtemp(path.join(os.tmpdir(), "slidepix-manim-"));
  const outputName = `slidepix-${element.id.replaceAll(/[^a-z0-9-]/gi, "").slice(0, 24) || "render"}`;
  const argv = buildManimArgv({
    executable,
    scriptPath: absolutePath,
    scene: element.scene,
    output: element.output,
    quality: element.quality,
    transparent: element.transparent,
    mediaDir,
    outputName
  });

  try {
    await execManim(argv);
    const rendered = await findRenderedMedia(mediaDir, outputName);
    if (!rendered) throw new Error("Manim finished without producing a media file.");
    const bytes = await readFile(rendered);
    if (bytes.byteLength > MAX_MEDIA_BYTES) throw new Error("Rendered media exceeds the 100 MB limit.");
    return {
      bytes,
      fileName: path.basename(rendered),
      settingsFingerprint: renderFingerprintForElement(element, source)
    };
  } finally {
    await rm(mediaDir, { recursive: true, force: true });
  }
}

async function execManim(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command!, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `Manim exited with code ${code ?? "unknown"}.`));
    });
  });
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
  await writeFile(absolutePath, MANIM_STARTER_SCRIPT, "utf8");
  const reference = relativeDeckReference(deckPath, absolutePath);
  const scenes = discoverManimScenes(MANIM_STARTER_SCRIPT);
  return { absolutePath, reference, scene: DEFAULT_MANIM_SCENE_NAME, scenes };
}

export function applyManimRender(deck: Deck, elementId: string, embeddedReference: string): Deck {
  const located = findManimElement(deck, elementId);
  if (!located) throw new Error("Manim element not found.");
  located.element.outputMedia = { src: embeddedReference, storage: "embedded" };
  return deck;
}

export function applyManimScript(deck: Deck, elementId: string, script: string, scene?: string): Deck {
  const located = findManimElement(deck, elementId);
  if (!located) throw new Error("Manim element not found.");
  located.element.script = script;
  if (scene) located.element.scene = scene;
  return deck;
}
