import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { deckSchema, serializeDeck } from "../packages/core/dist/index.js";

const hero = process.argv[2];
const video = process.argv[3];
const poster = process.argv[4];
if (!hero) throw new Error("Usage: node scripts/build-demo.mjs <hero.png> [demo.mp4 poster.png]");
if (Boolean(video) !== Boolean(poster)) throw new Error("Video and poster references must be provided together.");

const font = "system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif";
const ink = "#111827";
const muted = "#475569";
const blue = "#2563eb";
const coral = "#ff735c";
const yellow = "#f6bd2f";

const common = (id, name, x, y, width, height, z = 1, morphKey = id) => ({
  id, morphKey, name, x, y, width, height, rotation: 0, opacity: 1, z, locked: false, hidden: false
});
const text = (id, name, markdown, x, y, width, height, size, color = ink, weight = 500, align = "left", morphKey = id) => ({
  ...common(id, name, x, y, width, height, 3, morphKey), type: "text", markdown,
  style: { fontFamily: font, fontSize: size, fontWeight: weight, color, textAlign: align, verticalAlign: "top", lineHeight: 1.18, padding: 6 }
});
const image = (id, name, x, y, width, height, crop, radius, fade, border, morphKey = id) => ({
  ...common(id, name, x, y, width, height, 2, morphKey), type: "image", src: hero, storage: "embedded", alt: "SlidePix presentation workflow illustration",
  crop, borderRadius: radius, edgeFade: fade, border
});
const shape = (id, name, kind, x, y, width, height, fill, radius = 0, stroke = "transparent", strokeWidth = 0, morphKey = id) => ({
  ...common(id, name, x, y, width, height, 1, morphKey), type: "shape", shape: kind, fill, stroke, strokeWidth, borderRadius: radius
});
const table = (id, name, x, y, width, height, cells) => ({
  ...common(id, name, x, y, width, height, 2), type: "table", rows: cells.length, columns: cells[0]?.length ?? 1, cells, headerRow: true,
  style: { fontFamily: font, fontSize: 28, fontWeight: 450, color: ink, headerFill: "#dbeafe", cellFill: "transparent", borderColor: "#93c5fd", borderWidth: 3, textAlign: "left", verticalAlign: "middle", padding: 16 }
});
const transition = (type, durationMs = 650) => ({ type, durationMs, easing: "ease-in-out" });
const animation = (id, targetElementId, effect, trigger = "onClick", direction, delayMs = 0, durationMs = 500) => ({
  id, targetElementId, phase: "entrance", effect, trigger, ...(direction ? { direction } : {}), delayMs, durationMs, easing: "ease-out"
});

