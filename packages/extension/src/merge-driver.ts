import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mergeDecks, parseDeckText } from "@slidepix/core";

const [basePath, oursPath, theirsPath] = process.argv.slice(2);
if (!basePath || !oursPath || !theirsPath) {
  process.stderr.write("Usage: slidepix-merge-driver <base> <ours> <theirs>\n");
  process.exit(2);
}

const baseText = readFileSync(basePath, "utf8");
const oursText = readFileSync(oursPath, "utf8");
const theirsText = readFileSync(theirsPath, "utf8");
const base = parseDeckText(baseText);
const ours = parseDeckText(oursText);
const theirs = parseDeckText(theirsText);

if (base.ok && ours.ok && theirs.ok) {
  const result = mergeDecks(base.deck, ours.deck, theirs.deck);
  if (result.ok) {
    writeFileSync(oursPath, result.text, "utf8");
    process.exit(0);
  }
  process.stderr.write(`SlidePix semantic merge found ${result.conflicts.length} conflict${result.conflicts.length === 1 ? "" : "s"}; falling back to Git conflict markers.\n`);
} else {
  process.stderr.write("SlidePix could not parse one or more merge inputs; falling back to Git conflict markers.\n");
}

const fallback = spawnSync("git", ["merge-file", "-L", "ours", "-L", "base", "-L", "theirs", oursPath, basePath, theirsPath], { stdio: "inherit" });
if (fallback.status === 0) {
  writeFileSync(oursPath, `<<<<<<< ours\n${withFinalNewline(oursText)}||||||| base\n${withFinalNewline(baseText)}=======\n${withFinalNewline(theirsText)}>>>>>>> theirs\n`, "utf8");
}
process.exit(fallback.status && fallback.status > 0 ? fallback.status : 1);

function withFinalNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}
