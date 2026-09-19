const DECK_SUFFIX = ".slidepix.json";

export function uniqueDeckFilename(existingNames: Iterable<string>, stem = "untitled"): string {
  const taken = new Set([...existingNames].map((name) => name.toLowerCase()));
  const first = `${stem}${DECK_SUFFIX}`;
  if (!taken.has(first)) return first;
  for (let n = 2; ; n += 1) {
    const candidate = `${stem}-${n}${DECK_SUFFIX}`;
    if (!taken.has(candidate)) return candidate;
  }
}
