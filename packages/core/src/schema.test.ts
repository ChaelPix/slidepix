import { describe, expect, it } from "vitest";
import { createDeck, duplicateSlide, parseDeckText, serializeDeck } from "./schema.js";
import { renderDeckDocument, renderMarkdown } from "./render.js";
import { resolveAssetPath } from "./assets.js";

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
