import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import * as path from "node:path";
import type { ManimElement, ManimOrientation, ManimQuality } from "@slidepix/core";
import {
  MANIM_QUALITY_FLAG,
  manimRenderFingerprint,
  manimRenderResolution,
  manimSettingsFingerprint
} from "@slidepix/core/manim";

export type ManimLaunch = {
  command: string;
  args: string[];
  cwd?: string;
};

export type ManimRenderOptions = {
  scriptPath: string;
  scene: string;
  output: ManimElement["output"];
  orientation: ManimOrientation;
  quality: ManimQuality;
  transparent: boolean;
  mediaDir: string;
  outputName: string;
};

export function findVenvManimNear(startDirectory: string, exists: (target: string) => boolean = existsSync): string | undefined {
  let directory = path.resolve(startDirectory);
  const { root } = path.parse(directory);
  while (true) {
    const candidate = path.join(directory, ".venv", "bin", "manim");
    if (exists(candidate)) return candidate;
    if (directory === root) break;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

export function findUvWorkspaceRoot(startDirectory: string, exists: (target: string) => boolean = existsSync): string | undefined {
  let directory = path.resolve(startDirectory);
  const { root } = path.parse(directory);
  while (true) {
    if (exists(path.join(directory, ".venv"))) return directory;
    if (directory === root) break;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

export function resolveManimLaunch(
  deckPath: string,
  configuredExecutable = "",
  exists: (target: string) => boolean = existsSync
): ManimLaunch {
  const configured = configuredExecutable.trim();
  if (configured) {
    if (configured.includes(" ")) {
      const tokens = configured.split(/\s+/).filter(Boolean);
      return { command: tokens[0]!, args: tokens.slice(1) };
    }
    return { command: configured, args: [] };
  }
  const deckDirectory = path.dirname(path.resolve(deckPath));
  const venvManim = findVenvManimNear(deckDirectory, exists);
  if (venvManim) return { command: venvManim, args: [] };
  const uvRoot = findUvWorkspaceRoot(deckDirectory, exists);
  if (uvRoot) return { command: "uv", args: ["run", "manim"], cwd: uvRoot };
  return { command: "manim", args: [] };
}

export function assembleManimInvocation(launch: ManimLaunch, renderArgs: string[]): ManimLaunch {
  return { command: launch.command, args: [...launch.args, ...renderArgs], cwd: launch.cwd };
}

const SCENE_PATTERN = /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*Scene[^)]*\)\s*:/gm;
const MEDIA_EXTENSIONS = new Set([".png", ".mp4", ".webm", ".gif", ".mov"]);

export function discoverManimScenes(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(SCENE_PATTERN)) {
    if (match[1]) names.add(match[1]);
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

export function scriptContentFingerprint(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

export function renderFingerprintForElement(element: ManimElement, scriptSource: string): string {
  return manimRenderFingerprint(manimSettingsFingerprint(element), scriptContentFingerprint(scriptSource));
}

export function buildManimRenderArgs(options: ManimRenderOptions): string[] {
  const quality = MANIM_QUALITY_FLAG[options.quality];
  const format = options.output === "image"
    ? "png"
    : options.transparent
      ? "webm"
      : "mp4";
  const { width, height } = manimRenderResolution(options.orientation, options.quality);
  const argv = [
    "render",
    quality,
    "-r",
    `${width},${height}`,
    "--media_dir",
    options.mediaDir,
    "-o",
    options.outputName,
    `--format=${format}`
  ];
  if (options.output === "image") argv.push("-s");
  argv.push(options.scriptPath, options.scene);
  return argv;
}

export function buildManimArgv(launch: ManimLaunch, options: ManimRenderOptions): ManimLaunch {
  return assembleManimInvocation(launch, buildManimRenderArgs(options));
}

export async function findRenderedMedia(mediaDir: string, outputName: string): Promise<string | undefined> {
  const targetBase = outputName.replace(/\.[^.]+$/, "");
  const candidates: { filePath: string; mtimeMs: number }[] = [];

  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(filePath);
        continue;
      }
      const extension = path.extname(entry.name).toLowerCase();
      if (!MEDIA_EXTENSIONS.has(extension)) continue;
      const base = path.basename(entry.name, extension);
      if (base !== outputName && base !== targetBase && !entry.name.includes(outputName)) continue;
      const fileStat = await stat(filePath);
      candidates.push({ filePath, mtimeMs: fileStat.mtimeMs });
    }
  }

  await walk(mediaDir);
  if (candidates.length) {
    candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
    return candidates[0]?.filePath;
  }
  return collectLatestMedia(mediaDir);
}

async function collectLatestMedia(mediaDir: string): Promise<string | undefined> {
  const files: { filePath: string; mtimeMs: number }[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(filePath);
        continue;
      }
      const extension = path.extname(entry.name).toLowerCase();
      if (!MEDIA_EXTENSIONS.has(extension)) continue;
      const fileStat = await stat(filePath);
      files.push({ filePath, mtimeMs: fileStat.mtimeMs });
    }
  }
  try {
    await walk(mediaDir);
  } catch {
    return undefined;
  }
  files.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return files[0]?.filePath;
}
