import type { ManimElement, ManimQuality } from "./schema.js";

export type ManimRenderSettings = Pick<ManimElement, "script" | "scene" | "output" | "quality" | "transparent">;

export function manimSettingsFingerprint(settings: ManimRenderSettings): string {
  return JSON.stringify({
    script: settings.script ?? "",
    scene: settings.scene ?? "",
    output: settings.output,
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

export const MANIM_STARTER_SCRIPT = `from manim import *


class ${DEFAULT_MANIM_SCENE_NAME}(Scene):
    def construct(self):
        self.add(Text("Hello Manim"))
`;
