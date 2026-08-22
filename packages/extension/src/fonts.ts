import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

const KNOWN_FAMILIES = [
  "Arial", "Aptos", "Calibri", "Cambria", "Candara", "Comic Sans MS",
  "Courier New", "Georgia", "Helvetica", "Helvetica Neue", "Inter", "Menlo",
  "Monaco", "Noto Sans", "Noto Serif", "Roboto", "Segoe UI", "SF Pro Display",
  "SF Pro Text", "Tahoma", "Times New Roman", "Trebuchet MS", "Verdana"
];

const STYLE_SUFFIX = /(?:[-_ ](?:thin|extralight|ultralight|light|regular|book|medium|semibold|demibold|bold|extrabold|ultrabold|black|heavy|italic|oblique|condensed|narrow|display|text|variable))+(?:[-_ ]*)$/i;

export async function discoverSystemFontFamilies(): Promise<string[]> {
  const families = new Set(KNOWN_FAMILIES);
  let visited = 0;
  const visit = async (directory: string, depth = 0): Promise<void> => {
    if (depth > 6 || visited > 12_000) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (visited++ > 12_000) return;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target, depth + 1);
      else {
        const family = fontFamilyFromFilename(entry.name);
        if (family) families.add(family);
      }
    }
  };
  await Promise.all(systemFontDirectories().map((directory) => visit(directory)));
  return [...families].sort((a, b) => a.localeCompare(b));
}

export function fontFamilyFromFilename(filename: string): string | undefined {
  if (!/\.(?:ttf|otf|ttc)$/i.test(filename)) return undefined;
  let family = path.basename(filename, path.extname(filename)).replace(/(?<=[a-z])(?=[A-Z])/g, " ").replace(/[-_]+/g, " ");
  family = family.replace(STYLE_SUFFIX, "").replace(/\s+/g, " ").trim();
  if (family.length < 2 || /^[._]/.test(family)) return undefined;
  return family;
}

export function cssFontFamily(family: string): string {
  const fallback = /mono|code|console|courier/i.test(family) ? "monospace" : /serif|times|georgia|cambria/i.test(family) ? "serif" : "sans-serif";
  return `${JSON.stringify(family)}, ${fallback}`;
}

function systemFontDirectories(): string[] {
  if (process.platform === "darwin") return ["/System/Library/Fonts", "/Library/Fonts", path.join(homedir(), "Library/Fonts")];
  if (process.platform === "win32") return [path.join(process.env.WINDIR ?? "C:\\Windows", "Fonts"), path.join(process.env.LOCALAPPDATA ?? homedir(), "Microsoft/Windows/Fonts")];
  return ["/usr/share/fonts", "/usr/local/share/fonts", path.join(homedir(), ".local/share/fonts"), path.join(homedir(), ".fonts")];
}
