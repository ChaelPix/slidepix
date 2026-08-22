import { describe, expect, it } from "vitest";
import { createDeck, duplicateSlide } from "@slidepix/core";
import { selectSlides } from "./tools";

describe("MCP slide selection", () => {
  it("selects by 1-based index and id", () => {
    const deck = createDeck();
    deck.slides.push(duplicateSlide(deck.slides[0]!));
    expect(selectSlides(deck, undefined, [2])[0]!.id).toBe(deck.slides[1]!.id);
    expect(selectSlides(deck, [deck.slides[0]!.id])[0]!.id).toBe(deck.slides[0]!.id);
  });

  it("rejects unknown selections", () => {
    const deck = createDeck();
    expect(() => selectSlides(deck, ["missing"])).toThrow(/Unknown/);
    expect(() => selectSlides(deck, undefined, [8])).toThrow(/out of range/);
  });
});
