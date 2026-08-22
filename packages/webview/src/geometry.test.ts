import { describe, expect, it } from "vitest";
import { cropZoomPercent, localPointerDelta, scaleCrop, setCropZoom } from "./geometry.js";

describe("canvas geometry", () => {
  it("converts screen deltas to logical coordinates at any zoom and rotation", () => {
    expect(localPointerDelta(20, 10, 0, 0.5)).toEqual({ x: 40, y: 20 });
    expect(localPointerDelta(20, 0, 90, 1).x).toBeCloseTo(0);
    expect(localPointerDelta(20, 0, 90, 1).y).toBeCloseTo(-20);
  });

  it("zooms around the current crop center without escaping normalized bounds", () => {
    const zoomed = setCropZoom({ x: 0, y: 0, width: 1, height: 1 }, 200);
    expect(zoomed).toEqual({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 });
    expect(cropZoomPercent(zoomed)).toBe(200);

    const edge = scaleCrop({ x: 0.8, y: 0.8, width: 0.2, height: 0.2 }, 2);
    expect(edge.x + edge.width).toBeLessThanOrEqual(1);
    expect(edge.y + edge.height).toBeLessThanOrEqual(1);
  });
});
