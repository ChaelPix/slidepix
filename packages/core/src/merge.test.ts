import { describe, expect, it } from "vitest";
import { mergeDecks, mergeDecksLive, type DeckMergeResolution } from "./merge.js";
import { createDeck, duplicateSlide, parseDeckText, type Deck, type SlideElement } from "./schema.js";

function fixture(): Deck {
  const deck = createDeck("Merge test");
  deck.slides[0]!.id = "slide-a";
  deck.slides[0]!.elements[0]!.id = "element-a";
  deck.slides[0]!.elements[0]!.morphKey = "morph-a";
  const second = duplicateSlide(deck.slides[0]!);
  second.id = "slide-b";
  second.title = "Second";
  second.elements[0]!.id = "element-b";
  deck.slides.push(second);
  return deck;
}

function shape(id: string): SlideElement {
  return {
    id,
    morphKey: id,
    type: "shape",
    shape: "rectangle",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    opacity: 1,
    z: 1,
    locked: false,
    hidden: false,
    fill: "#ffffff",
    stroke: "transparent",
    strokeWidth: 0,
    borderRadius: 0,
    shadow: { enabled: false, color: "#00000040", offsetX: 0, offsetY: 12, blur: 24 }
  };
}

describe("mergeDecks", () => {
  it("merges independent slides and properties", () => {
    const base = fixture();
    const ours = structuredClone(base);
    const theirs = structuredClone(base);
    ours.slides[0]!.notes = "ours";
    (theirs.slides[1]!.elements[0] as Extract<SlideElement, { type: "text" }>).style.fontSize = 80;

    const result = mergeDecks(base, ours, theirs);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deck.slides[0]!.notes).toBe("ours");
    expect((result.deck.slides[1]!.elements[0] as Extract<SlideElement, { type: "text" }>).style.fontSize).toBe(80);
    expect(parseDeckText(result.text).ok).toBe(true);
  });

  it("preserves concurrent additions with ours first in the same gap", () => {
    const base = fixture();
    const ours = structuredClone(base);
    const theirs = structuredClone(base);
    ours.slides[0]!.elements.push(shape("ours-new"));
    theirs.slides[0]!.elements.push(shape("theirs-new"));

    const result = mergeDecks(base, ours, theirs);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deck.slides[0]!.elements.map((element) => element.id)).toEqual(["element-a", "ours-new", "theirs-new"]);
  });

  it("merges edits to different table cells", () => {
    const base = fixture();
    base.slides[0]!.elements = [{
      ...shape("table-a"),
      type: "table",
      rows: 2,
      columns: 2,
      cells: [["A", "B"], ["C", "D"]],
      headerRow: true,
      style: { fontFamily: "Arial", fontSize: 30, fontWeight: 400, color: "#111", headerFill: "#eee", cellFill: "#fff", borderColor: "#999", borderWidth: 1, textAlign: "left", verticalAlign: "middle", padding: 10 }
    }];
    const ours = structuredClone(base);
    const theirs = structuredClone(base);
    (ours.slides[0]!.elements[0] as Extract<SlideElement, { type: "table" }>).cells[0]![0] = "ours";
    (theirs.slides[0]!.elements[0] as Extract<SlideElement, { type: "table" }>).cells[1]![1] = "theirs";

    const result = mergeDecks(base, ours, theirs);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.deck.slides[0]!.elements[0] as Extract<SlideElement, { type: "table" }>).cells).toEqual([["ours", "B"], ["C", "theirs"]]);
  });

  it("reports and resolves scalar conflicts", () => {
    const base = fixture();
    const ours = structuredClone(base);
    const theirs = structuredClone(base);
    ours.slides[0]!.title = "Ours";
    theirs.slides[0]!.title = "Theirs";

    const conflict = mergeDecks(base, ours, theirs);
    expect(conflict.ok).toBe(false);
    if (conflict.ok) return;
    expect(conflict.conflicts).toHaveLength(1);
    const resolutions: Record<string, DeckMergeResolution> = { [conflict.conflicts[0]!.id]: "theirs" };
    const resolved = mergeDecks(base, ours, theirs, resolutions);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.deck.slides[0]!.title).toBe("Theirs");
  });

  it("accepts the same concurrent value without a conflict", () => {
    const base = fixture();
    const ours = structuredClone(base);
    const theirs = structuredClone(base);
    ours.slides[0]!.title = "Shared";
    theirs.slides[0]!.title = "Shared";
    const result = mergeDecks(base, ours, theirs);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.deck.slides[0]!.title).toBe("Shared");
  });

  it("reports delete-versus-edit", () => {
    const base = fixture();
    const ours = structuredClone(base);
    const theirs = structuredClone(base);
    ours.slides[0]!.elements = [];
    theirs.slides[0]!.elements[0]!.x = 42;

    const result = mergeDecks(base, ours, theirs);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.conflicts.some((conflict) => conflict.kind === "delete-edit" && conflict.elementId === "element-a")).toBe(true);
  });

  it("accepts a one-sided reorder and rejects incompatible reorders", () => {
    const base = fixture();
    const third = duplicateSlide(base.slides[0]!);
    third.id = "slide-c";
    third.elements[0]!.id = "element-c";
    base.slides.push(third);

    const ours = structuredClone(base);
    ours.slides = [ours.slides[1]!, ours.slides[0]!, ours.slides[2]!];
    const clean = mergeDecks(base, ours, structuredClone(base));
    expect(clean.ok).toBe(true);
    if (clean.ok) expect(clean.deck.slides.map((slide) => slide.id)).toEqual(["slide-b", "slide-a", "slide-c"]);

    const theirs = structuredClone(base);
    theirs.slides = [theirs.slides[0]!, theirs.slides[2]!, theirs.slides[1]!];
    const conflict = mergeDecks(base, ours, theirs);
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.conflicts.some((item) => item.kind === "order")).toBe(true);
  });

  it("is deterministic", () => {
    const base = fixture();
    const ours = structuredClone(base);
    const theirs = structuredClone(base);
    ours.slides[0]!.notes = "ours";
    theirs.slides[1]!.notes = "theirs";
    expect(mergeDecks(base, ours, theirs)).toEqual(mergeDecks(base, ours, theirs));
  });

  it("surfaces and resolves integrity conflicts caused by combining valid branches", () => {
    const base = fixture();
    const ours = structuredClone(base);
    const theirs = structuredClone(base);
    ours.slides[0]!.elements = [];
    theirs.slides[0]!.timeline.push({ id: "new-animation", targetElementId: "element-a", phase: "entrance", effect: "fade", trigger: "onClick", delayMs: 0, durationMs: 500, easing: "ease-out" });

    const conflict = mergeDecks(base, ours, theirs);
    expect(conflict.ok).toBe(false);
    if (conflict.ok) return;
    expect(conflict.conflicts.some((item) => item.kind === "invalid-result")).toBe(true);
    const resolutions = Object.fromEntries(conflict.conflicts.map((item) => [item.id, "theirs" as const]));
    const resolved = mergeDecks(base, ours, theirs, resolutions);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.deck.slides[0]!.timeline).toHaveLength(1);
  });
});

