import { z } from "zod";

export const CURRENT_SCHEMA_VERSION = 1 as const;

const finite = z.number().finite();
const nonNegative = finite.nonnegative();
const color = z.string().min(1);

export const transitionTypeSchema = z.enum([
  "none",
  "fade",
  "slide-left",
  "slide-right",
  "slide-up",
  "slide-down",
  "morph"
]);

export const transitionSchema = z.object({
  type: transitionTypeSchema.default("none"),
  durationMs: z.number().int().min(0).max(10_000).default(500),
  easing: z.string().default("ease-in-out")
});

const baseElementSchema = z.object({
  id: z.string().min(1),
  morphKey: z.string().min(1),
  x: finite,
  y: finite,
  width: nonNegative,
  height: nonNegative,
  rotation: finite.default(0),
  opacity: finite.min(0).max(1).default(1),
  z: z.number().int().default(0),
  locked: z.boolean().default(false),
  hidden: z.boolean().default(false),
  name: z.string().optional(),
  alt: z.string().optional()
});

export const textElementSchema = baseElementSchema.extend({
  type: z.literal("text"),
  markdown: z.string(),
  style: z.object({
    fontFamily: z.string().default("system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"),
    fontSize: nonNegative.default(48),
    fontWeight: z.union([z.string(), z.number()]).default(400),
    color: color.default("#111827"),
    textAlign: z.enum(["left", "center", "right"]).default("left"),
    verticalAlign: z.enum(["top", "middle", "bottom"]).default("top"),
    lineHeight: finite.positive().default(1.2),
    padding: nonNegative.default(8)
  })
});

export const cropSchema = z.object({
  x: finite.min(0).max(1).default(0),
  y: finite.min(0).max(1).default(0),
  width: finite.positive().max(1).default(1),
  height: finite.positive().max(1).default(1)
});

export const borderSchema = z.object({
  width: nonNegative.default(0),
  color: color.default("transparent")
});

export const shadowSchema = z.object({
  enabled: z.boolean().default(false),
  color: color.default("#00000040"),
  offsetX: finite.default(0),
  offsetY: finite.default(12),
  blur: nonNegative.default(24)
});

export const mediaStorageSchema = z.enum(["embedded", "linked"]);

export const imageElementSchema = baseElementSchema.extend({
  type: z.literal("image"),
  src: z.string().min(1),
  storage: mediaStorageSchema.default("embedded"),
  crop: cropSchema.default({ x: 0, y: 0, width: 1, height: 1 }),
  borderRadius: nonNegative.default(0),
  edgeFade: nonNegative.default(0),
  border: borderSchema.default({ width: 0, color: "transparent" })
});

export const videoElementSchema = baseElementSchema.extend({
  type: z.literal("video"),
  src: z.string().min(1),
  storage: mediaStorageSchema.default("embedded"),
  poster: z.string().optional(),
  borderRadius: nonNegative.default(0),
  playback: z.object({
    mode: z.enum(["autoplay", "manual"]).default("manual"),
    muted: z.boolean().default(false),
    loop: z.boolean().default(false),
    controls: z.boolean().default(true)
  })
});

export const shapeElementSchema = baseElementSchema.extend({
  type: z.literal("shape"),
  shape: z.enum(["rectangle", "ellipse", "triangle"]),
  fill: color.default("#2563eb"),
  stroke: color.default("transparent"),
  strokeWidth: nonNegative.default(0),
  borderRadius: nonNegative.default(0),
  shadow: shadowSchema.default({ enabled: false, color: "#00000040", offsetX: 0, offsetY: 12, blur: 24 })
});

