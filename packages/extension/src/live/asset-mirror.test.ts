import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createDeck, serializeDeck } from "@slidepix/core";
import { copyDeckSnapshot, deckRelativePath, mirrorPaths, removeStaleMirrors, writeMirroredBytes } from "./asset-mirror";

describe("asset mirror", () => {
  it("rejects a mirror path that escapes the session workspace", () => {
    expect(() => mirrorPaths("/tmp/session", "../outside.slidepix.json")).toThrow(/escapes/);
  });

  it("writes only inside the resolved media path and checks the checksum", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "slidepix-live-"));
    const deckPath = path.join(root, "talk.slidepix.json");
    await writeFile(deckPath, serializeDeck(createDeck("Mirror")));
    await expect(writeMirroredBytes(deckPath, { reference: "../secret.png", storage: "embedded" }, Buffer.from("nope"), [root])).rejects.toThrow();
    await writeMirroredBytes(deckPath, { reference: "picture.png", storage: "embedded" }, Buffer.from("pixels"), [root]);
  });

  it("refuses a checksum mismatch and copies a referenced file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "slidepix-live-"));
    const deckPath = path.join(root, "talk.slidepix.json");
    const deck = createDeck("Mirror");
    deck.slides[0]!.elements.push({
      ...deck.slides[0]!.elements[0]!,
      id: "image-1",
      morphKey: "image-1",
      type: "image",
      src: "picture.png",
      storage: "embedded",
      crop: { x: 0, y: 0, width: 1, height: 1 },
      borderRadius: 0,
      edgeFade: 0,
      border: { width: 0, color: "transparent" },
      lockAspectRatio: true
    });
    await writeFile(deckPath, serializeDeck(deck));
    const assetDir = path.join(root, "talk.assets");
    await writeMirroredBytes(deckPath, { reference: "picture.png", storage: "embedded" }, Buffer.from("pixels"), [root]);
    await expect(writeMirroredBytes(deckPath, { reference: "picture.png", storage: "embedded" }, Buffer.from("pixels"), [root], "0".repeat(64))).rejects.toThrow(/checksum/);
    const destination = await mkdtemp(path.join(tmpdir(), "slidepix-copy-"));
    await copyDeckSnapshot(deckPath, destination, [root]);
    expect(await readFile(path.join(destination, "talk.assets", "picture.png"), "utf8")).toBe("pixels");
    expect(deckRelativePath(deckPath, [root])).toBe("talk.slidepix.json");
    const stale = path.join(root, "old-session");
    await writeFile(path.join(root, "keep.txt"), "x");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(stale));
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await import("node:fs/promises").then(({ utimes }) => utimes(stale, old, old));
    await removeStaleMirrors(root);
    await expect(stat(stale)).rejects.toThrow();
    expect(assetDir).toContain("talk.assets");
  });
});
