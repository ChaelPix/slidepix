import path from "node:path";

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
