import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createDeck, elementSchema, parseDeckText } from "@slidepix/core";
import { deckAssetDirectory } from "@slidepix/core/assets";
import { buildProjectArchive, readStoredZip } from "./project-export";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("project export", () => {
  it("packs the deck, its asset folder, and linked files that stay beside the deck", async () => {
    const root = await temporaryRoot();
    const deckPath = path.join(root, "talk.slidepix.json");
    const assets = deckAssetDirectory(deckPath);
    await mkdir(assets);
    await mkdir(path.join(root, "clips"));
    await writeFile(path.join(assets, "picture.png"), "embedded-bytes");
    await writeFile(path.join(assets, "unused.txt"), "keep-unused");
    await writeFile(path.join(root, "clips", "film.mp4"), "linked-bytes");

    const deck = createDeck("Project");
    deck.slides[0]!.elements.push(
      elementSchema.parse({ id: "picture", morphKey: "picture", type: "image", src: "picture.png", storage: "embedded", x: 0, y: 0, width: 10, height: 10, z: 1 }),
      elementSchema.parse({ id: "film", morphKey: "film", type: "video", src: "clips/film.mp4", storage: "linked", x: 0, y: 20, width: 10, height: 10, z: 2, playback: {} })
    );

    const archive = await buildProjectArchive(deck, deckPath, [root]);
    const files = readStoredZip(archive.bytes);
    expect(text(files, "talk.assets/picture.png")).toBe("embedded-bytes");
    expect(text(files, "talk.assets/unused.txt")).toBe("keep-unused");
    expect(text(files, "clips/film.mp4")).toBe("linked-bytes");
    const exported = parseDeckText(text(files, "talk.slidepix.json"));
    if (!exported.ok) throw new Error(exported.message);
    const video = exported.deck.slides[0]!.elements.find((element) => element.id === "film");
    expect(video).toMatchObject({ storage: "linked", src: "clips/film.mp4" });
  });

  it("copies media and Manim scripts from outside the deck folder into the asset directory", async () => {
    const root = await temporaryRoot();
    const deckDirectory = path.join(root, "decks");
    await mkdir(deckDirectory);
    const deckPath = path.join(deckDirectory, "talk.slidepix.json");
    await mkdir(path.join(root, "library"));
    await writeFile(path.join(root, "library", "photo.png"), "outside-photo");
    await writeFile(path.join(root, "library", "scene.py"), "class Scene: pass");
    const hiddenAsset = deckAssetDirectory(deckPath);
    await mkdir(hiddenAsset);
    await writeFile(path.join(hiddenAsset, "hidden.png"), "hidden-bytes");

    const deck = createDeck("Outside");
    deck.slides[0]!.elements.push(
      elementSchema.parse({ id: "photo", morphKey: "photo", type: "image", src: "../library/photo.png", storage: "linked", x: 0, y: 0, width: 10, height: 10, z: 1 }),
      elementSchema.parse({ id: "scene", morphKey: "scene", type: "manim", script: "../library/scene.py", x: 0, y: 20, width: 10, height: 10, z: 2 })
    );
    deck.slides.push({
      ...deck.slides[0]!,
      id: "hidden",
      hidden: true,
      elements: [elementSchema.parse({ id: "hidden-image", morphKey: "hidden-image", type: "image", src: "hidden.png", storage: "embedded", x: 0, y: 0, width: 10, height: 10, z: 1 })]
    });

    const files = readStoredZip((await buildProjectArchive(deck, deckPath, [root])).bytes);
    expect(text(files, "talk.assets/hidden.png")).toBe("hidden-bytes");
    expect(text(files, "talk.assets/linked/photo.png")).toBe("outside-photo");
    expect(text(files, "talk.assets/linked/scene.py")).toBe("class Scene: pass");
    const exported = parseDeckText(text(files, "talk.slidepix.json"));
    if (!exported.ok) throw new Error(exported.message);
    expect(exported.deck.slides[0]!.elements.find((element) => element.id === "photo")).toMatchObject({ storage: "embedded", src: "linked/photo.png" });
    expect(exported.deck.slides[0]!.elements.find((element) => element.id === "scene")).toMatchObject({ script: "talk.assets/linked/scene.py" });
  });

  it("can omit rendered Manim media, including a render file that was deleted", async () => {
    const root = await temporaryRoot();
    const deckPath = path.join(root, "talk.slidepix.json");
    const assets = deckAssetDirectory(deckPath);
    await mkdir(assets);
    await writeFile(path.join(assets, "kept.png"), "kept");
    await writeFile(path.join(assets, "Still.png"), "rendered");
    const deck = createDeck("Manim");
    deck.slides[0]!.elements.push(
      elementSchema.parse({ id: "kept", morphKey: "kept", type: "image", src: "kept.png", storage: "embedded", x: 0, y: 0, width: 10, height: 10, z: 1 }),
      elementSchema.parse({ id: "still", morphKey: "still", type: "manim", outputMedia: { src: "Still.png", storage: "embedded" }, x: 0, y: 20, width: 10, height: 10, z: 2 }),
      elementSchema.parse({ id: "deleted", morphKey: "deleted", type: "manim", outputMedia: { src: "HarmonicsStill.png", storage: "embedded" }, x: 0, y: 40, width: 10, height: 10, z: 3 })
    );

    const files = readStoredZip((await buildProjectArchive(deck, deckPath, [root], { includeManimMedia: false })).bytes);
    expect(text(files, "talk.assets/kept.png")).toBe("kept");
    expect(files.has("talk.assets/Still.png")).toBe(false);
    expect(files.has("talk.assets/HarmonicsStill.png")).toBe(false);
    const exported = parseDeckText(text(files, "talk.slidepix.json"));
    if (!exported.ok) throw new Error(exported.message);
    expect(exported.deck.slides[0]!.elements.find((element) => element.id === "still")).not.toHaveProperty("outputMedia");
    expect(exported.deck.slides[0]!.elements.find((element) => element.id === "deleted")).not.toHaveProperty("outputMedia");
    expect(deck.slides[0]!.elements.find((element) => element.id === "deleted")).toMatchObject({ outputMedia: { src: "HarmonicsStill.png" } });

    await expect(buildProjectArchive(deck, deckPath, [root], { includeManimMedia: true })).rejects.toThrow(/Missing media file: HarmonicsStill.png/);
  });

  it("rejects a symlink in the asset directory", async () => {
    const root = await temporaryRoot();
    const deckPath = path.join(root, "talk.slidepix.json");
    const assets = deckAssetDirectory(deckPath);
    await mkdir(assets);
    await writeFile(path.join(root, "secret.txt"), "secret");
    await symlink(path.join(root, "secret.txt"), path.join(assets, "secret.txt"));
    const deck = createDeck("Symlink");

    await expect(buildProjectArchive(deck, deckPath, [root])).rejects.toThrow(/symlinks/);
  });
});

function text(files: Map<string, Uint8Array>, name: string): string {
  const bytes = files.get(name);
  if (!bytes) throw new Error(`Missing ${name}`);
  return new TextDecoder().decode(bytes);
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "slidepix-project-"));
  temporaryDirectories.push(root);
  return root;
}
