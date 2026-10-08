import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { parseDeckText, type Deck } from "@slidepix/core";
import { deckMediaReferences, resolveMediaPath, type DeckMediaReference } from "@slidepix/core/assets";
import { LIVE_LIMITS } from "./limits";

export function deckRelativePath(deckFsPath: string, workspaceRoots: string[]): string {
  const resolved = path.resolve(deckFsPath);
  const root = workspaceRoots.map((item) => path.resolve(item)).find((item) => resolved === item || resolved.startsWith(`${item}${path.sep}`));
  if (!root) return path.basename(resolved);
  return path.relative(root, resolved).split(path.sep).join("/");
}

export function mirrorPaths(storageRoot: string, relativeDeck: string): { workspace: string; deckPath: string } {
  const workspace = path.join(storageRoot, "workspace");
  const deckPath = path.resolve(workspace, ...relativeDeck.split("/"));
  if (deckPath !== workspace && !deckPath.startsWith(`${workspace}${path.sep}`)) {
    throw new Error("Live mirror path escapes the session workspace.");
  }
  return { workspace, deckPath };
}

export async function writeMirroredBytes(deckPath: string, item: DeckMediaReference, bytes: Uint8Array, linkedRoots: string[], expectedSha256?: string): Promise<void> {
  if (bytes.byteLength > LIVE_LIMITS.maxAssetBytes) throw new Error("Media files are limited to 100 MB.");
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (expectedSha256 && hash !== expectedSha256) throw new Error("The received media did not match its checksum.");
  const destination = resolveMediaPath(deckPath, item.reference, item.storage, linkedRoots);
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.partial`;
  await writeFile(temporary, bytes);
  await rename(temporary, destination);
}

export function referencedMedia(deck: Deck): DeckMediaReference[] {
  return [...deckMediaReferences(deck, { includeHidden: true }).values()];
}

export async function missingMedia(deckPath: string, deck: Deck, linkedRoots: string[]): Promise<DeckMediaReference[]> {
  const missing: DeckMediaReference[] = [];
  for (const item of referencedMedia(deck)) {
    try {
      const target = resolveMediaPath(deckPath, item.reference, item.storage, linkedRoots);
      await stat(target);
    } catch {
      missing.push(item);
    }
  }
  return missing;
}

export async function removeStaleMirrors(root: string, maxAgeMs = LIVE_LIMITS.mirrorMaxAgeMs, now = Date.now()): Promise<void> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await Promise.all(names.map(async (name) => {
    const target = path.join(root, name);
    const info = await stat(target);
    if (!info.isDirectory()) return;
    if (now - info.mtimeMs > maxAgeMs) await rm(target, { recursive: true, force: true });
  }));
}

export async function copyDeckSnapshot(deckPath: string, destinationDir: string, linkedRoots: string[]): Promise<void> {
  const text = await readFile(deckPath, "utf8");
  const parsed = parseDeckText(text);
  await mkdir(destinationDir, { recursive: true });
  const destinationDeck = path.join(destinationDir, path.basename(deckPath));
  await writeFile(destinationDeck, text, "utf8");
  if (!parsed.ok) return;
  for (const item of referencedMedia(parsed.deck)) {
    let source: string;
    try {
      source = resolveMediaPath(deckPath, item.reference, item.storage, linkedRoots);
    } catch {
      continue;
    }
    let target: string;
    try {
      target = resolveMediaPath(destinationDeck, item.reference, item.storage, [destinationDir]);
    } catch {
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await readFile(source));
  }
}
