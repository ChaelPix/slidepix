import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createDeck, duplicateSlide, elementSchema } from "@slidepix/core";
import { deckAssetDirectory } from "@slidepix/core/assets";
import { buildWebExport, WebExportDestinationExistsError } from "./web-export";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("standalone web export", () => {
  it("renders visible slides and copies referenced assets into a portable deduplicated bundle", async () => {
    const root = await temporaryRoot();
    const deckPath = path.join(root, "talk.slidepix.json");
    const embeddedDirectory = deckAssetDirectory(deckPath);
    const linkedDirectory = path.join(root, "workspace-media");
    await mkdir(embeddedDirectory);
    await mkdir(linkedDirectory);
    await writeFile(path.join(embeddedDirectory, "picture.png"), "same-image-bytes");
    await writeFile(path.join(embeddedDirectory, "poster.png"), "poster-bytes");
    await writeFile(path.join(linkedDirectory, "duplicate.png"), "same-image-bytes");
    await writeFile(path.join(linkedDirectory, "clip.mp4"), "video-bytes");

    const deck = createDeck("Portable deck");
    deck.slides[0]!.notes = "private speaker notes";
    deck.slides[0]!.backgroundImage = { src: "picture.png", storage: "embedded" };
    deck.slides[0]!.elements.push(
      elementSchema.parse({ id: "embedded-image", morphKey: "embedded-image", type: "image", src: "picture.png", storage: "embedded", x: 0, y: 0, width: 100, height: 100, z: 1 }),
      elementSchema.parse({ id: "linked-image", morphKey: "linked-image", type: "image", src: "workspace-media/duplicate.png", storage: "linked", x: 100, y: 0, width: 100, height: 100, z: 2 }),
      elementSchema.parse({ id: "linked-video", morphKey: "linked-video", type: "video", src: "workspace-media/clip.mp4", storage: "linked", poster: "poster.png", x: 0, y: 100, width: 200, height: 100, z: 3, playback: {} })
    );
    const hidden = duplicateSlide(deck.slides[0]!);
    hidden.id = "hidden-slide";
    hidden.hidden = true;
    hidden.elements = [elementSchema.parse({ id: "hidden-image", morphKey: "hidden-image", type: "image", src: "missing.png", storage: "embedded", x: 0, y: 0, width: 100, height: 100, z: 1 })];
    deck.slides.push(hidden);

    const destination = path.join(root, "talk-web");
    const result = await buildWebExport(deck, deckPath, destination, [root]);
    const html = await readFile(path.join(destination, "index.html"), "utf8");
    const assets = await readdir(path.join(destination, "assets"));

    expect(result.assetCount).toBe(3);
    expect(assets).toHaveLength(3);
    expect(assets).toContain(`${sha256("same-image-bytes")}.png`);
    expect(assets).toContain(`${sha256("poster-bytes")}.png`);
    expect(assets).toContain(`${sha256("video-bytes")}.mp4`);
    expect(await readFile(path.join(destination, "assets", `${sha256("video-bytes")}.mp4`), "utf8")).toBe("video-bytes");
    expect(html).toContain('body class="mode-present"');
    expect(html).toContain("data-slidepix-offline-controller");
    expect(html).toContain("window.slidepixAdvance?.()");
    expect(html).toContain("window.slidepixShow?.(index,'final')");
    expect(html).toContain("requestFullscreen?.()");
    expect(html).toContain(`assets/${sha256("same-image-bytes")}.png`);
    expect(html).toContain("background-image:url");
    expect(html).toContain(`assets/${sha256("poster-bytes")}.png`);
    expect(html).toContain(`assets/${sha256("video-bytes")}.mp4`);
    expect(html).not.toContain("workspace-media");
    expect(html).not.toContain(root);
    expect(html).not.toContain("private speaker notes");
    expect(html).not.toContain("hidden-slide");
    expect(html).not.toContain("missing.png");
    expect(html).not.toContain("WebSocket");
    expect(html).not.toContain("127.0.0.1");
  });

  it("rejects an existing destination without changing it", async () => {
    const root = await temporaryRoot();
    const destination = path.join(root, "already-there");
    await mkdir(destination);
    await writeFile(path.join(destination, "keep.txt"), "keep me");

    await expect(buildWebExport(createDeck("Collision"), path.join(root, "talk.slidepix.json"), destination, [root]))
      .rejects.toBeInstanceOf(WebExportDestinationExistsError);
    expect(await readFile(path.join(destination, "keep.txt"), "utf8")).toBe("keep me");
    expect(await readdir(root)).toEqual(["already-there"]);
  });

  it("removes staging output when an asset is missing or escapes its allowed root", async () => {
    const root = await temporaryRoot();
    const deckPath = path.join(root, "talk.slidepix.json");
    const destination = path.join(root, "talk-web");
    const deck = createDeck("Unsafe media");
    deck.slides[0]!.elements.push(elementSchema.parse({
      id: "unsafe-image", morphKey: "unsafe-image", type: "image", src: "../outside.png", storage: "linked",
      x: 0, y: 0, width: 100, height: 100, z: 1
    }));

    await expect(buildWebExport(deck, deckPath, destination, [path.join(root, "workspace")])).rejects.toThrow("escapes the allowed workspace roots");
    expect(await pathExistsForTest(destination)).toBe(false);
    expect((await readdir(root)).some((name) => name.startsWith(".talk-web-"))).toBe(false);
  });

  it("removes staging output when a referenced asset is missing", async () => {
    const root = await temporaryRoot();
    const deckPath = path.join(root, "talk.slidepix.json");
    const destination = path.join(root, "talk-web");
    const deck = createDeck("Missing media");
    deck.slides[0]!.elements.push(elementSchema.parse({
      id: "missing-image", morphKey: "missing-image", type: "image", src: "missing.png", storage: "embedded",
      x: 0, y: 0, width: 100, height: 100, z: 1
    }));

    await expect(buildWebExport(deck, deckPath, destination, [root])).rejects.toMatchObject({ code: "ENOENT" });
    expect(await pathExistsForTest(destination)).toBe(false);
    expect((await readdir(root)).some((name) => name.startsWith(".talk-web-"))).toBe(false);
  });
});

async function temporaryRoot(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "slidepix-web-export-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function pathExistsForTest(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
