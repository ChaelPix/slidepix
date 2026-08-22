import { describe, expect, it } from "vitest";
import { cropZoomPercent, localPointerDelta, scaleCrop, scaleCropAround, setCropZoom } from "./geometry.js";

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

  it("keeps the crop ratio while zooming around the pointer anchor", () => {
    const crop = { x: 0.1, y: 0.2, width: 0.8, height: 0.4 };
    const zoomed = scaleCropAround(crop, 0.5, 0.25, 0.75);

    expect(zoomed.width / zoomed.height).toBeCloseTo(crop.width / crop.height);
    expect(zoomed.x + zoomed.width * 0.25).toBeCloseTo(crop.x + crop.width * 0.25);
    expect(zoomed.y + zoomed.height * 0.75).toBeCloseTo(crop.y + crop.height * 0.75);
  });
});
