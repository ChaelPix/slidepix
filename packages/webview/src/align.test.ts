import { describe, expect, it } from "vitest";
import { applyAlign, applyDistribute, type AlignBox } from "./align";

const page = { width: 1000, height: 800 };

function box(id: string, x: number, y: number, width = 100, height = 50, locked = false): AlignBox {
  return { id, x, y, width, height, locked };
}

describe("page alignment", () => {
  it("aligns a single box to each page edge and the page center", () => {
    const target = [box("a", 40, 60, 200, 100)];
    expect(applyAlign(target, "left", "page", page)[0]).toMatchObject({ x: 0, y: 60 });
    expect(applyAlign(target, "right", "page", page)[0]).toMatchObject({ x: 800, y: 60 });
    expect(applyAlign(target, "top", "page", page)[0]).toMatchObject({ x: 40, y: 0 });
    expect(applyAlign(target, "bottom", "page", page)[0]).toMatchObject({ x: 40, y: 700 });
    expect(applyAlign(target, "center", "page", page)[0]).toMatchObject({ x: 400, y: 60 });
    expect(applyAlign(target, "middle", "page", page)[0]).toMatchObject({ x: 40, y: 350 });
    expect(applyAlign(target, "center-page", "selection", page)[0]).toMatchObject({ x: 400, y: 350 });
  });

  it("aligns several boxes to the selection bounding box", () => {
    const boxes = [box("a", 10, 20, 100, 40), box("b", 400, 200, 50, 80)];
    const left = applyAlign(boxes, "left", "selection", page);
    expect(left.map((item) => item.x)).toEqual([10, 10]);
    const center = applyAlign(boxes, "center", "selection", page);
    expect(center[0]!.x + 50).toBeCloseTo(center[1]!.x + 25);
    const top = applyAlign(boxes, "top", "selection", page);
    expect(top.map((item) => item.y)).toEqual([20, 20]);
  });

  it("does not move locked boxes", () => {
    const boxes = [box("a", 10, 10, 100, 40, true), box("b", 80, 90)];
    const aligned = applyAlign(boxes, "left", "page", page);
    expect(aligned[0]).toMatchObject({ id: "a", x: 10, y: 10 });
    expect(aligned[1]).toMatchObject({ id: "b", x: 0, y: 90 });
  });
});

describe("distribution", () => {
  it("spaces centers evenly between the first and last boxes", () => {
    const boxes = [box("a", 0, 0, 100, 40), box("b", 40, 0, 100, 40), box("c", 400, 0, 100, 40)];
    const next = applyDistribute(boxes, "horizontal-centers");
    expect(next[1]!.x + 50).toBeCloseTo(250);
  });

  it("makes the gaps between boxes equal", () => {
    const boxes = [box("a", 0, 0, 100, 40), box("b", 110, 0, 100, 40), box("c", 400, 0, 100, 40)];
    const next = applyDistribute(boxes, "horizontal-gaps");
    expect(next[1]!.x).toBeCloseTo(200);
  });

  it("leaves fewer than three movable boxes unchanged", () => {
    const boxes = [box("a", 0, 0), box("b", 80, 0, 100, 50, true), box("c", 300, 0)];
    expect(applyDistribute(boxes, "horizontal-gaps")).toEqual(boxes);
  });
});