export const tableElementSchema = baseElementSchema.extend({
  type: z.literal("table"),
  rows: z.number().int().min(1).max(50).default(3),
  columns: z.number().int().min(1).max(20).default(3),
  cells: z.array(z.array(z.string())).default([]),
  headerRow: z.boolean().default(true),
  style: z.object({
    fontFamily: z.string().default("system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"),
    fontSize: nonNegative.default(30),
    fontWeight: z.union([z.string(), z.number()]).default(400),
    color: color.default("#111827"),
    headerFill: color.default("#e0e7ff"),
    cellFill: color.default("#ffffff"),
    borderColor: color.default("#94a3b8"),
    borderWidth: nonNegative.default(2),
    textAlign: z.enum(["left", "center", "right"]).default("left"),
    verticalAlign: z.enum(["top", "middle", "bottom"]).default("middle"),
    padding: nonNegative.default(10)
  }).default({
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif",
    fontSize: 30,
    fontWeight: 400,
    color: "#111827",
    headerFill: "#e0e7ff",
    cellFill: "#ffffff",
    borderColor: "#94a3b8",
    borderWidth: 2,
    textAlign: "left",
    verticalAlign: "middle",
    padding: 10
  })
});

export const elementSchema = z.discriminatedUnion("type", [
  textElementSchema,
  imageElementSchema,
  videoElementSchema,
  shapeElementSchema,
  tableElementSchema
]);

export const animationStepSchema = z.object({
  id: z.string().min(1),
  targetElementId: z.string().min(1),
  phase: z.enum(["entrance", "exit"]).default("entrance"),
  effect: z.enum(["appear", "fade", "fly"]).default("fade"),
  trigger: z.enum(["onClick", "withPrevious", "afterPrevious"]).default("onClick"),
  direction: z.enum(["left", "right", "up", "down"]).optional(),
  delayMs: z.number().int().min(0).max(60_000).default(0),
  durationMs: z.number().int().min(0).max(60_000).default(500),
  easing: z.string().default("ease-out")
});

export const slideSchema = z.object({
  id: z.string().min(1),
  title: z.string().default("Untitled slide"),
  layout: z.string().optional(),
  background: color.optional(),
  notes: z.string().default(""),
  hidden: z.boolean().default(false),
  hidePageNumber: z.boolean().default(false),
  transition: transitionSchema.default({ type: "none", durationMs: 500, easing: "ease-in-out" }),
  timeline: z.array(animationStepSchema).default([]),
  elements: z.array(elementSchema).default([])
});

export const deckSchema = z.object({
  schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
  id: z.string().min(1),
  metadata: z.object({
    title: z.string().default("Untitled deck"),
    author: z.string().default(""),
    description: z.string().default("")
  }),
  size: z.object({
    width: finite.positive().default(1920),
    height: finite.positive().default(1080)
  }),
  theme: z.object({
    background: color.default("#ffffff"),
    foreground: color.default("#111827"),
    accent: color.default("#38bdf8"),
    fontFamily: z.string().default("system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif")
  }),
  pageNumbers: z.object({
    enabled: z.boolean().default(true),
    color: color.default("#94a3b8"),
    fontSize: nonNegative.default(24)
  }),
  layouts: z.record(z.string(), z.object({
    name: z.string(),
    background: color.optional()
  })).default({}),
  slides: z.array(slideSchema).min(1)
}).superRefine((deck, context) => {
  const slideIds = new Set<string>();
  const elementIds = new Set<string>();
  const animationIds = new Set<string>();

  deck.slides.forEach((slide, slideIndex) => {
    if (slideIds.has(slide.id)) {
      context.addIssue({ code: "custom", path: ["slides", slideIndex, "id"], message: `Duplicate slide id: ${slide.id}` });
    }
    slideIds.add(slide.id);

    if (slide.layout && !Object.hasOwn(deck.layouts, slide.layout)) {
      context.addIssue({ code: "custom", path: ["slides", slideIndex, "layout"], message: `Unknown layout: ${slide.layout}` });
    }

    const slideElementIds = new Set<string>();
    slide.elements.forEach((element, elementIndex) => {
      if (elementIds.has(element.id)) {
        context.addIssue({ code: "custom", path: ["slides", slideIndex, "elements", elementIndex, "id"], message: `Duplicate element id: ${element.id}` });
      }
      elementIds.add(element.id);
      slideElementIds.add(element.id);
    });

    slide.timeline.forEach((step, stepIndex) => {
      if (animationIds.has(step.id)) {
        context.addIssue({ code: "custom", path: ["slides", slideIndex, "timeline", stepIndex, "id"], message: `Duplicate animation id: ${step.id}` });
      }
      animationIds.add(step.id);
      if (!slideElementIds.has(step.targetElementId)) {
        context.addIssue({ code: "custom", path: ["slides", slideIndex, "timeline", stepIndex, "targetElementId"], message: `Unknown animation target: ${step.targetElementId}` });
      }
    });
  });
});

