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

  it("applies an explicit animation state when navigation stays on the active slide", () => {
    const html = renderDeckDocument(createDeck("Boundary test"), undefined, { mode: "present" });

    expect(html).toContain("if(bounded===index&&active)");
    expect(html).toContain("animationState==='final'?finish():reset()");
    expect(html).toContain("if(!initial.has(a.targetElementId))");
  });

  it("pauses media on the slide being left and when the audience is hidden", () => {
    const html = renderDeckDocument(createDeck("Video lifecycle"), undefined, { mode: "present" });

    expect(html).toContain("function pauseVideos(slide)");
    expect(html).toContain("pauseVideos(previous)");
    expect(html).toContain("addEventListener('visibilitychange'");
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

  it("renders four-sided image edge fading and passes media storage to the resolver", () => {
    const deck = createDeck("Media");
    deck.slides[0]!.elements.push({
      id: "image-1", morphKey: "image-morph", type: "image", name: "chart", src: "media/chart.png", storage: "linked",
      x: 0, y: 0, width: 400, height: 300, rotation: 0, opacity: 1, z: 1, locked: false, hidden: false,
      crop: { x: 0, y: 0, width: 1, height: 1 }, borderRadius: 24, edgeFade: 20, border: { width: 0, color: "transparent" }
    });
    const calls: string[] = [];
    const html = renderDeckDocument(deck, (reference, storage) => { calls.push(`${storage}:${reference}`); return reference; });

    expect(calls).toContain("linked:media/chart.png");
    expect(html).toContain("linear-gradient(to bottom");
    expect(html).toContain("mask-composite:intersect");
  });
});
