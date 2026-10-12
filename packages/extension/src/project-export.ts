import { readdir, readFile, realpath } from "node:fs/promises";
import * as path from "node:path";
import { serializeDeck, type Deck, type MediaStorage, type SlideElement } from "@slidepix/core";
import { deckAssetDirectory, resolveMediaPath } from "@slidepix/core/assets";

type StoredFile = { src: string; storage: MediaStorage };

export async function buildProjectArchive(
  deck: Deck,
  deckPath: string,
  allowedLinkedRoots: string[]
): Promise<{ bytes: Uint8Array; fileCount: number }> {
  const deckName = path.basename(deckPath);
  const assetDirectory = deckAssetDirectory(deckPath);
  const assetFolder = path.basename(assetDirectory);
  const canonicalLinkedRoots = await canonicalRoots(allowedLinkedRoots);
  const deckDirectory = await realpath(path.dirname(deckPath));
  const exported = structuredClone(deck);
  const files = new Map<string, Uint8Array>();
  const copiedOutside = new Map<string, string>();

  await copyAssetDirectory(assetDirectory, assetFolder, files);
  const assetRoots = await canonicalRoots([assetDirectory]);

  for (const slide of exported.slides) {
    if (slide.backgroundImage) {
      slide.backgroundImage = await placeMedia(slide.backgroundImage, deckPath, deckDirectory, assetFolder, allowedLinkedRoots, canonicalLinkedRoots, assetRoots, files, copiedOutside);
    }
    for (const element of slide.elements) {
      await placeElementMedia(element, deckPath, deckDirectory, assetFolder, allowedLinkedRoots, canonicalLinkedRoots, assetRoots, files, copiedOutside);
    }
  }

  const text = serializeDeck(exported);
  if (files.has(deckName)) throw new Error("A project file uses the deck filename.");
  files.set(deckName, new TextEncoder().encode(text));
  return { bytes: storedZip(files), fileCount: files.size };
}

export function storedZip(files: Iterable<[string, Uint8Array]>): Uint8Array {
  const entries = [...files];
  if (entries.length > 0xffff) throw new Error("The project archive has too many files.");
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    assertArchivePath(name);
    if (data.byteLength > 0xffffffff) throw new Error(`Project file is too large: ${name}`);
    const nameBytes = Buffer.from(name, "utf8");
    if (nameBytes.byteLength > 0xffff) throw new Error(`Project path is too long: ${name}`);
    const crc = crc32(data);
    const local = Buffer.alloc(30 + nameBytes.byteLength);
    writeUint32(local, 0, 0x04034b50);
    writeUint16(local, 4, 20);
    writeUint16(local, 6, 0x0800);
    writeUint32(local, 14, crc);
    writeUint32(local, 18, data.byteLength);
    writeUint32(local, 22, data.byteLength);
    writeUint16(local, 26, nameBytes.byteLength);
    nameBytes.copy(local, 30);
    parts.push(local, data);

    const directory = Buffer.alloc(46 + nameBytes.byteLength);
    writeUint32(directory, 0, 0x02014b50);
    writeUint16(directory, 4, 20);
    writeUint16(directory, 6, 20);
    writeUint16(directory, 8, 0x0800);
    writeUint32(directory, 16, crc);
    writeUint32(directory, 20, data.byteLength);
    writeUint32(directory, 24, data.byteLength);
    writeUint16(directory, 28, nameBytes.byteLength);
    writeUint32(directory, 42, offset);
    nameBytes.copy(directory, 46);
    central.push(directory);
    offset += local.byteLength + data.byteLength;
  }

  const centralSize = central.reduce((sum, part) => sum + part.byteLength, 0);
  const end = Buffer.alloc(22);
  writeUint32(end, 0, 0x06054b50);
  writeUint16(end, 8, entries.length);
  writeUint16(end, 10, entries.length);
  writeUint32(end, 12, centralSize);
  writeUint32(end, 16, offset);
  return Buffer.concat([...parts, ...central, end]);
}

export function readStoredZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  while (offset + 4 <= bytes.byteLength) {
    const signature = view.getUint32(offset, true);
    if (signature === 0x02014b50 || signature === 0x06054b50) break;
    if (signature !== 0x04034b50) throw new Error("Project archive is not a stored zip.");
    if (view.getUint16(offset + 8, true) !== 0) throw new Error("Project archive uses an unsupported compression method.");
    const size = view.getUint32(offset + 22, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const name = Buffer.from(bytes.subarray(nameStart, nameStart + nameLength)).toString("utf8");
    const dataStart = nameStart + nameLength + extraLength;
    files.set(name, bytes.subarray(dataStart, dataStart + size));
    offset = dataStart + size;
  }
  return files;
}

