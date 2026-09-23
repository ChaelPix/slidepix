import { randomUUID } from "node:crypto";
import { access, readFile, rename, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import PptxGenJS from "pptxgenjs";
import {
  parsePresentationMarkdown,
  type Deck,
  type PresentationMarkdownBlock,
  type PresentationTextRun,
  type Slide,
  type SlideElement,
  type TableElement,
  type TextElement,
  type VideoElement
} from "@slidepix/core";
import { resolveMediaPath } from "@slidepix/core/assets";
import {
  addPptxWarning,
  postProcessPptx,
  type PptxExportWarning,
  type PptxSlidePatch
} from "./pptx-ooxml";

export type { PptxExportWarning, PptxExportWarningCode } from "./pptx-ooxml";

export interface PptxExportResult {
  slideCount: number;
  nativeObjectCount: number;
  warnings: PptxExportWarning[];
}

interface BuildContext {
  deck: Deck;
  deckPath: string;
  allowedLinkedRoots: string[];
  warnings: PptxExportWarning[];
  nativeObjectCount: number;
  mathSequence: number;
}

export async function buildPptxExport(
  deck: Deck,
  deckPath: string,
  destination: string,
  allowedLinkedRoots: string[]
): Promise<PptxExportResult> {
  const visibleSlides = deck.slides.filter((slide) => !slide.hidden);
  if (!visibleSlides.length) throw new Error("The deck has no visible slides to export.");
  await validateMedia(deck, deckPath, allowedLinkedRoots);

  const context: BuildContext = { deck, deckPath, allowedLinkedRoots, warnings: [], nativeObjectCount: 0, mathSequence: 0 };
  addFontWarnings(context);
  const pptx = createPresentation(deck);
  const patches: PptxSlidePatch[] = [];

  for (let visibleIndex = 0; visibleIndex < visibleSlides.length; visibleIndex += 1) {
    const sourceSlide = visibleSlides[visibleIndex]!;
    const slide = pptx.addSlide();
    slide.background = background(sourceSlide, deck, context.warnings);
    if (sourceSlide.backgroundImage) {
      slide.addImage({
        path: resolveMediaPath(deckPath, sourceSlide.backgroundImage.src, sourceSlide.backgroundImage.storage, allowedLinkedRoots),
        x: 0,
        y: 0,
        w: inches(deck.size.width),
        h: inches(deck.size.height)
      });
    }
    if (sourceSlide.notes) slide.addNotes(sourceSlide.notes);
    const patch: PptxSlidePatch = { slide: sourceSlide, math: [], pictures: [], animationTargets: new Map() };
    const morphCounts = countMorphKeys(sourceSlide);

    for (const element of [...sourceSlide.elements].filter((item) => !item.hidden).sort((left, right) => left.z - right.z)) {
      patch.animationTargets.set(element.id, await addNativeElement(pptx, slide, element, sourceSlide, patch, context, morphCounts));
    }
    addPageNumber(slide, deck, sourceSlide, visibleIndex, context);
    patches.push(patch);
  }

  const generated = await pptx.write({ outputType: "nodebuffer", compression: true });
  const packageBytes = await postProcessPptx(Buffer.from(generated as Uint8Array), patches, context.warnings);
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}-${randomUUID()}.tmp.pptx`);
  try {
    await writeFile(temporary, packageBytes);
    await replaceFile(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  return { slideCount: visibleSlides.length, nativeObjectCount: context.nativeObjectCount, warnings: context.warnings };
}

function createPresentation(deck: Deck): PptxGenJS {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "SLIDEPIX", width: inches(deck.size.width), height: inches(deck.size.height) });
  pptx.layout = "SLIDEPIX";
  pptx.author = deck.metadata.author;
  pptx.title = deck.metadata.title;
  pptx.subject = deck.metadata.description;
  pptx.company = "SlidePix";
  pptx.revision = "1";
  pptx.theme = { headFontFace: fontFace(deck.theme.fontFamily), bodyFontFace: fontFace(deck.theme.fontFamily) };
  return pptx;
}

async function addNativeElement(
  pptx: PptxGenJS,
  slide: PptxGenJS.Slide,
  element: SlideElement,
  sourceSlide: Slide,
  patch: PptxSlidePatch,
  context: BuildContext,
  morphCounts: Map<string, number>
): Promise<string[]> {
  const name = nativeObjectName(element, morphCounts, sourceSlide, context.warnings);
  if (element.type === "text") return addTextElement(slide, element, name, sourceSlide, patch, context);
  if (element.type === "shape") {
    const fill = pptxColor(element.fill, element.opacity, context.warnings, sourceSlide.id, element.id);
    const stroke = pptxColor(element.stroke, element.opacity, context.warnings, sourceSlide.id, element.id);
    const shape = element.shape === "ellipse" ? pptx.ShapeType.ellipse : element.shape === "triangle" ? pptx.ShapeType.triangle : element.borderRadius > 0 ? pptx.ShapeType.roundRect : pptx.ShapeType.rect;
    slide.addShape(shape, {
      ...position(element, name), rotate: element.rotation,
      rectRadius: element.shape === "rectangle" && element.borderRadius > 0 ? Math.min(1, element.borderRadius / Math.max(1, Math.min(element.width, element.height) / 2)) : undefined,
      fill: fill.visible ? { color: fill.color, transparency: fill.transparency } : { type: "none" },
      line: stroke.visible && element.strokeWidth > 0 ? { color: stroke.color, transparency: stroke.transparency, width: points(element.strokeWidth) } : { type: "none" },
      shadow: element.shadow.enabled ? pptxShadow(element.shadow) : undefined
    });
    context.nativeObjectCount += 1;
    return [name];
  }
  if (element.type === "table") {
    addTable(slide, element, position(element, name), sourceSlide, context);
    context.nativeObjectCount += 1;
    return [name];
  }
  if (element.type === "image") {
    const source = resolveMediaPath(context.deckPath, element.src, element.storage, context.allowedLinkedRoots);
    slide.addImage({ ...position(element, name), path: source, rotate: element.rotation, transparency: Math.round((1 - element.opacity) * 100), altText: element.alt });
    patch.pictures.push({ objectName: name, crop: element.crop, borderRadius: element.borderRadius, edgeFade: element.edgeFade, border: element.border });
    if (element.edgeFade > 0) addPptxWarning(context.warnings, "edge-fade-approximated", "Image edge fade uses PowerPoint's native soft-edge effect, whose falloff differs slightly from SlidePix.", sourceSlide.id, element.id);
    context.nativeObjectCount += 1;
    return [name];
  }
  await addVideo(slide, element, name, patch, sourceSlide, context);
  context.nativeObjectCount += 1;
  return [name];
}

function addTextElement(
  slide: PptxGenJS.Slide,
  element: TextElement,
  baseName: string,
  sourceSlide: Slide,
  patch: PptxSlidePatch,
  context: BuildContext
): string[] {
  const blocks = parsePresentationMarkdown(element.markdown);
  const tables = blocks.filter((block): block is Extract<PresentationMarkdownBlock, { type: "table" }> => block.type === "table");
  const textBlocks = blocks.filter((block): block is Exclude<PresentationMarkdownBlock, { type: "table" }> => block.type !== "table");
  const names: string[] = [];
  const tableShare = tables.length ? Math.min(0.65, tables.length / Math.max(1, blocks.length)) : 0;
  const textHeight = element.height * (1 - tableShare);

  if (textBlocks.length || !tables.length) {
    const name = tables.length ? `${baseName} text` : baseName;
    const runs = pptxTextRuns(textBlocks, element, name, sourceSlide, patch, context);
    const paint = pptxColor(element.style.color, element.opacity, context.warnings, sourceSlide.id, element.id);
    slide.addText(runs.length ? runs : "", {
      x: inches(element.x), y: inches(element.y), w: inches(element.width), h: inches(textHeight || element.height),
      objectName: name, rotate: element.rotation, margin: points(element.style.padding),
      fontFace: fontFace(element.style.fontFamily), fontSize: points(element.style.fontSize), bold: isBold(element.style.fontWeight),
      color: paint.color, transparency: paint.transparency, align: element.style.textAlign, valign: element.style.verticalAlign,
      lineSpacingMultiple: element.style.lineHeight, fit: "shrink", isTextBox: true
    });
    names.push(name);
    context.nativeObjectCount += 1;
  }

  tables.forEach((table, tableIndex) => {
    const name = `${baseName} table ${tableIndex + 1}`;
    const height = element.height * tableShare / tables.length;
    addMarkdownTable(slide, table, element, {
      x: inches(element.x), y: inches(element.y + textHeight + height * tableIndex), w: inches(element.width), h: inches(height), objectName: name
    }, sourceSlide, context);
    names.push(name);
    context.nativeObjectCount += 1;
  });
  if (tables.length && textBlocks.length) addPptxWarning(context.warnings, "markdown-layout-approximated", "Mixed Markdown text and tables are divided vertically into native PowerPoint objects.", sourceSlide.id, element.id);
  return names;
}

function pptxTextRuns(
  blocks: Exclude<PresentationMarkdownBlock, { type: "table" }>[],
  element: TextElement,
  objectName: string,
  sourceSlide: Slide,
  patch: PptxSlidePatch,
  context: BuildContext
): PptxGenJS.TextProps[] {
  const output: PptxGenJS.TextProps[] = [];
  blocks.forEach((block, blockIndex) => {
    if (block.type === "code") {
      appendCodeRuns(output, block.runs);
    } else if (block.type === "math") output.push(mathRun(block.latex, true, element, objectName, sourceSlide, patch, context));
    else block.runs.forEach((run, runIndex) => {
      const converted = inlineRun(run, element, objectName, block.type === "heading" ? block.level : undefined, sourceSlide, patch, context);
      if (block.type === "list-item" && runIndex === 0) converted.options = {
        ...converted.options,
        bullet: block.ordered ? { type: "number", indent: points(28 + (block.level ?? 0) * 24) } : { type: "bullet", indent: points(28 + (block.level ?? 0) * 24) },
        indentLevel: block.level ?? 0
      };
      output.push(converted);
    });
    const last = output.at(-1);
    if (last && blockIndex < blocks.length - 1) last.options = { ...last.options, breakLine: true, paraSpaceAfter: points(element.style.fontSize * 0.22) };
  });
  return output;
}

function appendCodeRuns(output: PptxGenJS.TextProps[], runs: Extract<PresentationMarkdownBlock, { type: "code" }>["runs"]): void {
  let lineStart = output.length;
  for (const run of runs) {
    const options: PptxGenJS.TextProps["options"] = {
      fontFace: "Consolas",
      color: codeColor(run.token),
      italic: run.token === "hljs-comment" || run.token === "hljs-quote"
    };
    const parts = run.text.replace(/\r\n?/g, "\n").split("\n");
    parts.forEach((part, partIndex) => {
      if (part) output.push({ text: part, options: { ...options } });
      if (partIndex >= parts.length - 1) return;
      // PptxGenJS mutates a rich-text run that contains a newline and can make
      // every following syntax token its own paragraph. Mark the actual line
      // boundary explicitly instead, while keeping the tokens on that line.
      if (output.length === lineStart) output.push({ text: " ", options: { ...options } });
      const last = output.at(-1)!;
      last.options = { ...last.options, breakLine: true };
      lineStart = output.length;
    });
  }
}

function inlineRun(
  run: PresentationTextRun,
  element: TextElement,
  objectName: string,
  headingLevel: number | undefined,
  sourceSlide: Slide,
  patch: PptxSlidePatch,
  context: BuildContext
): PptxGenJS.TextProps {
  if (run.kind === "math") return mathRun(run.latex, false, element, objectName, sourceSlide, patch, context);
  const scale = headingLevel === 1 ? 1.3 : headingLevel === 2 ? 1.15 : 1;
  return { text: run.text, options: {
    bold: run.bold || headingLevel !== undefined || isBold(element.style.fontWeight), italic: run.italic,
    strike: run.strike ? "sngStrike" : undefined, fontFace: run.code ? "Consolas" : fontFace(element.style.fontFamily),
    fontSize: points(element.style.fontSize * scale), hyperlink: run.href ? { url: run.href } : undefined
  } };
}

function mathRun(latex: string, display: boolean, element: TextElement, objectName: string, slide: Slide, patch: PptxSlidePatch, context: BuildContext): PptxGenJS.TextProps {
  const placeholder = `SLIDEPIX_MATH_${++context.mathSequence}_${randomUUID().replaceAll("-", "")}`;
  patch.math.push({ placeholder, latex, display, objectName, slideId: slide.id, elementId: element.id });
  return { text: placeholder, options: { fontFace: "Cambria Math", fontSize: points(element.style.fontSize) } };
}

function addMarkdownTable(
  slide: PptxGenJS.Slide,
  table: Extract<PresentationMarkdownBlock, { type: "table" }>,
  element: TextElement,
  box: { x: number; y: number; w: number; h: number; objectName: string },
  sourceSlide: Slide,
  context: BuildContext
): void {
  const rows = table.rows.map((row) => row.map((cell) => ({
    text: cell.map((run) => run.kind === "math" ? run.latex : run.text).join(""),
    options: { fontFace: fontFace(element.style.fontFamily), fontSize: points(element.style.fontSize * 0.8), margin: points(element.style.padding) }
  }))) as PptxGenJS.TableRow[];
  slide.addTable(rows, { ...box, autoPage: false, border: { type: "solid", color: "94A3B8", pt: 1 }, fill: { color: "FFFFFF" } });
  if (table.rows.some((row) => row.some((cell) => cell.some((run) => run.kind === "math")))) addPptxWarning(context.warnings, "math-linearized", "Math inside a Markdown table is exported as editable linear text because PowerPoint table cells cannot contain OfficeMath objects.", sourceSlide.id, element.id);
}

function addTable(
  slide: PptxGenJS.Slide,
  element: TableElement,
  box: { x: number; y: number; w: number; h: number; objectName: string },
  sourceSlide: Slide,
  context: BuildContext
): void {
  const textPaint = pptxColor(element.style.color, element.opacity, context.warnings, sourceSlide.id, element.id);
  const borderPaint = pptxColor(element.style.borderColor, element.opacity, context.warnings, sourceSlide.id, element.id);
  const border = borderPaint.visible && element.style.borderWidth > 0 ? { type: "solid" as const, color: borderPaint.color, pt: points(element.style.borderWidth) } : { type: "none" as const };
  const rows: PptxGenJS.TableRow[] = Array.from({ length: element.rows }, (_, row) => Array.from({ length: element.columns }, (_, column) => {
    const fill = pptxColor(row === 0 && element.headerRow ? element.style.headerFill : element.style.cellFill, element.opacity, context.warnings, sourceSlide.id, element.id);
    const blocks = parsePresentationMarkdown(element.cells[row]?.[column] ?? "");
    const containsMath = blocks.some((block) => block.type === "math" || ((block.type === "paragraph" || block.type === "heading" || block.type === "list-item") && block.runs.some((run) => run.kind === "math")));
    if (containsMath) addPptxWarning(context.warnings, "math-linearized", "Math inside a table cell is exported as editable linear text because PowerPoint table cells cannot contain OfficeMath objects.", sourceSlide.id, element.id);
    return { text: blocks.map(blockPlainText).join("\n"), options: {
      fontFace: fontFace(element.style.fontFamily), fontSize: points(element.style.fontSize), bold: row === 0 && element.headerRow ? true : isBold(element.style.fontWeight),
      color: textPaint.color, transparency: textPaint.transparency, align: row === 0 && element.headerRow ? "center" : element.style.textAlign,
      valign: element.style.verticalAlign, margin: points(element.style.padding), fill: fill.visible ? { color: fill.color, transparency: fill.transparency } : { type: "none" as const }, border
    } };
  }));
  slide.addTable(rows, {
    ...box, rowH: Array.from({ length: element.rows }, () => box.h / element.rows), colW: Array.from({ length: element.columns }, () => box.w / element.columns),
    margin: points(element.style.padding), fontFace: fontFace(element.style.fontFamily), fontSize: points(element.style.fontSize),
    color: textPaint.color, transparency: textPaint.transparency, bold: isBold(element.style.fontWeight), align: element.style.textAlign,
    valign: element.style.verticalAlign, border, autoPage: false
  });
  if (element.rotation !== 0) addPptxWarning(context.warnings, "table-rotation-omitted", "PowerPoint does not support rotating native tables, so this table remains editable without rotation.", sourceSlide.id, element.id);
}

async function addVideo(slide: PptxGenJS.Slide, element: VideoElement, name: string, patch: PptxSlidePatch, sourceSlide: Slide, context: BuildContext): Promise<void> {
  const source = resolveMediaPath(context.deckPath, element.src, element.storage, context.allowedLinkedRoots);
  const cover = element.poster ? await dataUri(resolveMediaPath(context.deckPath, element.poster, "embedded", context.allowedLinkedRoots)) : undefined;
  slide.addMedia({ ...position(element, name), type: "video", path: source, cover });
  patch.pictures.push({ objectName: name, borderRadius: element.borderRadius, opacity: element.opacity, rotation: element.rotation });
  if (element.playback.muted || element.playback.loop || !element.playback.controls || element.playback.mode === "autoplay") addPptxWarning(context.warnings, "video-playback-approximated", "The video remains embedded and editable, but PowerPoint may not preserve every SlidePix mute, loop, controls, or autoplay preference.", sourceSlide.id, element.id);
}

function addPageNumber(slide: PptxGenJS.Slide, deck: Deck, sourceSlide: Slide, visibleIndex: number, context: BuildContext): void {
  const paint = pptxColor(deck.pageNumbers.color, 1, context.warnings, sourceSlide.id);
  slide.addText(String(visibleIndex + 1), {
    x: inches(deck.size.width - 160), y: inches(deck.size.height - 64), w: inches(128), h: inches(44), margin: 0,
    align: "right", valign: "bottom", fontSize: points(deck.pageNumbers.fontSize), fontFace: fontFace(deck.theme.fontFamily),
    color: paint.color, transparency: paint.transparency, objectName: `SlidePix page number ${visibleIndex + 1}`
  });
  context.nativeObjectCount += 1;
}

function nativeObjectName(element: SlideElement, counts: Map<string, number>, slide: Slide, warnings: PptxExportWarning[]): string {
  if ((counts.get(element.morphKey) ?? 0) === 1) return `!!${element.morphKey}`;
  addPptxWarning(warnings, "morph-match-ambiguous", `Morph key “${element.morphKey}” is duplicated on this slide; PowerPoint matching uses the element ID for this object.`, slide.id, element.id);
  return `!!${element.morphKey}-${element.id}`;
}

function countMorphKeys(slide: Slide): Map<string, number> {
  const result = new Map<string, number>();
  for (const element of slide.elements.filter((item) => !item.hidden)) result.set(element.morphKey, (result.get(element.morphKey) ?? 0) + 1);
  return result;
}

function addFontWarnings(context: BuildContext): void {
  const fonts = new Set([context.deck.theme.fontFamily]);
  for (const slide of context.deck.slides.filter((item) => !item.hidden)) for (const element of slide.elements.filter((item) => !item.hidden)) if (element.type === "text" || element.type === "table") fonts.add(element.style.fontFamily);
  for (const font of fonts) addPptxWarning(context.warnings, "font-not-embedded", `Font “${fontFace(font)}” is referenced but not embedded; PowerPoint may substitute it when unavailable.`);
}

async function validateMedia(deck: Deck, deckPath: string, allowedLinkedRoots: string[]): Promise<void> {
  for (const slide of deck.slides) {
    if (slide.hidden) continue;
    if (slide.backgroundImage) await access(resolveMediaPath(deckPath, slide.backgroundImage.src, slide.backgroundImage.storage, allowedLinkedRoots));
    for (const element of slide.elements) {
      if (element.hidden || (element.type !== "image" && element.type !== "video")) continue;
      await access(resolveMediaPath(deckPath, element.src, element.storage, allowedLinkedRoots));
      if (element.type === "video" && element.poster) await access(resolveMediaPath(deckPath, element.poster, "embedded", allowedLinkedRoots));
    }
  }
}

function background(slide: Slide, deck: Deck, warnings: PptxExportWarning[]): PptxGenJS.BackgroundProps {
  const paint = pptxColor(slide.background ?? deck.layouts[slide.layout ?? ""]?.background ?? deck.theme.background, 1, warnings, slide.id);
  return paint.visible ? { color: paint.color, transparency: paint.transparency } : { color: "FFFFFF", transparency: 100 };
}

function blockPlainText(block: PresentationMarkdownBlock): string {
  if (block.type === "code") return block.code;
  if (block.type === "math") return block.latex;
  if (block.type === "table") return block.rows.map((row) => row.map((cell) => cell.map((run) => run.kind === "math" ? run.latex : run.text).join("")).join("\t")).join("\n");
  return block.runs.map((run) => run.kind === "math" ? run.latex : run.text).join("");
}

function position(element: SlideElement, objectName: string): { x: number; y: number; w: number; h: number; objectName: string } {
  return { x: inches(element.x), y: inches(element.y), w: inches(element.width), h: inches(element.height), objectName };
}

function pptxColor(value: string, opacity: number, warnings?: PptxExportWarning[], slideId?: string, elementId?: string): { color: string; transparency: number; visible: boolean } {
  const text = value.trim();
  if (text.toLowerCase() === "transparent") return { color: "FFFFFF", transparency: 100, visible: false };
  let match = /^#([0-9a-f]{3})([0-9a-f])?$/i.exec(text);
  if (match) {
    const color = [...match[1]!].map((digit) => digit + digit).join("").toUpperCase();
    const alpha = match[2] ? Number.parseInt(match[2] + match[2], 16) / 255 : 1;
    return { color, transparency: transparency(alpha * opacity), visible: alpha * opacity > 0 };
  }
  match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(text);
  if (match) {
    const alpha = match[2] ? Number.parseInt(match[2], 16) / 255 : 1;
    return { color: match[1]!.toUpperCase(), transparency: transparency(alpha * opacity), visible: alpha * opacity > 0 };
  }
  match = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(text);
  if (match) {
    const color = [match[1], match[2], match[3]].map((item) => Math.max(0, Math.min(255, Number(item))).toString(16).padStart(2, "0")).join("").toUpperCase();
    const alpha = match[4] === undefined ? 1 : Math.max(0, Math.min(1, Number(match[4])));
    return { color, transparency: transparency(alpha * opacity), visible: alpha * opacity > 0 };
  }
  const named = ({ black: "000000", white: "FFFFFF", red: "FF0000", green: "008000", blue: "0000FF", yellow: "FFFF00", gray: "808080", grey: "808080", orange: "FFA500", purple: "800080" } as Record<string, string>)[text.toLowerCase()];
  if (named) return { color: named, transparency: transparency(opacity), visible: opacity > 0 };
  if (warnings) addPptxWarning(warnings, "color-approximated", `Color “${value}” is not directly representable and was exported as black.`, slideId, elementId);
  return { color: "000000", transparency: transparency(opacity), visible: opacity > 0 };
}

function pptxShadow(shadow: Extract<SlideElement, { type: "shape" }>["shadow"]): PptxGenJS.ShadowProps {
  const paint = pptxColor(shadow.color, 1);
  return { type: "outer", color: paint.color, opacity: (100 - paint.transparency) / 100, blur: points(shadow.blur), offset: points(Math.hypot(shadow.offsetX, shadow.offsetY)), angle: (Math.atan2(shadow.offsetY, shadow.offsetX) * 180 / Math.PI + 360) % 360 };
}

function fontFace(stack: string): string {
  const first = stack.split(",")[0]?.trim().replace(/^['"]|['"]$/g, "") || "Arial";
  return ["system-ui", "-apple-system", "BlinkMacSystemFont", "sans-serif"].includes(first) ? "Arial" : first;
}
function isBold(weight: TextElement["style"]["fontWeight"]): boolean { return typeof weight === "number" ? weight >= 600 : /bold|[6-9]00/i.test(weight); }
function codeColor(token: string | undefined): string {
  if (["hljs-keyword", "hljs-selector-tag", "hljs-literal"].includes(token ?? "")) return "C084FC";
  if (["hljs-string", "hljs-attr"].includes(token ?? "")) return "A7F3D0";
  if (["hljs-number", "hljs-symbol"].includes(token ?? "")) return "FBBF24";
  if (["hljs-title", "hljs-function"].includes(token ?? "")) return "7DD3FC";
  if (["hljs-built_in", "hljs-type"].includes(token ?? "")) return "F9A8D4";
  if (["hljs-comment", "hljs-quote"].includes(token ?? "")) return "94A3B8";
  if (token === "hljs-meta") return "FB923C";
  return "E2E8F0";
}

const LOGICAL_PIXELS_PER_INCH = 144;
function points(pixels: number): number { return pixels * 72 / LOGICAL_PIXELS_PER_INCH; }
function inches(pixels: number): number { return pixels / LOGICAL_PIXELS_PER_INCH; }
function transparency(opacity: number): number { return Math.max(0, Math.min(100, Math.round((1 - opacity) * 100))); }

async function dataUri(filePath: string): Promise<string> {
  const extension = path.extname(filePath).toLowerCase();
  const mime = extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : extension === ".gif" ? "image/gif" : extension === ".svg" ? "image/svg+xml" : "image/png";
  return `data:${mime};base64,${(await readFile(filePath)).toString("base64")}`;
}

async function replaceFile(temporary: string, destination: string): Promise<void> {
  try { await rename(temporary, destination); }
  catch (error) {
    if (!(["EEXIST", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? ""))) throw error;
    const backup = `${destination}.${randomUUID()}.bak`;
    await rename(destination, backup);
    try { await rename(temporary, destination); await rm(backup, { force: true }); }
    catch (replacementError) { try { await rename(backup, destination); } catch { /* keep backup */ } throw replacementError; }
  }
}
