import { describe, expect, it } from "vitest";
import { peerBoxes, snapMove, snapResize, snapThreshold } from "./snap";

const page = { width: 1000, height: 800 };
const peer = { id: "peer", x: 200, y: 100, width: 120, height: 80 };

describe("snapMove", () => {
  it("snaps a left edge to another element's left edge", () => {
    const moved = snapMove({ x: 188, y: 40, width: 50, height: 40 }, [peer], page, 16);
    expect(moved.x).toBe(200);
    expect(moved.guides).toContainEqual({ axis: "x", position: 200 });
  });

  it("snaps a top edge to another element's bottom edge", () => {
    const moved = snapMove({ x: 10, y: 188, width: 50, height: 40 }, [peer], page, 16);
    expect(moved.y).toBe(180);
    expect(moved.guides).toContainEqual({ axis: "y", position: 180 });
  });

  it("snaps a right edge to another element's left edge", () => {
    const moved = snapMove({ x: 70, y: 40, width: 120, height: 40 }, [peer], page, 16);
    expect(moved.x + 120).toBe(200);
    expect(moved.guides).toContainEqual({ axis: "x", position: 200 });
  });

  it("snaps centers to the page midline", () => {
    const moved = snapMove({ x: 470, y: 370, width: 40, height: 40 }, [], page, 16);
    expect(moved.x).toBe(480);
    expect(moved.y).toBe(380);
  });

  it("does not snap when every edge is outside the threshold", () => {
    const moved = snapMove({ x: 700, y: 500, width: 40, height: 40 }, [peer], page, 16);
    expect(moved).toEqual({ x: 700, y: 500, guides: [] });
  });

  it("prefers the closest matching edge", () => {
    const near = { id: "near", x: 205, y: 0, width: 10, height: 10 };
    const moved = snapMove({ x: 204, y: 40, width: 40, height: 40 }, [peer, near], page, 16);
    expect(moved.x).toBe(205);
  });
});

describe("snapResize", () => {
  it("snaps a dragged right edge to a peer left edge", () => {
    const resized = snapResize({ x: 40, y: 40, width: 152, height: 40 }, [peer], page, 16);
    expect(resized.width).toBe(160);
    expect(resized.guides).toContainEqual({ axis: "x", position: 200 });
  });
});

describe("snapThreshold", () => {
  it("keeps a constant screen-pixel catch radius as the canvas zooms", () => {
    expect(snapThreshold(1)).toBe(24);
    expect(snapThreshold(0.5)).toBe(48);
  });
});

describe("peerBoxes", () => {
  it("skips hidden and selected elements", () => {
    expect(peerBoxes([
      { id: "a", x: 0, y: 0, width: 10, height: 10 },
      { id: "b", x: 20, y: 0, width: 10, height: 10, hidden: true },
      { id: "c", x: 40, y: 0, width: 10, height: 10 },
    ], ["a"])).toEqual([{ id: "c", x: 40, y: 0, width: 10, height: 10 }]);
  });
});
