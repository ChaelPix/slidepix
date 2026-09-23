import { describe, expect, it } from "vitest";
import { railDropIndex } from "./rail";

const midpoints = [10, 30, 50, 70];

describe("railDropIndex", () => {
  it("moves a slide down past the entries whose centers are above the pointer", () => {
    expect(railDropIndex(midpoints, 40, 0)).toBe(1);
    expect(railDropIndex(midpoints, 60, 0)).toBe(2);
  });

  it("moves a slide up without counting the gap it leaves behind", () => {
    expect(railDropIndex(midpoints, 20, 3)).toBe(1);
    expect(railDropIndex(midpoints, 5, 3)).toBe(0);
  });

  it("keeps the slide when the pointer stays on it", () => {
    expect(railDropIndex(midpoints, 32, 1)).toBe(1);
  });
});