describe("mergeDecksLive", () => {
  it("keeps the preferred side when both change the same value", () => {
    const base = fixture();
    const ours = structuredClone(base);
    const theirs = structuredClone(base);
    ours.slides[0]!.title = "Ours";
    theirs.slides[0]!.title = "Theirs";
    const preferred = mergeDecksLive(base, ours, theirs, "theirs");
    expect(preferred.ok).toBe(true);
    if (preferred.ok) expect(preferred.deck.slides[0]!.title).toBe("Theirs");
    const other = mergeDecksLive(base, ours, theirs, "ours");
    expect(other.ok).toBe(true);
    if (other.ok) expect(other.deck.slides[0]!.title).toBe("Ours");
  });

  it("lets the preferred side win a delete-versus-edit", () => {
    const base = fixture();
    const ours = structuredClone(base);
    const theirs = structuredClone(base);
    ours.slides[0]!.elements = [];
    theirs.slides[0]!.elements[0]!.x = 42;
    const kept = mergeDecksLive(base, ours, theirs, "theirs");
    expect(kept.ok).toBe(true);
    if (kept.ok) expect(kept.deck.slides[0]!.elements[0]!.x).toBe(42);
    const deleted = mergeDecksLive(base, ours, theirs, "ours");
    expect(deleted.ok).toBe(true);
    if (deleted.ok) expect(deleted.deck.slides[0]!.elements).toHaveLength(0);
  });

  it("rejects a combined result that breaks deck integrity", () => {
    const base = fixture();
    const ours = structuredClone(base);
    const theirs = structuredClone(base);
    ours.slides[0]!.elements = [];
    theirs.slides[0]!.timeline.push({ id: "new-animation", targetElementId: "element-a", phase: "entrance", effect: "fade", trigger: "onClick", delayMs: 0, durationMs: 500, easing: "ease-out" });
    const result = mergeDecksLive(base, ours, theirs, "theirs");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.conflicts.some((conflict) => conflict.kind === "invalid-result")).toBe(true);
  });

  it("is deterministic", () => {
    const base = fixture();
    const ours = structuredClone(base);
    const theirs = structuredClone(base);
    ours.slides[0]!.title = "Ours";
    theirs.slides[0]!.notes = "Theirs";
    ours.slides[1]!.notes = "Local";
    expect(mergeDecksLive(base, ours, theirs, "theirs")).toEqual(mergeDecksLive(base, ours, theirs, "theirs"));
  });
});
