import { describe, expect, it } from "vitest";
import { createDeck, duplicateSlide, parseDeckText, serializeDeck } from "./schema.js";
import { renderDeckDocument, renderMarkdown } from "./render.js";
import { resolveAssetPath, resolveMediaPath } from "./assets.js";

describe("deck schema", () => {
  it("round trips a new deck", () => {
    const deck = createDeck("Research talk");
    const parsed = parseDeckText(serializeDeck(deck));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.deck.metadata.title).toBe("Research talk");
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
    expect(resolveMediaPath("/workspace/decks/talk.slidepix.json", "../media/chart.png", "linked", ["/workspace"]))
      .toBe("/workspace/media/chart.png");
    expect(() => resolveMediaPath("/workspace/decks/talk.slidepix.json", "../../../secret", "linked", ["/workspace"]))
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
