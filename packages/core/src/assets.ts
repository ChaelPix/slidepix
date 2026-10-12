import path from "node:path";
import type { Deck, MediaStorage } from "./schema.js";

export type DeckMediaReference = { reference: string; storage: MediaStorage };

export function mediaReferenceKey(reference: string, storage: MediaStorage): string {
  return `${storage}\0${reference}`;
}

/** Media the deck actually points at. Hidden slides and elements are skipped unless requested. */
export function deckMediaReferences(deck: Deck, options?: { includeHidden?: boolean }): Map<string, DeckMediaReference> {
  const includeHidden = options?.includeHidden ?? false;
  const references = new Map<string, DeckMediaReference>();
  const add = (reference: string, storage: MediaStorage) => {
    references.set(mediaReferenceKey(reference, storage), { reference, storage });
  };
  for (const slide of deck.slides) {
    if (slide.hidden && !includeHidden) continue;
    if (slide.backgroundImage) add(slide.backgroundImage.src, slide.backgroundImage.storage);
    for (const element of slide.elements) {
      if (element.hidden && !includeHidden) continue;
      if (element.type === "manim") {
        if (element.outputMedia) add(element.outputMedia.src, element.outputMedia.storage);
        continue;
      }
      if (element.type !== "image" && element.type !== "video") continue;
      add(element.src, element.storage);
      if (element.type === "video" && element.poster) add(element.poster, "embedded");
    }
  }
  return references;
}

export function deckAssetDirectory(deckPath: string): string {
  const suffix = ".slidepix.json";
  const base = deckPath.endsWith(suffix) ? deckPath.slice(0, -suffix.length) : deckPath;
  return `${base}.assets`;
}

export function normalizeAssetReference(reference: string): string {
  return reference.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function resolveAssetPath(deckPath: string, reference: string): string {
  const normalized = normalizeAssetReference(reference);
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0")) {
    throw new Error("Asset path must be relative");
  }
  const root = path.resolve(deckAssetDirectory(deckPath));
  const resolved = path.resolve(root, normalized);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("Asset path escapes the deck asset directory");
  }
  return resolved;
}

export function resolveMediaPath(
  deckPath: string,
  reference: string,
  storage: MediaStorage = "embedded",
  allowedLinkedRoots: string[] = [path.dirname(deckPath)]
): string {
  if (storage === "embedded") return resolveAssetPath(deckPath, reference);
  const normalized = normalizeAssetReference(reference);
  if (!normalized || normalized.startsWith("/") || /^[a-z]:\//i.test(normalized) || normalized.includes("\0")) {
    throw new Error("Linked media path must be relative");
  }
  const resolved = path.resolve(path.dirname(deckPath), normalized);
  const roots = allowedLinkedRoots.map((root) => path.resolve(root));
  if (!roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))) {
    throw new Error("Linked media path escapes the allowed workspace roots");
  }
  return resolved;
}