const slides = [
  {
    id: "demo-01", title: "Build slides where you build everything else", background: "#ffffff", hidden: false, hidePageNumber: false,
    notes: "SlidePix is a visual presentation editor that lives directly in VS Code and Cursor.", transition: transition("none", 0),
    timeline: [animation("a01-title", "e01-title", "fade")],
    elements: [
      text("e01-kicker", "product-label", "**SLIDEPIX**", 105, 85, 700, 70, 30, blue, 800),
      text("e01-title", "hero-title", "# Build slides where you build everything else", 100, 190, 820, 360, 76, ink, 780),
      text("e01-copy", "hero-copy", "A visual editor for VS Code and Cursor—with Markdown, $x^2$, media, motion, presenter view, and deterministic export.", 110, 595, 760, 230, 35, muted, 450),
      shape("e01-line", "hero-accent", "rectangle", 110, 885, 760, 14, blue, 7),
      image("e01-image", "generated-product-visual", 995, 125, 800, 780, { x: 0.14, y: 0, width: 0.78, height: 1 }, 52, 0, { width: 5, color: blue })
    ]
  },
  {
    id: "demo-02", title: "One file, full control", background: "#f8fafc", hidden: false, hidePageNumber: false,
    notes: "The JSON stays readable and Git-friendly while the canvas remains visual.", transition: transition("fade"),
    timeline: [
      animation("a02-source", "e02-source", "fade"),
      animation("a02-card", "e02-card", "fly", "withPrevious", "right", 80),
      animation("a02-result", "e02-result", "appear")
    ],
    elements: [
      text("e02-title", "one-file-title", "# One file. Full control.", 105, 70, 1500, 130, 62, ink, 760),
      text("e02-source", "markdown-latex-code", "Markdown text and display math:\n\n$$E = mc^2$$\n\n```typescript\nconst deck = open(\"demo.slidepix.json\");\ndeck.present();\n```", 110, 235, 1050, 700, 36, ink, 450),
      shape("e02-card", "git-friendly-card", "rectangle", 1260, 260, 500, 420, "#ffffff", 36, "#dbeafe", 5),
      text("e02-card-copy", "git-friendly-copy", "## Human-readable\n\n- visual editing\n- stable JSON\n- relative assets\n- clean diffs", 1320, 320, 380, 330, 34, ink, 520),
      text("e02-result", "source-of-truth", "**The canvas and the file stay in sync.**", 1260, 755, 510, 130, 32, coral, 750, "center")
    ]
  },
  {
    id: "demo-table", title: "Tables and shape styling", background: "#ffffff", hidden: false, hidePageNumber: false,
    notes: "Tables use Markdown cells, centered headers, transparent fills, and the same renderer in the editor and every export.", transition: transition("slide-down", 700), timeline: [],
    elements: [
      text("e-table-title", "table-title", "# Structured data, still visual", 105, 65, 1600, 130, 62, ink, 760),
      table("e-table", "feature-table", 110, 245, 1080, 580, [
        ["**Capability**", "**Canvas**", "**Export**"],
        ["Markdown + $x^2$", "Live", "Exact"],
        ["Transparent cells", "Editable", "Portable"],
        ["Rows / columns", "One click", "Stable JSON"]
      ]),
      { ...shape("e-table-card", "transparent-shadow-card", "rectangle", 1300, 260, 500, 470, "transparent", 54, blue, 7), shadow: { enabled: true, color: "#0f172a40", offsetX: 22, offsetY: 28, blur: 34 } },
      text("e-table-card-copy", "table-card-copy", "## Designed on canvas\n\n- centered headers\n- transparent paint\n- soft shape shadow\n- Markdown cells", 1370, 335, 360, 320, 33, ink, 520),
      text("e-table-caption", "table-caption", "**Add or remove rows and columns from Properties.**", 1220, 825, 650, 80, 28, coral, 720, "center")
    ]
  },
  {
    id: "demo-03", title: "Media styling on canvas", background: "#ffffff", hidden: false, hidePageNumber: false,
    notes: "This slide is a visual check for image border, corner radius, crop, and four-sided edge fade.", transition: transition("slide-right", 750), timeline: [],
    elements: [
      text("e03-title", "media-title", "# Media that behaves like design", 105, 65, 1600, 130, 62, ink, 760),
      image("e03-left", "border-and-radius", 115, 245, 720, 610, { x: 0.02, y: 0.05, width: 0.88, height: 0.88 }, 95, 0, { width: 10, color: blue }),
      image("e03-right", "crop-and-fade", 1060, 245, 720, 610, { x: 0.2, y: 0.08, width: 0.64, height: 0.82 }, 130, 75, { width: 4, color: yellow }),
      text("e03-left-label", "border-label", "**Border + corner radius**", 160, 885, 630, 70, 30, blue, 720, "center"),
      text("e03-right-label", "crop-label", "**Crop + four-edge fade**", 1100, 885, 630, 70, 30, coral, 720, "center"),
      shape("e03-dot", "editable-shape", "ellipse", 900, 500, 92, 92, coral, 0, ink, 5)
    ]
  },
  {
    id: "demo-04", title: "Morph starts", background: "#f8fafc", hidden: false, hidePageNumber: false,
    notes: "The next slide shares morph keys and changes position, size, rotation, opacity, radius, and crop.", transition: transition("slide-up", 700), timeline: [],
    elements: [
      text("e04-title", "morph-title", "# Motion without rebuilding the slide", 105, 70, 1600, 130, 62, ink, 760, "left", "morph-title"),
      image("e04-image", "morph-image", 120, 255, 800, 620, { x: 0.02, y: 0, width: 0.88, height: 1 }, 40, 0, { width: 7, color: blue }, "morph-image"),
      shape("e04-line", "morph-line", "rectangle", 1080, 285, 620, 28, yellow, 14, "transparent", 0, "morph-line"),
      text("e04-copy", "morph-copy", "## Duplicate, move, present\n\nA shared `morphKey` connects objects across slides. No timeline authoring is required for the movement itself.", 1080, 365, 620, 360, 36, muted, 500, "left", "morph-copy")
    ]
  },
  {
    id: "demo-05", title: "Morph finishes", background: "#ffffff", hidden: false, hidePageNumber: false,
    notes: "Morph interpolates geometry and normalized image crop; unmatched objects crossfade.", transition: transition("morph", 1600), timeline: [],
    elements: [
      text("e05-title", "morph-title-finish", "# Motion without rebuilding the slide", 750, 95, 1050, 160, 58, ink, 760, "right", "morph-title"),
      { ...image("e05-image", "morph-image-finish", 910, 310, 760, 570, { x: 0.18, y: 0.06, width: 0.66, height: 0.86 }, 150, 0, { width: 7, color: yellow }, "morph-image"), rotation: 7 },
      { ...shape("e05-line", "morph-line-finish", "rectangle", 140, 780, 540, 28, yellow, 14, "transparent", 0, "morph-line"), rotation: 12 },
      text("e05-copy", "morph-copy-finish", "## The same objects, transformed\n\nPosition · size · rotation · opacity · radius · crop", 125, 270, 600, 380, 38, muted, 520, "left", "morph-copy"),
      text("e05-new", "crossfade-copy", "**Unmatched objects crossfade naturally.**", 130, 885, 650, 80, 28, coral, 760)
    ]
  }
];

