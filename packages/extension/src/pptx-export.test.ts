import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import JSZip from "jszip";
import { createDeck, duplicateSlide, elementSchema } from "@slidepix/core";
import { deckAssetDirectory } from "@slidepix/core/assets";
import { buildPptxExport } from "./pptx-export";

const temporaryDirectories: string[] = [];
const onePixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("native PowerPoint export", () => {
  it("writes rich content and motion as native PowerPoint objects without screenshots", async () => {
    const root = await temporaryRoot();
    const deckPath = path.join(root, "deck.slidepix.json");
    const assets = deckAssetDirectory(deckPath);
    await mkdir(assets);
    await writeFile(path.join(assets, "image.png"), Buffer.from(onePixelPng, "base64"));
    await writeFile(path.join(assets, "poster.png"), Buffer.from(onePixelPng, "base64"));
    await writeFile(path.join(assets, "clip.mp4"), "test-video-bytes");

    const deck = createDeck("Native PowerPoint");
    const slide = deck.slides[0]!;
    slide.notes = "Presenter-only note";
    slide.transition = { type: "morph", durationMs: 600, easing: "ease-in-out" };
    slide.elements = [
      elementSchema.parse({
        id: "rich", morphKey: "rich", type: "text",
        markdown: "# Heading\n\n**Bold** *italic* ~~strike~~ [link](https://example.com) `code` before $x^2$ after\n\n```ts\nconst deck = open(\"demo.slidepix.json\");\ndeck.present();\n```\n\n$$\\frac{x}{y}$$",
        x: 20, y: 20, width: 700, height: 420, z: 1, style: {}
      }),
      elementSchema.parse({ id: "shape", morphKey: "shape", type: "shape", shape: "rectangle", x: 760, y: 20, width: 180, height: 120, z: 2, borderRadius: 18, shadow: { enabled: true } }),
      elementSchema.parse({ id: "table", morphKey: "table", type: "table", x: 760, y: 180, width: 420, height: 240, z: 3, rows: 2, columns: 2, cells: [["A", "B"], ["1", "2"]], style: {} }),
      elementSchema.parse({ id: "image", morphKey: "image", type: "image", src: "image.png", storage: "embedded", x: 20, y: 480, width: 300, height: 220, z: 4, crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, borderRadius: 24, edgeFade: 12, border: { width: 3, color: "#ff000080" } }),
      elementSchema.parse({ id: "video", morphKey: "video", type: "video", src: "clip.mp4", poster: "poster.png", storage: "embedded", x: 360, y: 480, width: 360, height: 220, z: 5, playback: { mode: "autoplay", muted: true, loop: true, controls: false } })
    ];
    slide.timeline = [
      { id: "a1", targetElementId: "rich", phase: "entrance", effect: "fade", trigger: "onClick", delayMs: 0, durationMs: 500, easing: "ease-in-out" },
      { id: "a2", targetElementId: "shape", phase: "exit", effect: "fly", trigger: "afterPrevious", direction: "left", delayMs: 100, durationMs: 400, easing: "linear" }
    ];
    const hidden = duplicateSlide(slide);
    hidden.hidden = true;
    hidden.elements = [elementSchema.parse({ id: "hidden-image", morphKey: "hidden-image", type: "image", src: "missing.png", storage: "embedded", x: 0, y: 0, width: 10, height: 10, z: 1 })];
    deck.slides.push(hidden);

    const destination = path.join(root, "native.pptx");
    const result = await buildPptxExport(deck, deckPath, destination, [root]);
    expect(result.slideCount).toBe(1);
    expect(result.nativeObjectCount).toBeGreaterThanOrEqual(6);
    expect(result.warnings.map((item) => item.code)).toEqual(expect.arrayContaining(["font-not-embedded", "edge-fade-approximated", "video-playback-approximated"]));

    const zip = await JSZip.loadAsync(await readFile(destination));
    const xml = await zip.file("ppt/slides/slide1.xml")!.async("string");
    expect(xml).toContain("<a:txBody>");
    expect(xml).toContain("<a14:m");
    expect(xml).toContain("<m:sSup>");
    expect(xml).toContain("<m:f>");
    expect(xml).toContain("<mc:Choice Requires=\"a14\"");
    expect(xml).toContain("<mc:Fallback>");
    expect(xml).toContain("<a:t>x^2</a:t>");
    expect(xml).toContain("<a:t>\\frac{x}{y}</a:t>");
    expect(xml).toContain("<a:t> before </a:t>");
    expect(xml).toContain("<a:t> after</a:t>");
    expect(xml).toContain("<p:pic>");
    expect(xml).toContain("<a:tbl>");
    expect(xml).toContain("<p159:morph");
    expect(xml).toContain("<p:timing>");
    expect(xml).toContain("filter=\"fade\"");
    expect(xml).toContain("filter=\"slide(toLeft)\"");
    expect(xml).toContain("<a:srcRect");
    expect(xml).toContain("<a:softEdge");
    expect(xml).not.toContain("SLIDEPIX_MATH_");
    expect(xml).not.toContain("SlidePix slide 1");
    for (const paragraph of xml.match(/<a:p\b[^>]*>[\s\S]*?<\/a:p>/g) ?? []) {
      expect(paragraph.match(/<a:pPr\b/g)?.length ?? 0).toBeLessThanOrEqual(1);
    }
    const codeLine = (xml.match(/<a:p\b[^>]*>[\s\S]*?<a:t>deck\.<\/a:t>[\s\S]*?<\/a:p>/g) ?? []).find((paragraph) => paragraph.includes("<a:t>present</a:t>"));
    expect(codeLine).toContain("<a:t>();</a:t>");
    expect(zip.file("ppt/slides/slide2.xml")).toBeNull();

    const mediaNames = Object.keys(zip.files).filter((name) => name.startsWith("ppt/media/") && !name.endsWith("/"));
    expect(mediaNames.some((name) => name.endsWith(".mp4"))).toBe(true);
    expect(mediaNames.length).toBeLessThanOrEqual(4);
  });

  it("rejects unsafe or missing media without replacing an existing destination", async () => {
    const root = await temporaryRoot();
    const deckPath = path.join(root, "deck.slidepix.json");
    const destination = path.join(root, "existing.pptx");
    await writeFile(destination, "keep-me");
    const deck = createDeck("Unsafe PowerPoint");
    deck.slides[0]!.elements.push(elementSchema.parse({
      id: "unsafe", morphKey: "unsafe", type: "image", src: "../outside.png", storage: "linked",
      x: 0, y: 0, width: 100, height: 100, z: 1
    }));

    await expect(buildPptxExport(deck, deckPath, destination, [path.join(root, "workspace")])).rejects.toThrow("escapes the allowed workspace roots");
    expect(await readFile(destination, "utf8")).toBe("keep-me");
    expect((await readdir(root)).some((name) => name.includes(".tmp.pptx"))).toBe(false);
  });
});

async function temporaryRoot(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "slidepix-pptx-export-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
