import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deckSchema, serializeDeck } from "../packages/core/dist/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const examples = join(root, "examples");
const deckPath = join(examples, "slidepix-manim-demo.slidepix.json");
const assetDir = join(examples, "slidepix-manim-demo.assets");
const manimScript = "slidepix-manim-demo.manim.py";

const introArg = process.argv[2];
const motionArg = process.argv[3];

const font = "system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif";
const ink = "#111827";
const muted = "#475569";
const blue = "#2563eb";

function runUvManim(mediaDir, outputName, format, scene, still = false) {
  const args = [
    "run", "manim", "render", "-ql",
    "--media_dir", mediaDir,
    "-o", outputName,
    `--format=${format}`,
    ...(still ? ["-s"] : []),
    manimScript,
    scene
  ];
  const result = spawnSync("uv", args, { cwd: examples, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `manim failed for ${scene}`);
}

async function resolveRenderedAssets() {
  if (introArg && motionArg) {
    return {
      intro: await readFile(resolve(introArg)),
      motion: await readFile(resolve(motionArg))
    };
  }
  const mediaDir = await mkdtemp(join(examples, ".manim-media-"));
  try {
    runUvManim(mediaDir, "intro", "png", "IntroStill", true);
    runUvManim(mediaDir, "motion", "mp4", "MotionClip");
    const all = await walkAll(mediaDir);
    const introPath = all.find((file) => file.endsWith("intro.png"));
    const motionPath = all.find((file) => file.endsWith("motion.mp4"));
    if (!introPath || !motionPath) throw new Error("Could not find Manim output under the temporary media directory.");
    return {
      intro: await readFile(introPath),
      motion: await readFile(motionPath)
    };
  } finally {
    await rm(mediaDir, { recursive: true, force: true });
  }
}

async function walkAll(directory) {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walkAll(path));
    else files.push(path);
  }
  return files;
}

async function storeEmbedded(bytes, extension) {
  const reference = `${createHash("sha256").update(bytes).digest("hex")}${extension}`;
  await mkdir(assetDir, { recursive: true });
  await writeFile(join(assetDir, reference), bytes);
  return reference;
}

const common = (id, morphKey, name, x, y, width, height, z = 1) => ({
  id, morphKey, name, x, y, width, height, rotation: 0, opacity: 1, z, locked: false, hidden: false
});

const { intro, motion } = await resolveRenderedAssets();
const introRef = await storeEmbedded(intro, ".png");
const motionRef = await storeEmbedded(motion, ".mp4");

const deck = deckSchema.parse({
  schemaVersion: 1,
  id: "slidepix-manim-demo",
  metadata: {
    title: "SlidePix Manim demo",
    author: "SlidePix",
    description: "Minimal deck showing linked Manim Community scripts and embedded renders."
  },
  size: { width: 1920, height: 1080 },
  theme: { background: "#ffffff", foreground: ink, accent: blue, fontFamily: font },
  pageNumbers: { enabled: true, color: "#64748b", fontSize: 24 },
  layouts: {},
  slides: [
    {
      id: "manim-01",
      title: "Manim in SlidePix",
      background: "#ffffff",
      notes: "The .py file stays linked in the workspace; rendered PNG or MP4 bytes live in slidepix-manim-demo.assets/.",
      hidden: false,
      hidePageNumber: false,
      transition: { type: "fade", durationMs: 500, easing: "ease-in-out" },
      timeline: [],
      elements: [
        {
          ...common("m01-title", "m01-title", "title", 120, 120, 1680, 200, 2),
          type: "text",
          markdown: "# Manim scenes in your deck",
          style: { fontFamily: font, fontSize: 72, fontWeight: 700, color: ink, textAlign: "left", verticalAlign: "top", lineHeight: 1.1, padding: 8 }
        },
        {
          ...common("m01-copy", "m01-copy", "copy", 120, 360, 900, 420, 1),
          type: "text",
          markdown: "Insert **Manim** from the toolbar, edit `slidepix-manim-demo.manim.py`, then click **Render**.\n\n- Linked script: workspace-relative path\n- Output: embedded under `.assets/`\n- Re-render after changing the scene",
          style: { fontFamily: font, fontSize: 34, fontWeight: 400, color: muted, textAlign: "left", verticalAlign: "top", lineHeight: 1.25, padding: 8 }
        }
      ]
    },
    {
      id: "manim-02",
      title: "Still frame",
      background: "#f8fafc",
      notes: "IntroStill is exported with Manim's still (-s) PNG path.",
      hidden: false,
      hidePageNumber: false,
      transition: { type: "slide-right", durationMs: 600, easing: "ease-in-out" },
      timeline: [],
      elements: [
        {
          ...common("m02-label", "m02-label", "label", 120, 90, 600, 80, 2),
          type: "text",
          markdown: "## Still image (`IntroStill`)",
          style: { fontFamily: font, fontSize: 44, fontWeight: 650, color: ink, textAlign: "left", verticalAlign: "top", lineHeight: 1.15, padding: 6 }
        },
        {
          ...common("m02-still", "m02-still", "intro-still", 980, 140, 820, 462, 1),
          type: "manim",
          script: manimScript,
          scene: "IntroStill",
          output: "image",
          quality: "low",
          transparent: false,
          outputMedia: { src: introRef, storage: "embedded" },
          lockAspectRatio: true,
          aspectRatio: 820 / 462,
          playback: { mode: "manual", muted: false, loop: false, controls: true }
        }
      ]
    },
    {
      id: "manim-03",
      title: "Motion clip",
      background: "#ffffff",
      notes: "MotionClip is a short MP4 rendered at low quality for a small repo footprint.",
      hidden: false,
      hidePageNumber: false,
      transition: { type: "slide-left", durationMs: 600, easing: "ease-in-out" },
      timeline: [],
      elements: [
        {
          ...common("m03-label", "m03-label", "label", 120, 90, 700, 80, 2),
          type: "text",
          markdown: "## Video (`MotionClip`)",
          style: { fontFamily: font, fontSize: 44, fontWeight: 650, color: ink, textAlign: "left", verticalAlign: "top", lineHeight: 1.15, padding: 6 }
        },
        {
          ...common("m03-video", "m03-video", "motion-clip", 120, 200, 960, 540, 1),
          type: "manim",
          script: manimScript,
          scene: "MotionClip",
          output: "video",
          quality: "low",
          transparent: false,
          outputMedia: { src: motionRef, storage: "embedded" },
          lockAspectRatio: true,
          aspectRatio: 16 / 9,
          playback: { mode: "manual", muted: false, loop: true, controls: true }
        },
        {
          ...common("m03-copy", "m03-copy", "hint", 1120, 260, 680, 360, 1),
          type: "text",
          markdown: "Playback options (loop, mute, controls) are stored on the Manim element like a normal video.\n\nRebuild this example:\n\n```bash\nnode scripts/build-manim-demo.mjs\n```",
          style: { fontFamily: font, fontSize: 30, fontWeight: 400, color: muted, textAlign: "left", verticalAlign: "top", lineHeight: 1.3, padding: 8 }
        }
      ]
    }
  ]
});

await writeFile(deckPath, serializeDeck(deck));
console.log(`Wrote ${deckPath}`);
console.log(`Embedded ${introRef} and ${motionRef} in ${assetDir}`);
