import { describe, expect, it } from "vitest";
import * as path from "node:path";
import {
  buildManimArgv,
  buildManimRenderArgs,
  discoverManimScenes,
  findUvWorkspaceRoot,
  findVenvManimNear,
  formatManimLogChunk,
  assignManimBasenames,
  manimDeckStem,
  manimOutputBasename,
  manimProcessEnv,
  manimRenderConcurrency,
  mapWithConcurrency,
  splitManimOutput,
  manimSpawnFailure,
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
    const venvOnly = (target: string) => target === "/repo/.venv";
    expect(resolveManimLaunch("/repo/examples/demo.slidepix.json", "", venvOnly)).toEqual({ command: "manim", args: [] });
    const windows = (target: string) => target === path.join("/repo", ".venv", "Scripts", "manim.exe");
    expect(findVenvManimNear("/repo/examples", windows)).toBe(path.join("/repo", ".venv", "Scripts", "manim.exe"));
  });

  it("names output after the scene, then the slide", () => {
    expect(manimDeckStem("/talks/fourier.slidepix.json")).toBe("fourier");
    expect(manimOutputBasename("fourier", "Harmoniques", "HarmonicsStill")).toBe("fourier-Harmoniques-HarmonicsStill");
    expect(manimOutputBasename("fourier", "Créneau", undefined)).toBe("fourier-Creneau");
    expect(manimOutputBasename("fourier", "Harmoniques", "HarmonicsStill", ["fourier-Harmoniques-HarmonicsStill"])).toBe("fourier-Harmoniques-HarmonicsStill-2");
    expect(assignManimBasenames([
      { id: "a", deckName: "fourier", slideTitle: "Harmoniques", scene: "HarmonicsStill", ownStem: "fourier-Harmoniques-HarmonicsStill" },
      { id: "b", deckName: "fourier", slideTitle: "Créneau", scene: "RectPulse" }
    ], ["fourier-Harmoniques-HarmonicsStill"])).toEqual(new Map([
      ["a", "fourier-Harmoniques-HarmonicsStill"],
      ["b", "fourier-Creneau-RectPulse"]
    ]));
    const shared = assignManimBasenames([
      { id: "new", deckName: "fourier", slideTitle: "Créneau", scene: "RectPulse" },
      { id: "owner", deckName: "fourier", slideTitle: "Créneau", scene: "RectPulse", ownStem: "fourier-Creneau-RectPulse" }
    ], ["fourier-Creneau-RectPulse"]);
    expect(shared.get("owner")).toBe("fourier-Creneau-RectPulse");
    expect(shared.get("new")).toBe("fourier-Creneau-RectPulse-2");
  });

  it("drops progress ticks from the log and keeps one math thread per process", () => {
    expect(splitManimOutput("Animation 0: 45%|###\r")).toEqual({ log: "", percent: 45 });
    expect(splitManimOutput("Traceback (most recent call last):\nError: boom\n").log).toContain("Traceback");
    expect(manimProcessEnv({ PATH: "/usr/bin" })).toMatchObject({ PATH: "/usr/bin", OMP_NUM_THREADS: "1", VECLIB_MAXIMUM_THREADS: "1" });
    expect(manimRenderConcurrency(5, 8)).toBe(5);
    expect(manimRenderConcurrency(20, 8)).toBe(8);
  });

  it("runs at most the requested number of workers at once", async () => {
    let active = 0;
    let maxActive = 0;
    await mapWithConcurrency([0, 1, 2, 3], 2, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
    });
    expect(maxActive).toBe(2);
  });

  it("reads manim progress and strips carriage returns", () => {
    expect(parseManimProgress("Animation 0: 45%|###")).toBe(45);
    expect(formatManimLogChunk("partial\rdone\n")).toBe("partial\ndone\n");
    expect(uvInstallCommand("win32").command).toBe("powershell.exe");
    expect(uvInstallCommand("darwin").args.join(" ")).toContain("astral.sh/uv/install.sh");
    expect(manimSpawnFailure("error: Failed to spawn `manim`\nCaused by: No such file or directory (os error 2)")).toBe(true);
  });

  it("fingerprints script content deterministically", () => {
    expect(scriptContentFingerprint("alpha")).toBe(scriptContentFingerprint("alpha"));
    expect(scriptContentFingerprint("alpha")).not.toBe(scriptContentFingerprint("beta"));
  });
});
