import { describe, expect, it } from "vitest";
import path from "node:path";
import { createDeck, duplicateSlide, fitAspectBoxInSlide, parseDeckText, serializeDeck } from "./schema.js";
import { renderDeckDocument, renderMarkdown } from "./render.js";
import { resolveAssetPath, resolveMediaPath } from "./assets.js";

describe("deck schema", () => {
  it("round trips a new deck", () => {
    const deck = createDeck("Product demo");
    const parsed = parseDeckText(serializeDeck(deck));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.deck.metadata.title).toBe("Product demo");
  });

  it("rejects duplicate identities and dangling references", () => {
    const duplicateSlides = createDeck();
    duplicateSlides.slides.push(structuredClone(duplicateSlides.slides[0]!));
    expect(parseDeckText(JSON.stringify(duplicateSlides))).toMatchObject({ ok: false });

    const duplicateElements = createDeck();
    duplicateElements.slides[0]!.elements.push(structuredClone(duplicateElements.slides[0]!.elements[0]!));
    expect(parseDeckText(JSON.stringify(duplicateElements))).toMatchObject({ ok: false });

    const danglingAnimation = createDeck();
    danglingAnimation.slides[0]!.timeline.push({ id: "animation", targetElementId: "missing", phase: "entrance", effect: "fade", trigger: "onClick", delayMs: 0, durationMs: 500, easing: "ease-out" });
    expect(parseDeckText(JSON.stringify(danglingAnimation))).toMatchObject({ ok: false });

    const duplicateAnimations = createDeck();
    const elementId = duplicateAnimations.slides[0]!.elements[0]!.id;
    const step = { id: "animation", targetElementId: elementId, phase: "entrance" as const, effect: "fade" as const, trigger: "onClick" as const, delayMs: 0, durationMs: 500, easing: "ease-out" };
    duplicateAnimations.slides[0]!.timeline.push(step, { ...step });
    expect(parseDeckText(JSON.stringify(duplicateAnimations))).toMatchObject({ ok: false });
  });

  it("rejects unknown layouts", () => {
    const deck = createDeck();
    deck.slides[0]!.layout = "missing";
    const result = parseDeckText(JSON.stringify(deck));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("Unknown layout");
  });

  it("creates a portable light deck by default", () => {
    const deck = createDeck();
    const title = deck.slides[0]!.elements[0];

    expect(deck.theme).toMatchObject({ background: "#ffffff", foreground: "#111827" });
    expect(deck.theme.fontFamily).toContain("system-ui");
    expect(title).toMatchObject({ type: "text", style: { color: "#111827" } });
  });

  it("rejects malformed and future decks", () => {
    expect(parseDeckText("{").ok).toBe(false);
    expect(parseDeckText('{"schemaVersion":99}')).toMatchObject({ ok: false });
  });

  it("keeps morph keys but replaces element ids when duplicating", () => {
    const slide = createDeck().slides[0]!;
    const copy = duplicateSlide(slide);
    expect(copy.id).not.toBe(slide.id);
    expect(copy.elements[0]!.id).not.toBe(slide.elements[0]!.id);
    expect(copy.elements[0]!.morphKey).toBe(slide.elements[0]!.morphKey);
  });

  it("blocks asset traversal", () => {
    expect(() => resolveAssetPath("/tmp/talk.slidepix.json", "../secret")).toThrow(/escapes/);
  });

  it("resolves linked media only inside explicitly allowed workspace roots", () => {
    const workspace = path.resolve("/workspace");
    const deckPath = path.join(workspace, "decks", "talk.slidepix.json");

    expect(resolveMediaPath(deckPath, "../media/chart.png", "linked", [workspace]))
      .toBe(path.join(workspace, "media", "chart.png"));
    expect(() => resolveMediaPath(deckPath, "../../../secret", "linked", [workspace]))
      .toThrow(/workspace roots/);
  });

  it("treats media from older decks without a storage field as embedded", () => {
    const deck = createDeck();
    deck.slides[0]!.elements = [{
      id: "legacy-image", morphKey: "legacy-morph", type: "image", src: "legacy.png",
      x: 0, y: 0, width: 100, height: 100, rotation: 0, opacity: 1, z: 0, locked: false, hidden: false,
      crop: { x: 0, y: 0, width: 1, height: 1 }, borderRadius: 0, edgeFade: 0, border: { width: 0, color: "transparent" }
    } as typeof deck.slides[0]["elements"][number]];
    const raw = JSON.parse(JSON.stringify(deck));
    delete raw.slides[0].elements[0].storage;
    const parsed = parseDeckText(JSON.stringify(raw));

    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.deck.slides[0]!.elements[0]).toMatchObject({ storage: "embedded" });
  });

  it("treats slide background images without a storage field as embedded", () => {
    const raw = JSON.parse(serializeDeck(createDeck()));
    raw.slides[0].backgroundImage = { src: "background.png" };
    const parsed = parseDeckText(JSON.stringify(raw));

    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.deck.slides[0]!.backgroundImage).toEqual({ src: "background.png", storage: "embedded" });
  });

  it("adds a disabled shadow to shapes from older decks", () => {
    const deck = createDeck();
    const raw = JSON.parse(serializeDeck(deck));
    raw.slides[0].elements.push({
      id: "legacy-shape", morphKey: "legacy-shape-morph", type: "shape", shape: "rectangle",
      x: 0, y: 0, width: 100, height: 100, rotation: 0, opacity: 1, z: 1, locked: false, hidden: false,
      fill: "transparent", stroke: "transparent", strokeWidth: 0, borderRadius: 0
    });
    const parsed = parseDeckText(JSON.stringify(raw));

    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.deck.slides[0]!.elements.at(-1)).toMatchObject({ type: "shape", shadow: { enabled: false } });
  });

  it("derives a locked image height from its width and source ratio", () => {
    const raw = JSON.parse(serializeDeck(createDeck()));
    raw.slides[0].elements.push({
      id: "locked-image", morphKey: "locked-image", type: "image", src: "photo.png",
      x: 0, y: 0, width: 400, height: 10, z: 1,
      lockAspectRatio: true, aspectRatio: 2
    });
    const parsed = parseDeckText(JSON.stringify(raw));

    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.deck.slides[0]!.elements.at(-1)).toMatchObject({ width: 400, height: 200, lockAspectRatio: true });
  });

  it("normalizes a table with editable Markdown cells", () => {
    const deck = createDeck();
    const raw = JSON.parse(serializeDeck(deck));
    raw.slides[0].elements.push({
      id: "table-1", morphKey: "table-morph", type: "table",
      x: 100, y: 100, width: 800, height: 400, rotation: 0, opacity: 1, z: 1, locked: false, hidden: false,
      rows: 2, columns: 2, cells: [["**Name**", "Value"], ["Alpha", "$x^2$"]]
    });
    const parsed = parseDeckText(JSON.stringify(raw));

    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.deck.slides[0]!.elements.at(-1)).toMatchObject({ type: "table", rows: 2, columns: 2, headerRow: true, style: { borderWidth: 2 } });
  });

  it("keeps page numbers on and fits a locked picture inside the slide", () => {
    const deck = createDeck("Numbers");
    deck.pageNumbers.enabled = false;
    deck.slides[0]!.hidePageNumber = true;
    const parsed = parseDeckText(serializeDeck(deck));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.deck.pageNumbers.enabled).toBe(true);
    expect(parsed.deck.slides[0]!.hidePageNumber).toBe(false);
    const fitted = fitAspectBoxInSlide({ x: 100, y: 900, width: 1000, height: 100 }, 0.5, { width: 1920, height: 1080 });
    expect(fitted).toEqual({ x: 100, y: 0, width: 540, height: 1080 });
  });

  it("renders LaTeX as portable MathML", () => {
    expect(renderMarkdown("$x^2$")).toContain("<math");
  });

  it("emits syntactically valid presentation runtime code", () => {
    const html = renderDeckDocument(createDeck(), undefined, { mode: "present" });
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Function(script!)).not.toThrow();
  });
});