async function copyAssetDirectory(assetDirectory: string, assetFolder: string, files: Map<string, Uint8Array>): Promise<void> {
  let entries;
  try {
    entries = await readdir(assetDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(assetDirectory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Project export does not follow symlinks in the asset directory.");
    if (entry.isDirectory()) {
      await copyAssetDirectory(full, `${assetFolder}/${entry.name}`, files);
      continue;
    }
    if (!entry.isFile()) continue;
    const archivePath = `${assetFolder}/${entry.name}`;
    assertArchivePath(archivePath);
    files.set(archivePath, await readFile(full));
  }
}

async function placeElementMedia(
  element: SlideElement,
  deckPath: string,
  deckDirectory: string,
  assetFolder: string,
  allowedLinkedRoots: string[],
  canonicalLinkedRoots: string[],
  assetRoots: string[],
  files: Map<string, Uint8Array>,
  copiedOutside: Map<string, string>
): Promise<void> {
  if (element.type === "image" || element.type === "video") {
    const placed = await placeMedia(element, deckPath, deckDirectory, assetFolder, allowedLinkedRoots, canonicalLinkedRoots, assetRoots, files, copiedOutside);
    element.src = placed.src;
    element.storage = placed.storage;
    if (element.type === "video" && element.poster) {
      element.poster = (await placeMedia({ src: element.poster, storage: "embedded" }, deckPath, deckDirectory, assetFolder, allowedLinkedRoots, canonicalLinkedRoots, assetRoots, files, copiedOutside)).src;
    }
    return;
  }
  if (element.type !== "manim") return;
  if (element.outputMedia) {
    const placed = await placeMedia(element.outputMedia, deckPath, deckDirectory, assetFolder, allowedLinkedRoots, canonicalLinkedRoots, assetRoots, files, copiedOutside);
    element.outputMedia = { src: placed.src, storage: "embedded" };
  }
  if (!element.script) return;
  element.script = await placeScript(element.script, deckPath, deckDirectory, assetFolder, allowedLinkedRoots, canonicalLinkedRoots, files, copiedOutside);
}

async function placeMedia(
  media: StoredFile,
  deckPath: string,
  deckDirectory: string,
  assetFolder: string,
  allowedLinkedRoots: string[],
  canonicalLinkedRoots: string[],
  assetRoots: string[],
  files: Map<string, Uint8Array>,
  copiedOutside: Map<string, string>
): Promise<StoredFile> {
  if (media.storage === "embedded") {
    const absolute = resolveMediaPath(deckPath, media.src, "embedded", allowedLinkedRoots);
    const bytes = await readContained(absolute, assetRoots);
    const archivePath = `${assetFolder}/${media.src.replaceAll("\\", "/").replace(/^\.\//, "")}`;
    assertArchivePath(archivePath);
    files.set(archivePath, bytes);
    return media;
  }
  const relative = await linkedArchivePath(deckPath, deckDirectory, media.src, allowedLinkedRoots, canonicalLinkedRoots, files);
  if (relative) return media;
  return { src: await copyOutside(deckPath, media.src, assetFolder, allowedLinkedRoots, canonicalLinkedRoots, files, copiedOutside), storage: "embedded" };
}

async function placeScript(
  reference: string,
  deckPath: string,
  deckDirectory: string,
  assetFolder: string,
  allowedLinkedRoots: string[],
  canonicalLinkedRoots: string[],
  files: Map<string, Uint8Array>,
  copiedOutside: Map<string, string>
): Promise<string> {
  const relative = await linkedArchivePath(deckPath, deckDirectory, reference, allowedLinkedRoots, canonicalLinkedRoots, files);
  if (relative) return reference;
  const embedded = await copyOutside(deckPath, reference, assetFolder, allowedLinkedRoots, canonicalLinkedRoots, files, copiedOutside);
  return `${assetFolder}/${embedded}`;
}

async function linkedArchivePath(
  deckPath: string,
  deckDirectory: string,
  reference: string,
  allowedLinkedRoots: string[],
  canonicalLinkedRoots: string[],
  files: Map<string, Uint8Array>
): Promise<string | undefined> {
  const absolute = resolveMediaPath(deckPath, reference, "linked", allowedLinkedRoots);
  const real = await realpath(absolute);
  assertInside(real, canonicalLinkedRoots);
  const relative = path.relative(deckDirectory, real).split(path.sep).join("/");
  if (!relative || relative.startsWith("../") || relative.split("/").includes("..")) return undefined;
  assertArchivePath(relative);
  files.set(relative, await readFile(real));
  return relative;
}

async function copyOutside(
  deckPath: string,
  reference: string,
  assetFolder: string,
  allowedLinkedRoots: string[],
  canonicalLinkedRoots: string[],
  files: Map<string, Uint8Array>,
  copiedOutside: Map<string, string>
): Promise<string> {
  const absolute = resolveMediaPath(deckPath, reference, "linked", allowedLinkedRoots);
  const real = await realpath(absolute);
  assertInside(real, canonicalLinkedRoots);
  const existing = copiedOutside.get(real);
  if (existing) return existing;
  const safe = path.basename(real).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "file";
  let source = `linked/${safe}`;
  let suffix = 2;
  while (files.has(`${assetFolder}/${source}`)) {
    source = `linked/${suffix}-${safe}`;
    suffix += 1;
  }
  files.set(`${assetFolder}/${source}`, await readFile(real));
  copiedOutside.set(real, source);
  return source;
}

async function readContained(absolute: string, roots: string[]): Promise<Uint8Array> {
  const real = await realpath(absolute);
  assertInside(real, roots);
  return readFile(real);
}

async function canonicalRoots(roots: string[]): Promise<string[]> {
  return Promise.all(roots.map(async (root) => {
    try {
      return await realpath(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return path.resolve(root);
      throw error;
    }
  }));
}

function assertInside(real: string, roots: string[]): void {
  if (!roots.some((root) => real === root || real.startsWith(`${root}${path.sep}`))) {
    throw new Error("Media path escapes the allowed workspace roots.");
  }
}

function assertArchivePath(name: string): void {
  if (!name || name.startsWith("/") || name.includes("\\") || name.includes("\0")) throw new Error(`Unsafe project archive path: ${name}`);
  if (name.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`Unsafe project archive path: ${name}`);
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUint16(buffer: Buffer, offset: number, value: number): void {
  buffer.writeUInt16LE(value, offset);
}

function writeUint32(buffer: Buffer, offset: number, value: number): void {
  buffer.writeUInt32LE(value >>> 0, offset);
}
