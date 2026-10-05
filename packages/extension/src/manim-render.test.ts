import { describe, expect, it } from "vitest";
import {
  buildManimArgv,
  buildManimRenderArgs,
  discoverManimScenes,
  findUvWorkspaceRoot,
  findVenvManimNear,
  resolveManimLaunch,
  scriptContentFingerprint
} from "./manim-render.js";

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

  it("builds render args for still and transparent video output", () => {
    expect(buildManimRenderArgs({
      scriptPath: "/tmp/scene.py",
      scene: "Intro",
      output: "image",
      quality: "high",
      transparent: false,
      mediaDir: "/tmp/media",
      outputName: "slidepix-1"
    })).toEqual([
      "render", "-qh", "--media_dir", "/tmp/media", "-o", "slidepix-1", "--format=png", "-s",
      "/tmp/scene.py", "Intro"
    ]);

    expect(buildManimRenderArgs({
      scriptPath: "/tmp/scene.py",
      scene: "Intro",
      output: "video",
      quality: "medium",
      transparent: true,
      mediaDir: "/tmp/media",
      outputName: "slidepix-2"
    })).toContain("--format=webm");
  });

  it("assembles argv for direct, venv, and uv launches", () => {
    const options = {
      scriptPath: "/repo/examples/demo.manim.py",
      scene: "Intro",
      output: "image" as const,
      quality: "low" as const,
      transparent: false,
      mediaDir: "/tmp/media",
      outputName: "slidepix-1"
    };

    expect(buildManimArgv({ command: "manim", args: [] }, options)).toMatchObject({
      command: "manim",
      args: ["render", "-ql", "--media_dir", "/tmp/media", "-o", "slidepix-1", "--format=png", "-s", "/repo/examples/demo.manim.py", "Intro"]
    });

    expect(buildManimArgv({ command: "/repo/.venv/bin/manim", args: [] }, options).command).toBe("/repo/.venv/bin/manim");
    expect(buildManimArgv({ command: "uv", args: ["run", "manim"], cwd: "/repo" }, options)).toEqual({
      command: "uv",
      cwd: "/repo",
      args: ["run", "manim", "render", "-ql", "--media_dir", "/tmp/media", "-o", "slidepix-1", "--format=png", "-s", "/repo/examples/demo.manim.py", "Intro"]
    });
  });

  it("resolves launchers near the deck", () => {
    const exists = (target: string) => target.endsWith("/repo/.venv/bin/manim") || target === "/repo/.venv";
    expect(findVenvManimNear("/repo/examples", exists)).toBe("/repo/.venv/bin/manim");
    expect(findUvWorkspaceRoot("/repo/examples/nested", exists)).toBe("/repo");
    expect(resolveManimLaunch("/repo/examples/demo.slidepix.json", "", exists)).toEqual({
      command: "/repo/.venv/bin/manim",
      args: []
    });
    expect(resolveManimLaunch("/repo/examples/demo.slidepix.json", "uv run manim")).toEqual({
      command: "uv",
      args: ["run", "manim"]
    });
  });

  it("fingerprints script content deterministically", () => {
    expect(scriptContentFingerprint("alpha")).toBe(scriptContentFingerprint("alpha"));
    expect(scriptContentFingerprint("alpha")).not.toBe(scriptContentFingerprint("beta"));
  });
});
