import { describe, expect, it } from "vitest";
import { parsePresentationMarkdown, renderDeckDocument, renderMarkdown, renderPresentationMathMl, roundedEdgeFadeMask } from "./render.js";
import { createDeck, duplicateSlide, elementSchema } from "./schema.js";

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

  it("initializes the destination timeline before starting its morph animations", () => {
    const html = renderDeckDocument(createDeck("Morph ordering"), undefined, { mode: "present" });
    const stateIndex = html.indexOf("animationState==='final'?finish():reset()");
    const morphIndex = html.indexOf("if(t.type==='morph')", stateIndex);

    expect(stateIndex).toBeGreaterThan(-1);
    expect(morphIndex).toBeGreaterThan(stateIndex);
  });

  it("pushes the real outgoing and incoming slides without a dark fallback", () => {
    const deck = createDeck("Slide transition");
    const second = duplicateSlide(deck.slides[0]!);
    second.transition = { type: "slide-left", durationMs: 700, easing: "ease-in-out" };
    deck.slides.push(second);

    const html = renderDeckDocument(deck, undefined, { mode: "present" });

    expect(html).toContain("html,body{margin:0;background:#ffffff");
    expect(html).not.toContain("background:#020617");
    expect(html).toContain(".slidepix-slide.active,.mode-present .slidepix-slide.transitioning{display:block}");
    expect(html).toContain("function slideTransition(current,previous,transition)");
    expect(html).toContain("previous.animate([{transform:priorBase}");
    expect(html).toContain("direction==='left'?['-100%','0']");
    expect(html).toContain("fit();if(t.type==='morph')");
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

  it("exposes the shared Markdown structure for semantic exporters", () => {
    const blocks = parsePresentationMarkdown("# Title **bold** $x^2$\n\n- item\n\n```ts\nconst value = 2;\n```\n\n| A | B |\n| - | - |\n| 1 | 2 |");

    expect(blocks[0]).toMatchObject({ type: "heading", level: 1 });
    expect(blocks[0]?.type === "heading" && blocks[0].runs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "text", text: "bold", bold: true }),
      expect.objectContaining({ kind: "math", latex: "x^2" })
    ]));
    expect(blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "list-item", level: 0 }),
      expect.objectContaining({ type: "code", language: "ts", runs: expect.arrayContaining([expect.objectContaining({ token: "hljs-keyword" })]) }),
      expect.objectContaining({ type: "table", headerRow: true })
    ]));
    expect(renderPresentationMathMl("\\frac{x}{y}", true)).toContain("<mfrac>");
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
    expect(html).toContain("data:image/svg+xml");
    expect(html).toContain("feGaussianBlur");
    expect(html).toContain("mask-size:100% 100%");
  });

  it("builds a rounded edge-fade mask from element geometry", () => {
    const mask = roundedEdgeFadeMask(600, 400, 80, 50);

    expect(mask).toContain(encodeURIComponent('viewBox="0 0 600 400"'));
    expect(mask).toContain(encodeURIComponent('rx="44"'));
    expect(roundedEdgeFadeMask(600, 400, 80, 0)).toBeUndefined();
  });

  it("keeps editor font sizes literal and disables browser text autoscaling", () => {
    const deck = createDeck("Typography parity");
    const text = deck.slides[0]!.elements[0];
    if (text?.type !== "text") throw new Error("Expected title text");
    text.style.fontSize = 73;

    const html = renderDeckDocument(deck, undefined, { mode: "present" });

    expect(html).toContain("font-size:73px");
    expect(html).toContain("&quot;Segoe UI&quot;");
    expect(html).toContain("-webkit-text-size-adjust:none;text-size-adjust:none");
    expect(html).toContain('class="slidepix-text-content"');
  });

  it("renders transparent paints, shape shadows, and Markdown tables", () => {
    const deck = createDeck("Drawing and tables");
    deck.slides[0]!.elements.push(
      elementSchema.parse({
        id: "shape-1", morphKey: "shape-morph", type: "shape", shape: "rectangle",
        x: 20, y: 20, width: 300, height: 200, z: 1,
        fill: "transparent", stroke: "transparent", strokeWidth: 4,
        shadow: { enabled: true, color: "#11223380", offsetX: 7, offsetY: 9, blur: 18 }
      }),
      elementSchema.parse({
        id: "table-1", morphKey: "table-morph", type: "table",
        x: 100, y: 300, width: 800, height: 400, z: 2,
        rows: 2, columns: 2, cells: [["**Name**", "Value"], ["Alpha", "$x^2$"]],
        style: { headerFill: "transparent", cellFill: "transparent", borderColor: "transparent" }
      })
    );

    const html = renderDeckDocument(deck);

    expect(html).toContain("background:transparent;border:4px solid transparent");
    expect(html).toContain("drop-shadow(7px 9px 18px #11223380)");
    expect(html).toContain('class="slidepix-table-content"');
    expect(html.match(/<th /g)).toHaveLength(2);
    expect(html.match(/<td /g)).toHaveLength(2);
    expect(html.match(/<th style="[^"]*text-align:center/g)).toHaveLength(2);
    expect(html).toContain("<strong>Name</strong>");
    expect(html).toContain("<math");
  });
});
