import { describe, expect, it } from "vitest";
import { renderDeckDocument, renderMarkdown } from "./render.js";
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

  it("keeps negative layers above the slide background in every output", () => {
    const html = renderDeckDocument(createDeck("Layers"));

    expect(html).toContain(".slidepix-slide{position:relative;overflow:hidden;isolation:isolate;page-break-inside:avoid;break-inside:avoid}");
    expect(html).not.toContain("page-break-after:always");
  });

  it("adds deterministic syntax highlighting to fenced code", () => {
    const html = renderMarkdown("```python\ndef train(value):\n    return value + 1\n```");

    expect(html).toContain('data-language="python"');
    expect(html).toContain("hljs-keyword");
    expect(html).toContain("hljs-title");
  });
});
