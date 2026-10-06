import type { ManimElement, ManimOrientation, ManimQuality } from "./schema.js";

export type ManimRenderSettings = Pick<
  ManimElement,
  "script" | "scene" | "output" | "orientation" | "quality" | "transparent"
>;

/** Default Manim Community resolutions per quality flag (see `manim render --help`). */
const MANIM_FRAME_SIZE: Record<ManimQuality, { width: number; height: number }> = {
  low: { width: 854, height: 480 },
  medium: { width: 1280, height: 720 },
  high: { width: 1920, height: 1080 },
  production: { width: 3840, height: 2160 }
};

export function manimElementAspectRatio(orientation: ManimOrientation = "horizontal"): number {
  return orientation === "horizontal" ? 16 / 9 : 9 / 16;
}

export function manimRenderResolution(
  orientation: ManimOrientation,
  quality: ManimQuality
): { width: number; height: number } {
  const frame = MANIM_FRAME_SIZE[quality];
  return orientation === "horizontal" ? frame : { width: frame.height, height: frame.width };
}

export function manimSettingsFingerprint(settings: ManimRenderSettings): string {
  return JSON.stringify({
    script: settings.script ?? "",
    scene: settings.scene ?? "",
    output: settings.output,
    orientation: settings.orientation ?? "horizontal",
    quality: settings.quality,
    transparent: settings.transparent
  });
}

export function manimRenderFingerprint(settingsKey: string, scriptContentFingerprint: string): string {
  return `${settingsKey}\0${scriptContentFingerprint}`;
}

export const MANIM_QUALITY_FLAG: Record<ManimQuality, string> = {
  low: "-ql",
  medium: "-qm",
  high: "-qh",
  production: "-qp"
};

export const DEFAULT_MANIM_SCENE_NAME = "SlidePixScene";

export function manimScriptFileLabel(script?: string): string {
  const trimmed = script?.trim();
  if (!trimmed) return "manim.py";
  const parts = trimmed.split(/[/\\]/);
  return parts.at(-1) || trimmed;
}

export const MANIM_STARTER_SCRIPT = `from manim import *


class ${DEFAULT_MANIM_SCENE_NAME}(Scene):
    def construct(self):
        self.add(Text("Hello Manim"))
`;
