import { mkdir, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDeckText, renderDeckDocument } from "../packages/core/dist/index.js";
import { resolveMediaPath } from "../packages/core/dist/assets.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const input = resolve(process.argv[2] ?? resolve(root, "examples/research-talk.slidepix.json"));
const output = resolve(process.argv[3] ?? "/private/tmp/slidepix-render-smoke");
const parsed = parseDeckText(await readFile(input, "utf8"));
if (!parsed.ok) throw new Error(parsed.message);
await mkdir(output, { recursive: true });
const assets = new Map();
for (const slide of parsed.deck.slides) for (const element of slide.elements) {
  if (element.type !== "image" && element.type !== "video") continue;
  await loadAsset(element.src, element.storage);
  if (element.type === "video" && element.poster) await loadAsset(element.poster, "embedded");
}
const asset = (reference, storage) => assets.get(`${storage}:${reference}`) ?? reference;

const require = createRequire(import.meta.url);
const { chromium } = require(resolve(root, "packages/extension/vendor/playwright-core"));
const browser = await chromium.launch({ headless: true });
try {
  const print = await browser.newPage();
  await print.setContent(renderDeckDocument(parsed.deck, asset, { mode: "print" }), { waitUntil: "networkidle" });
  await print.pdf({
    path: resolve(output, "deck.pdf"),
    width: `${parsed.deck.size.width}px`,
    height: `${parsed.deck.size.height}px`,
    pageRanges: `1-${Math.max(1, parsed.deck.slides.filter((slide) => !slide.hidden).length)}`,
    printBackground: true,
    preferCSSPageSize: true,
    margin: { top: 0, right: 0, bottom: 0, left: 0 }
  });

  const contact = await browser.newPage({ viewport: { width: parsed.deck.size.width, height: parsed.deck.size.height } });
  await contact.setContent(renderDeckDocument(parsed.deck, asset, { mode: "contact", columns: 2 }), { waitUntil: "networkidle" });
  await contact.screenshot({ path: resolve(output, "contact.png"), fullPage: true });
  const single = contact.locator(".slidepix-slide").nth(Math.min(1, parsed.deck.slides.filter((slide) => !slide.hidden).length - 1));
  await single.screenshot({ path: resolve(output, "single-slide.png") });
} finally {
  await browser.close();
}

const pdf = await stat(resolve(output, "deck.pdf"));
const png = await stat(resolve(output, "contact.png"));
const singlePng = await stat(resolve(output, "single-slide.png"));
console.log(JSON.stringify({ pdfBytes: pdf.size, pngBytes: png.size, singlePngBytes: singlePng.size, output }));

async function loadAsset(reference, storage) {
  const key = `${storage}:${reference}`;
  if (assets.has(key)) return;
  const filePath = resolveMediaPath(input, reference, storage, [root, dirname(input)]);
  const bytes = await readFile(filePath);
  assets.set(key, `data:${mimeType(extname(filePath))};base64,${bytes.toString("base64")}`);
}

function mimeType(extension) {
  return ({
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
    ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime"
  })[extension.toLowerCase()] ?? "application/octet-stream";
}
