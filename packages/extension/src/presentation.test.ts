import { describe, expect, it } from "vitest";
import { createDeck, duplicateSlide } from "@slidepix/core";
import { PresentationServer } from "./presentation";

describe("PresentationServer navigation", () => {
  it("broadcasts only when the visible slide index changes", () => {
    const deck = createDeck("Navigation boundary");
    deck.slides.push(duplicateSlide(deck.slides[0]!));
    const states: number[] = [];
    const server = new PresentationServer(deck, "/unused.slidepix.json", (index) => states.push(index));

    server.command("next");
    server.command("next");
    server.command("previous");
    server.command("previous");

    expect(states).toEqual([1, 0]);
  });
});
