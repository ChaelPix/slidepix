import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { build } from "esbuild";
import { createDeck, duplicateSlide, parseDeckText, serializeDeck } from "@slidepix/core";

vi.mock("vscode", () => ({}));

import { addManagedAttributes, MANAGED_ATTRIBUTES, ownsGitConfiguration, removeManagedAttributes } from "./git-collaboration";

let directory: string;
let driver: string;

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "slidepix git driver "));
  driver = path.join(directory, "merge-driver.cjs");
  await build({
    entryPoints: [path.resolve("src/merge-driver.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile: driver,
    alias: { "@slidepix/core": path.resolve("../core/src/index.ts") }
  });
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("Git collaboration attributes", () => {
  it("adds and removes only its idempotent managed block", () => {
    const original = "*.png binary\n";
    const configured = addManagedAttributes(original);
    expect(configured).toContain(original.trim());
    expect(configured).toContain(MANAGED_ATTRIBUTES);
    expect(addManagedAttributes(configured)).toBe(configured);
    expect(removeManagedAttributes(configured)).toBe(original);
    expect(removeManagedAttributes(original)).toBe(original);
  });

  it("recognizes only matching managed repository configuration", () => {
    expect(ownsGitConfiguration("true", "SlidePix semantic deck merge", "expected", "expected")).toBe(true);
    expect(ownsGitConfiguration("true", "Customized name", "expected", "expected")).toBe(false);
    expect(ownsGitConfiguration("true", "SlidePix semantic deck merge", "customized", "expected")).toBe(false);
    expect(ownsGitConfiguration(undefined, "SlidePix semantic deck merge", "expected", "expected")).toBe(false);
  });

  it("preserves a customized managed attributes block", () => {
    const customized = `${MANAGED_ATTRIBUTES.replace("merge=slidepix", "merge=custom")}\n`;
    expect(removeManagedAttributes(customized)).toBe(customized);
  });
});

describe("merge driver", () => {
  it("writes a clean semantic merge in a path containing spaces", async () => {
    const base = createDeck("Driver");
    base.slides[0]!.id = "slide-a";
    const second = duplicateSlide(base.slides[0]!);
    second.id = "slide-b";
    second.elements[0]!.id = "element-b";
    base.slides.push(second);
    const ours = structuredClone(base);
    const theirs = structuredClone(base);
    ours.slides[0]!.notes = "ours";
    theirs.slides[1]!.notes = "theirs";
    const paths = await writeVersions(base, ours, theirs);

    const result = spawnSync(process.execPath, [driver, paths.base, paths.ours, paths.theirs], { encoding: "utf8" });
    expect(result.status).toBe(0);
    const merged = parseDeckText(await readFile(paths.ours, "utf8"));
    expect(merged.ok).toBe(true);
    if (merged.ok) expect(merged.deck.slides.map((slide) => slide.notes)).toEqual(["ours", "theirs"]);
  });

  it("leaves standard conflict markers and exits non-zero for a true conflict", async () => {
    const base = createDeck("Driver");
    const ours = structuredClone(base);
    const theirs = structuredClone(base);
    ours.slides[0]!.title = "Ours";
    theirs.slides[0]!.title = "Theirs";
    const paths = await writeVersions(base, ours, theirs);

    const result = spawnSync(process.execPath, [driver, paths.base, paths.ours, paths.theirs], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(await readFile(paths.ours, "utf8")).toContain("<<<<<<< ours");
  });

  it("falls back to standard conflict markers for invalid input", async () => {
    const base = createDeck("Driver");
    const ours = structuredClone(base);
    const theirs = structuredClone(base);
    ours.metadata.title = "Ours";
    theirs.metadata.title = "Theirs";
    const paths = await writeVersions(base, ours, theirs);
    await writeFile(paths.base, "{ invalid json\n");

    const result = spawnSync(process.execPath, [driver, paths.base, paths.ours, paths.theirs], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(await readFile(paths.ours, "utf8")).toContain("<<<<<<< ours");
  });

  it("runs as a repository merge driver", async () => {
    const repository = path.join(directory, `repository ${crypto.randomUUID()}`);
    await import("node:fs/promises").then(({ mkdir }) => mkdir(repository));
    git(repository, ["init", "-b", "main"]);
    git(repository, ["config", "user.name", "SlidePix Test"]);
    git(repository, ["config", "user.email", "slidepix@example.invalid"]);
    const deckPath = path.join(repository, "team.slidepix.json");
    const base = createDeck("Repository");
    base.slides[0]!.id = "slide-a";
    const second = duplicateSlide(base.slides[0]!);
    second.id = "slide-b";
    second.elements[0]!.id = "element-b";
    base.slides.push(second);
    await writeFile(deckPath, serializeDeck(base));
    git(repository, ["add", "team.slidepix.json"]);
    git(repository, ["commit", "-m", "base"]);
    git(repository, ["checkout", "-b", "alice"]);
    const alice = structuredClone(base);
    alice.slides[0]!.notes = "alice";
    await writeFile(deckPath, serializeDeck(alice));
    git(repository, ["commit", "-am", "alice edit"]);
    git(repository, ["checkout", "main"]);
    const main = structuredClone(base);
    main.slides[1]!.notes = "main";
    await writeFile(deckPath, serializeDeck(main));
    git(repository, ["commit", "-am", "main edit"]);
    git(repository, ["config", "merge.slidepix.driver", `\"${process.execPath}\" \"${driver}\" \"%O\" \"%A\" \"%B\"`]);
    await writeFile(path.join(repository, ".gitattributes"), "*.slidepix.json merge=slidepix\n");
    git(repository, ["add", ".gitattributes"]);
    git(repository, ["commit", "-m", "configure driver"]);

    git(repository, ["merge", "alice", "--no-edit"]);
    const merged = parseDeckText(await readFile(deckPath, "utf8"));
    expect(merged.ok).toBe(true);
    if (merged.ok) expect(merged.deck.slides.map((slide) => slide.notes)).toEqual(["alice", "main"]);
  });
});

async function writeVersions(base: ReturnType<typeof createDeck>, ours: ReturnType<typeof createDeck>, theirs: ReturnType<typeof createDeck>) {
  const stamp = crypto.randomUUID();
  const paths = {
    base: path.join(directory, `${stamp} base.slidepix.json`),
    ours: path.join(directory, `${stamp} ours.slidepix.json`),
    theirs: path.join(directory, `${stamp} theirs.slidepix.json`)
  };
  await Promise.all([
    writeFile(paths.base, serializeDeck(base)),
    writeFile(paths.ours, serializeDeck(ours)),
    writeFile(paths.theirs, serializeDeck(theirs))
  ]);
  return paths;
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  return result.stdout;
}
