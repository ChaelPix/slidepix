import { describe, expect, it } from "vitest";
import { shapeElementSchema, type Deck } from "@slidepix/core";
import { syncNamedShapes } from "./shape-batch.js";

function shape(id: string, name: string | undefined, fill: string) {
  return shapeElementSchema.parse({ id, morphKey: id, type: "shape", shape: "rectangle", name, fill, x: 1, y: 2, width: 3, height: 4 });
}

describe("named shape batch edit", () => {
  it("copies pose and color to the same name on other slides only", () => {
    const source = shape("source", "Accent", "#ff0000");
    const local = shape("local", "Accent", "#111111");
    const other = shape("other", "Accent", "#000000");
    const plain = shape("plain", undefined, "#222222");
    const titled = shape("text-name", "Title", "#333333");
    const deck = { slides: [{ id: "a", elements: [source, local] }, { id: "b", elements: [other, plain, titled] }] } as Deck;
    source.x = 40;
    source.width = 80;
    source.fill = "#00ff00";

    syncNamedShapes(deck, "a", "source");

    expect(other).toMatchObject({ x: 40, width: 80, fill: "#00ff00" });
    expect(local.fill).toBe("#111111");
    expect(plain.fill).toBe("#222222");
    expect(titled.fill).toBe("#333333");
  });

  it("does nothing when the shape has no name", () => {
    const other = shape("other", undefined, "#000000");
    const deck = { slides: [{ id: "a", elements: [shape("source", undefined, "#ff0000")] }, { id: "b", elements: [other] }] } as Deck;
    syncNamedShapes(deck, "a", "source");
    expect(other.fill).toBe("#000000");
  });
});