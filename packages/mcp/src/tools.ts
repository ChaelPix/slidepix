import { readFile } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { join } from "node:path";
import type * as Playwright from "playwright-core";
import { parseDeckText, renderDeckDocument, type Deck, type MediaStorage, type Slide } from "@slidepix/core";
import { resolveMediaPath } from "@slidepix/core/assets";

export async function loadDeck(deckPath: string): Promise<Deck> {
  const parsed = parseDeckText(await readFile(deckPath, "utf8"));
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.deck;
}

export function selectSlides(deck: Deck, slideIds?: string[], indices?: number[]): Slide[] {
  if (slideIds?.length) {
    const wanted = new Set(slideIds);
    const slides = deck.slides.filter((slide) => wanted.has(slide.id));
    const missing = slideIds.filter((id) => !slides.some((slide) => slide.id === id));
    if (missing.length) throw new Error(`Unknown slide IDs: ${missing.join(", ")}`);
    return slides;
  }
  if (indices?.length) {
    return indices.map((index) => {
      const slide = deck.slides[index - 1];
      if (!slide) throw new Error(`Slide index ${index} is out of range (indices are 1-based).`);
      return slide;
    });
  }
  return deck.slides.filter((slide) => !slide.hidden);
}

export async function renderSlidesToPng(
  deckPath: string,
  deck: Deck,
  slides: Slide[],
  options: { layout?: "grid" | "row" | "column"; columns?: number; scale?: number }
): Promise<Buffer> {
  const scale = Math.min(3, Math.max(0.1, options.scale ?? 1));
  const columns = options.layout === "row" ? slides.length : options.layout === "column" ? 1 : Math.max(1, options.columns ?? Math.ceil(Math.sqrt(slides.length)));
  const assets = await collectAssets(deckPath, slides);
  const html = renderDeckDocument(deck, (reference, storage) => assets.get(mediaKey(reference, storage)) ?? reference, { mode: "contact", selectedSlideIds: slides.map((slide) => slide.id), columns });
  const executablePath = playwright().chromium.executablePath();
  try { await readFile(executablePath); } catch { throw new Error("SlidePix renderer is not installed. Run ‘SlidePix: Configure MCP’ or ‘SlidePix: Install Export Renderer’ in VS Code/Cursor."); }
  const browser = await playwright().chromium.launch({ headless: true, executablePath });
  try {
    const width = Math.ceil(columns * deck.size.width * scale + (columns + 1) * 32);
    const rows = Math.ceil(slides.length / columns);
    const height = Math.ceil(rows * deck.size.height * scale + (rows + 1) * 32);
    const page = await browser.newPage({ viewport: { width: Math.max(800, width), height: Math.max(600, height) }, deviceScaleFactor: scale });
    await page.setContent(html, { waitUntil: "networkidle" });
    return await page.screenshot({ fullPage: true, type: "png" });
  } finally {
    await browser.close();
  }
}

async function collectAssets(deckPath: string, slides: Slide[]): Promise<Map<string, string>> {
  const references = new Map<string, { reference: string; storage: MediaStorage }>();
  for (const slide of slides) for (const element of slide.elements) {
    if (element.type === "image" || element.type === "video") references.set(mediaKey(element.src, element.storage), { reference: element.src, storage: element.storage });
    if (element.type === "video" && element.poster) references.set(mediaKey(element.poster, "embedded"), { reference: element.poster, storage: "embedded" });
  }
  const result = new Map<string, string>();
  await Promise.all([...references].map(async ([key, { reference, storage }]) => {
    const filePath = resolveMediaPath(deckPath, reference, storage, [process.cwd(), dirname(deckPath)]);
    const bytes = await readFile(filePath);
    result.set(key, `data:${mimeType(extname(filePath))};base64,${bytes.toString("base64")}`);
  }));
  return result;
}

function mediaKey(reference: string, storage: MediaStorage): string {
  return `${storage}:${reference}`;
}

function mimeType(extension: string): string {
  return ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".mp4": "video/mp4", ".webm": "video/webm" } as Record<string, string>)[extension.toLowerCase()] ?? "application/octet-stream";
}

function playwright(): typeof Playwright {
  return require(join(__dirname, "..", "vendor", "playwright-core")) as typeof Playwright;
}
