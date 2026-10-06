import { describe, expect, it } from "vitest";
import * as path from "node:path";
import {
  buildManimArgv,
  buildManimRenderArgs,
  discoverManimScenes,
  findUvWorkspaceRoot,
  findVenvManimNear,
  formatManimLogChunk,
  manimOutputBasename,
  parseManimProgress,
  resolveManimLaunch,
  scriptContentFingerprint,
  uvInstallCommand
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
      orientation: "horizontal",
      quality: "high",
      transparent: false,
      mediaDir: "/tmp/media",
      outputName: "slidepix-1"
    })).toEqual([
      "render", "-qh", "-r", "1920,1080", "--media_dir", "/tmp/media", "-o", "slidepix-1", "--format=png", "-s",
      "--progress_bar=leave", "/tmp/scene.py", "Intro"
    ]);

    expect(buildManimRenderArgs({
      scriptPath: "/tmp/scene.py",
      scene: "Intro",
      output: "video",
      orientation: "vertical",
      quality: "medium",
      transparent: true,
      mediaDir: "/tmp/media",
      outputName: "slidepix-2"
    })).toEqual(expect.arrayContaining(["-r", "720,1280", "--format=webm", "--transparent"]));

    expect(buildManimRenderArgs({
      scriptPath: "/tmp/scene.py",
      scene: "Intro",
      output: "image",
      orientation: "vertical",
      quality: "low",
      transparent: true,
      mediaDir: "/tmp/media",
      outputName: "slidepix-3"
    })).toEqual(expect.arrayContaining(["-r", "480,854", "--transparent"]));
  });

  it("assembles argv for direct, venv, and uv launches", () => {
    const options = {
      scriptPath: "/repo/examples/demo.manim.py",
      scene: "Intro",
      output: "image" as const,
      orientation: "horizontal" as const,
      quality: "low" as const,
      transparent: false,
      mediaDir: "/tmp/media",
      outputName: "slidepix-1"
    };

    expect(buildManimArgv({ command: "manim", args: [] }, options)).toMatchObject({
      command: "manim",
      args: ["render", "-ql", "-r", "854,480", "--media_dir", "/tmp/media", "-o", "slidepix-1", "--format=png", "-s", "--progress_bar=leave", "/repo/examples/demo.manim.py", "Intro"]
    });

    expect(buildManimArgv({ command: "/repo/.venv/bin/manim", args: [] }, options).command).toBe("/repo/.venv/bin/manim");
    expect(buildManimArgv({ command: "uv", args: ["run", "manim"], cwd: "/repo" }, options)).toEqual({
      command: "uv",
      cwd: "/repo",
      args: ["run", "manim", "render", "-ql", "-r", "854,480", "--media_dir", "/tmp/media", "-o", "slidepix-1", "--format=png", "-s", "--progress_bar=leave", "/repo/examples/demo.manim.py", "Intro"]
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
    const windows = (target: string) => target === path.join("/repo", ".venv", "Scripts", "manim.exe");
    expect(findVenvManimNear("/repo/examples", windows)).toBe(path.join("/repo", ".venv", "Scripts", "manim.exe"));
  });

  it("names output after the scene, then the slide", () => {
    expect(manimOutputBasename("HarmonicsStill", "Harmoniques")).toBe("HarmonicsStill");
    expect(manimOutputBasename(undefined, "Créneau")).toBe("Creneau");
    expect(manimOutputBasename("HarmonicsStill", "Harmoniques", ["HarmonicsStill"])).toBe("Harmoniques-HarmonicsStill");
  });

  it("reads manim progress and strips carriage returns", () => {
    expect(parseManimProgress("Animation 0: 45%|###")).toBe(45);
    expect(formatManimLogChunk("partial\rdone\n")).toBe("partial\ndone\n");
    expect(uvInstallCommand("win32").command).toBe("powershell.exe");
    expect(uvInstallCommand("darwin").args.join(" ")).toContain("astral.sh/uv/install.sh");
  });

  it("fingerprints script content deterministically", () => {
    expect(scriptContentFingerprint("alpha")).toBe(scriptContentFingerprint("alpha"));
    expect(scriptContentFingerprint("alpha")).not.toBe(scriptContentFingerprint("beta"));
  });
});
