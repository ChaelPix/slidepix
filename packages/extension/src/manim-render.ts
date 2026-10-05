import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import * as path from "node:path";
import type { ManimElement, ManimQuality } from "@slidepix/core";
import { MANIM_QUALITY_FLAG, manimRenderFingerprint, manimSettingsFingerprint } from "@slidepix/core/manim";

export type ManimRenderOptions = {
  executable: string;
  scriptPath: string;
  scene: string;
  output: ManimElement["output"];
  quality: ManimQuality;
  transparent: boolean;
  mediaDir: string;
  outputName: string;
};

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

export function buildManimArgv(options: ManimRenderOptions): string[] {
  const quality = MANIM_QUALITY_FLAG[options.quality];
  const format = options.output === "image"
    ? "png"
    : options.transparent
      ? "webm"
      : "mp4";
  const argv = [
    options.executable,
    "render",
    quality,
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
