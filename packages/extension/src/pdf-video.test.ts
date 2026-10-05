import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { PDFDict, PDFDocument, PDFName, PDFArray, PDFNumber } from "pdf-lib";
import { createDeck, duplicateSlide, elementSchema } from "@slidepix/core";
import { deckAssetDirectory } from "@slidepix/core/assets";
import { embedDeckVideos, videoPdfRect } from "./pdf-video";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("videoPdfRect", () => {
  it("converts top-left slide pixels into a bottom-left PDF rectangle", () => {
    expect(videoPdfRect(1920, 1080, 1440, 810, { x: 360, y: 480, width: 360, height: 220, rotation: 0 })).toEqual({
      x: 270,
      y: 285,
      width: 270,
      height: 165,
      rotation: 0
    });
  });
});

describe("embedDeckVideos", () => {
  it("embeds a visible video as a playable screen annotation and skips hidden slides", async () => {
    const root = await temporaryRoot();
    const deckPath = path.join(root, "deck.slidepix.json");
    const assets = deckAssetDirectory(deckPath);
    await mkdir(assets);
    await writeFile(path.join(assets, "clip.mp4"), "test-video-bytes");
    const deck = createDeck("Video");
    const slide = deck.slides[0]!;
    slide.elements = [
      elementSchema.parse({ id: "video", morphKey: "video", type: "video", src: "clip.mp4", storage: "embedded", x: 360, y: 480, width: 360, height: 220, z: 1, playback: { mode: "autoplay", controls: true } })
    ];
    const hidden = duplicateSlide(slide);
    hidden.hidden = true;
    hidden.elements = [elementSchema.parse({ id: "hidden-video", morphKey: "hidden-video", type: "video", src: "missing.mp4", storage: "embedded", x: 0, y: 0, width: 10, height: 10, z: 1, playback: {} })];
    deck.slides.push(hidden);

    const source = await PDFDocument.create();
    source.addPage([deck.size.width * 0.75, deck.size.height * 0.75]);
    const result = await embedDeckVideos(await source.save(), deck, deckPath, [root]);
    expect(result.embedded).toBe(1);
    expect(result.warnings).toEqual([]);
    expect(Buffer.from(result.bytes).includes(Buffer.from("test-video-bytes"))).toBe(true);

    const pdf = await PDFDocument.load(result.bytes);
    const page = pdf.getPage(0);
    const annots = page.node.lookup(PDFName.of("Annots"), PDFArray);
    expect(annots.size()).toBe(1);
    const annot = pdf.context.lookup(annots.get(0), PDFDict);
    expect(annot.get(PDFName.of("Subtype"))).toBe(PDFName.of("Screen"));
    const rect = annot.lookup(PDFName.of("Rect"), PDFArray);
    expect(numbers(rect)).toEqual([270, 285, 540, 450]);
    expect(page.node.lookup(PDFName.of("AA"), PDFDict).get(PDFName.of("O"))).toBeDefined();
  });

  it("keeps the original PDF when a video file is missing", async () => {
    const root = await temporaryRoot();
    const deckPath = path.join(root, "deck.slidepix.json");
    const deck = createDeck("Missing");
    deck.slides[0]!.elements = [
      elementSchema.parse({ id: "video", morphKey: "video", type: "video", src: "missing.mp4", storage: "embedded", x: 0, y: 0, width: 10, height: 10, z: 1, playback: {} })
    ];
    const source = await PDFDocument.create();
    source.addPage([100, 100]);
    const original = await source.save();
    const result = await embedDeckVideos(original, deck, deckPath, [root]);
    expect(result.embedded).toBe(0);
    expect(result.bytes).toBe(original);
    expect(result.warnings[0]).toMatch(/missing\.mp4/);
  });
});

function numbers(rect: PDFArray): number[] {
  return [0, 1, 2, 3].map((index) => rect.lookup(index, PDFNumber).asNumber());
}

async function temporaryRoot(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "slidepix-pdf-video-"));
  temporaryDirectories.push(directory);
  return directory;
}
