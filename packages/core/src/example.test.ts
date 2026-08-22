import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveMediaPath } from "./assets.js";
import { parseDeckText } from "./schema.js";

const examplePath = fileURLToPath(new URL("../../../examples/slidepix-demo.slidepix.json", import.meta.url));

describe("visual regression example", () => {
  it("stays valid, self-contained, and covers the primary authoring features", async () => {
    const parsed = parseDeckText(await readFile(examplePath, "utf8"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.message);

    const { deck } = parsed;
    const elements = deck.slides.flatMap((slide) => slide.elements);
    const text = elements.filter((element) => element.type === "text");
    const images = elements.filter((element) => element.type === "image");
    const videos = elements.filter((element) => element.type === "video");
    const shapes = elements.filter((element) => element.type === "shape");
    const tables = elements.filter((element) => element.type === "table");
    const effects = new Set(deck.slides.flatMap((slide) => slide.timeline.map((step) => step.effect)));

    expect(deck.slides).toHaveLength(7);
    expect(text.some((element) => element.markdown.includes("$$"))).toBe(true);
    expect(text.some((element) => element.markdown.includes("```typescript"))).toBe(true);
    expect(deck.theme).toMatchObject({ background: "#ffffff", foreground: "#111827" });
    expect(JSON.stringify(deck).toLowerCase()).not.toContain("research");
    expect(images.some((element) => element.border.width > 0 && element.borderRadius > 0)).toBe(true);
    expect(images.some((element) => element.edgeFade > 0 && element.crop.width < 1)).toBe(true);
    expect(videos).toHaveLength(1);
    expect(tables.some((element) => element.rows >= 4 && element.cells.some((row) => row.some((cell) => cell.includes("$x^2$"))))).toBe(true);
    expect(tables.some((element) => element.style.cellFill === "transparent")).toBe(true);
    expect(new Set(shapes.map((element) => element.shape))).toEqual(new Set(["rectangle", "ellipse", "triangle"]));
    expect(shapes.some((element) => element.shadow.enabled)).toBe(true);
    expect(effects).toEqual(new Set(["appear", "fade", "fly"]));
    expect(new Set(deck.slides.map((slide) => slide.transition.type))).toEqual(
      new Set(["none", "fade", "slide-down", "slide-right", "slide-up", "morph", "slide-left"])
    );

    const morphDestination = deck.slides.find((slide) => slide.transition.type === "morph");
    const morphSource = morphDestination && deck.slides[deck.slides.indexOf(morphDestination) - 1];
    expect(morphDestination).toBeDefined();
    expect(morphSource).toBeDefined();
    const sourceKeys = new Set(morphSource?.elements.map((element) => element.morphKey));
    expect(morphDestination?.elements.filter((element) => sourceKeys.has(element.morphKey)).length).toBeGreaterThanOrEqual(3);

    for (const media of [...images, ...videos]) {
      expect(media.storage).toBe("embedded");
      await expect(access(resolveMediaPath(examplePath, media.src, media.storage))).resolves.toBeUndefined();
      if (media.type === "video" && media.poster) {
        await expect(access(resolveMediaPath(examplePath, media.poster, media.storage))).resolves.toBeUndefined();
      }
    }
  });
});
