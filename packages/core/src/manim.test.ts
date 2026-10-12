import { describe, expect, it } from "vitest";
import { manimElementAspectRatio, manimRenderResolution, manimSettingsFingerprint } from "./manim.js";

describe("manim helpers", () => {
  it("maps orientation to slide aspect ratio", () => {
    expect(manimElementAspectRatio("horizontal")).toBe(16 / 9);
    expect(manimElementAspectRatio("vertical")).toBe(9 / 16);
  });

  it("builds Manim CLI resolution for 16:9 and 9:16", () => {
    expect(manimRenderResolution("horizontal", "low")).toEqual({ width: 854, height: 480 });
    expect(manimRenderResolution("vertical", "low")).toEqual({ width: 480, height: 854 });
    expect(manimRenderResolution("horizontal", "high")).toEqual({ width: 1920, height: 1080 });
    expect(manimRenderResolution("vertical", "high")).toEqual({ width: 1080, height: 1920 });
  });

  it("includes orientation in settings fingerprint", () => {
    const base = {
      script: "a.py",
      scene: "S",
      output: "image" as const,
      quality: "medium" as const,
      transparent: false
    };
    const horizontal = manimSettingsFingerprint({ ...base, orientation: "horizontal" });
    const vertical = manimSettingsFingerprint({ ...base, orientation: "vertical" });
    expect(horizontal).not.toBe(vertical);
  });
});
