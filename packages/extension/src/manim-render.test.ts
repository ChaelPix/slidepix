import { describe, expect, it } from "vitest";
import { buildManimArgv, discoverManimScenes, scriptContentFingerprint } from "./manim-render.js";

describe("manim render helpers", () => {
  it("detects Scene subclasses", () => {
    const source = `
from manim import *

class Intro(Scene):
    pass

class Outro(MovingCameraScene):
    pass
`;
    expect(discoverManimScenes(source)).toEqual(["Intro", "Outro"]);
  });

  it("builds argv for still and transparent video output", () => {
    expect(buildManimArgv({
      executable: "manim",
      scriptPath: "/tmp/scene.py",
      scene: "Intro",
      output: "image",
      quality: "high",
      transparent: false,
      mediaDir: "/tmp/media",
      outputName: "slidepix-1"
    })).toEqual([
      "manim", "render", "-qh", "--media_dir", "/tmp/media", "-o", "slidepix-1", "--format=png", "-s",
      "/tmp/scene.py", "Intro"
    ]);

    expect(buildManimArgv({
      executable: "manim",
      scriptPath: "/tmp/scene.py",
      scene: "Intro",
      output: "video",
      quality: "medium",
      transparent: true,
      mediaDir: "/tmp/media",
      outputName: "slidepix-2"
    })).toContain("--format=webm");
  });

  it("fingerprints script content deterministically", () => {
    expect(scriptContentFingerprint("alpha")).toBe(scriptContentFingerprint("alpha"));
    expect(scriptContentFingerprint("alpha")).not.toBe(scriptContentFingerprint("beta"));
  });
});