if (video && poster) slides.push({
  id: "demo-06", title: "Present and export", background: "#f8fafc", hidden: false, hidePageNumber: false,
  notes: "The embedded video was generated from this deck's exported slide PNGs using FFmpeg.", transition: transition("slide-left", 750),
  timeline: [animation("a06-circle", "e06-circle", "fly", "onClick", "up"), animation("a06-triangle", "e06-triangle", "fade", "withPrevious"), animation("a06-copy", "e06-copy", "appear")],
  elements: [
    text("e06-title", "present-title", "# Present. Export. Share.", 105, 65, 1600, 130, 62, ink, 760),
    { ...common("e06-video", "embedded-demo-reel", 110, 235, 1080, 610, 2), type: "video", src: video, storage: "embedded", poster, borderRadius: 44, playback: { mode: "manual", muted: true, loop: true, controls: true } },
    shape("e06-card", "delivery-card", "rectangle", 1280, 250, 500, 390, "#ffffff", 36, "#c7d2fe", 5),
    text("e06-copy", "delivery-copy", "## One deck, every output\n\n- fullscreen audience\n- presenter notes\n- PDF and PNG\n- read-only MCP review", 1335, 300, 390, 300, 32, ink, 520),
    shape("e06-circle", "circle-shape", "ellipse", 1320, 730, 125, 125, blue, 0, ink, 4),
    shape("e06-triangle", "triangle-shape", "triangle", 1510, 715, 150, 145, yellow),
    shape("e06-rect", "rectangle-shape", "rectangle", 1690, 740, 90, 115, coral, 18)
  ]
});

const deck = deckSchema.parse({
  schemaVersion: 1,
  id: "slidepix-product-demo",
  metadata: { title: "SlidePix product demo", author: "SlidePix", description: "Canonical light-theme demo and visual regression deck for SlidePix." },
  size: { width: 1920, height: 1080 },
  theme: { background: "#ffffff", foreground: ink, accent: blue, fontFamily: font },
  pageNumbers: { enabled: true, color: "#64748b", fontSize: 24 },
  layouts: {},
  slides
});

await writeFile(resolve("examples/slidepix-demo.slidepix.json"), serializeDeck(deck));
console.log(`Wrote examples/slidepix-demo.slidepix.json with ${slides.length} slides.`);