export type Deck = z.infer<typeof deckSchema>;
export type Slide = z.infer<typeof slideSchema>;
export type SlideElement = z.infer<typeof elementSchema>;
export type TextElement = z.infer<typeof textElementSchema>;
export type ImageElement = z.infer<typeof imageElementSchema>;
export type VideoElement = z.infer<typeof videoElementSchema>;
export type ShapeElement = z.infer<typeof shapeElementSchema>;
export type TableElement = z.infer<typeof tableElementSchema>;
export type MediaStorage = z.infer<typeof mediaStorageSchema>;
export type AnimationStep = z.infer<typeof animationStepSchema>;
export type Transition = z.infer<typeof transitionSchema>;

export type ParseDeckResult =
  | { ok: true; deck: Deck }
  | { ok: false; message: string; issues?: z.core.$ZodIssue[] };

export function parseDeckText(text: string): ParseDeckResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Invalid JSON" };
  }

  if (typeof value === "object" && value !== null && "schemaVersion" in value) {
    const version = (value as { schemaVersion?: unknown }).schemaVersion;
    if (typeof version === "number" && version > CURRENT_SCHEMA_VERSION) {
      return { ok: false, message: `This deck uses unsupported schema version ${version}.` };
    }
  }

  const parsed = deckSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues.map((issue) => `${issue.path.join(".") || "deck"}: ${issue.message}`).join("\n"),
      issues: parsed.error.issues
    };
  }
  return { ok: true, deck: parsed.data };
}

export function serializeDeck(deck: Deck): string {
  return `${JSON.stringify(deckSchema.parse(deck), null, 2)}\n`;
}

export function createDeck(title = "Untitled deck"): Deck {
  const id = crypto.randomUUID();
  const slideId = crypto.randomUUID();
  return deckSchema.parse({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id,
    metadata: { title, author: "", description: "" },
    size: { width: 1920, height: 1080 },
    theme: {
      background: "#ffffff",
      foreground: "#111827",
      accent: "#2563eb",
      fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    },
    pageNumbers: { enabled: true, color: "#64748b", fontSize: 24 },
    layouts: {},
    slides: [{
      id: slideId,
      title: "Title slide",
      notes: "",
      hidden: false,
      transition: { type: "none", durationMs: 500, easing: "ease-in-out" },
      timeline: [],
      elements: [{
        id: crypto.randomUUID(),
        morphKey: crypto.randomUUID(),
        type: "text",
        x: 180,
        y: 360,
        width: 1560,
        height: 300,
        rotation: 0,
        opacity: 1,
        z: 0,
        locked: false,
        hidden: false,
        markdown: `# ${title}`,
        style: {
          fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif",
          fontSize: 72,
          fontWeight: 700,
          color: "#111827",
          textAlign: "center",
          verticalAlign: "middle",
          lineHeight: 1.1,
          padding: 8
        }
      }]
    }]
  });
}

export function duplicateSlide(slide: Slide): Slide {
  return {
    ...structuredClone(slide),
    id: crypto.randomUUID(),
    title: `${slide.title} copy`,
    elements: slide.elements.map((element) => ({ ...element, id: crypto.randomUUID() })),
    timeline: []
  };
}
