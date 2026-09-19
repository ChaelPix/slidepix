import { describe, expect, it } from "vitest";
import { uniqueDeckFilename } from "./create-deck";

describe("uniqueDeckFilename", () => {
  it("uses untitled.slidepix.json when the folder is empty", () => {
    expect(uniqueDeckFilename([])).toBe("untitled.slidepix.json");
  });

  it("increments past existing untitled decks without treating other files as collisions", () => {
    expect(uniqueDeckFilename(["notes.md", "untitled.slidepix.json"])).toBe("untitled-2.slidepix.json");
    expect(uniqueDeckFilename(["UNTITLED.slidepix.json", "untitled-2.slidepix.json"])).toBe("untitled-3.slidepix.json");
  });
});
