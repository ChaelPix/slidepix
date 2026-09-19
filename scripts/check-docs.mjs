import { access, readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const documents = [
  "README.md",
  "architecture.md",
  "AGENTS.md",
  "docs/development.md",
  "docs/install.md",
  "docs/format.md",
  "docs/modules/core.md",
  "docs/modules/webview.md",
  "docs/modules/extension.md",
  "docs/modules/mcp.md",
  ".cursor/rules/slidepix-development.mdc",
  ".cursor/rules/slidepix-mcp.mdc",
  ".agents/skills/slidepix-development/SKILL.md",
  ".agents/skills/slidepix-mcp-review/SKILL.md"
];
const failures = [];

for (const relative of documents) {
  const file = resolve(root, relative);
  let source;
  try {
    source = await readFile(file, "utf8");
  } catch {
    failures.push(`${relative}: required documentation file is missing`);
    continue;
  }

  for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const raw = match[1].trim().replace(/^<|>$/g, "");
    if (!raw || /^(?:https?:|mailto:|#)/.test(raw)) continue;
    const withoutFragment = decodeURIComponent(raw.split("#", 1)[0]);
    if (!withoutFragment) continue;
    try {
      await access(resolve(dirname(file), withoutFragment));
    } catch {
      failures.push(`${relative}: broken local link ${raw}`);
    }
  }

  if (extname(file) === ".mdc" && !/^---\n[\s\S]+?\n---\n/.test(source)) {
    failures.push(`${relative}: Cursor rule is missing MDC frontmatter`);
  }
  if (relative.endsWith("SKILL.md") && !/^---\nname: [^\n]+\ndescription: [^\n]+\n---\n/.test(source)) {
    failures.push(`${relative}: skill is missing required name/description frontmatter`);
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Documentation check passed (${documents.length} files).`);
}

