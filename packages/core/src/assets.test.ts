import { describe, expect, it } from "vitest";
import { deckMediaReferences } from "./assets.js";
import { createDeck, type Deck } from "./schema.js";

function image(id: string, src: string, hidden = false): Deck["slides"][number]["elements"][number] {
  return {
    id,
    morphKey: id,
    type: "image",
    name: id,
    src,
    storage: "embedded",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    opacity: 1,
    z: 1,
    locked: false,
    hidden,
    crop: { x: 0, y: 0, width: 1, height: 1 },
    borderRadius: 0,
    edgeFade: 0,
    border: { width: 0, color: "transparent" },
    lockAspectRatio: true
  };
}

describe("deckMediaReferences", () => {
  it("skips hidden slides and elements unless asked", () => {
    const deck = createDeck("Assets");
    deck.slides[0]!.elements = [image("visible", "shown.png"), image("hidden-element", "hidden.png", true)];
    deck.slides.push({ ...deck.slides[0]!, id: "hidden-slide", hidden: true, elements: [image("on-hidden", "slide.png")] });
    expect([...deckMediaReferences(deck).values()].map((item) => item.reference)).toEqual(["shown.png"]);
    expect([...deckMediaReferences(deck, { includeHidden: true }).values()].map((item) => item.reference).sort()).toEqual(["hidden.png", "shown.png", "slide.png"]);
  });
});
