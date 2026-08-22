import { describe, expect, it } from "vitest";
import { renderDeckDocument } from "./render.js";
import { createDeck, duplicateSlide } from "./schema.js";

describe("shared document rendering", () => {
  it("renders a selected presenter frame with a viewport fitting runtime", () => {
    const deck = createDeck("Frame test");
    const second = duplicateSlide(deck.slides[0]!);
    deck.slides.push(second);

    const html = renderDeckDocument(deck, undefined, {
      mode: "frame",
      selectedSlideIds: [second.id]
    });

    expect(html).toContain('body class="mode-frame"');
    expect(html).toContain(`data-slide-id="${second.id}"`);
    expect(html).not.toContain(`data-slide-id="${deck.slides[0]!.id}"`);
    expect(html).toContain("const k=Math.min(innerWidth/");
    expect(html).not.toContain("scale(min(calc(");
  });

  it("does not reset an already active slide when navigation stays on it", () => {
    const html = renderDeckDocument(createDeck("Boundary test"), undefined, { mode: "present" });

    expect(html).toContain("bounded===index&&slides[index]?.classList.contains('active')");
    expect(html).toContain("{fit();return}");
  });
});
