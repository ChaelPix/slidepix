import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDeckText, renderDeckDocument } from "../packages/core/dist/index.js";
import { resolveMediaPath } from "../packages/core/dist/assets.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const input = resolve(process.argv[2] ?? resolve(root, "examples/slidepix-demo.slidepix.json"));
const output = resolve(process.argv[3] ?? "/private/tmp/slidepix-render-smoke");
const parsed = parseDeckText(await readFile(input, "utf8"));
if (!parsed.ok) throw new Error(parsed.message);
await mkdir(output, { recursive: true });
await mkdir(resolve(output, "slides"), { recursive: true });
const assets = new Map();
for (const slide of parsed.deck.slides) for (const element of slide.elements) {
  if (element.type !== "image" && element.type !== "video") continue;
  await loadAsset(element.src, element.storage);
  if (element.type === "video" && element.poster) await loadAsset(element.poster, "embedded");
}
const asset = (reference, storage) => assets.get(`${storage}:${reference}`) ?? reference;
const browser = browserExecutable();
const profile = resolve(tmpdir(), `slidepix-smoke-${process.pid}`);

await renderHtml(browser, renderDeckDocument(parsed.deck, asset, { mode: "print" }), {
  pdf: resolve(output, "deck.pdf")
});
await renderHtml(browser, renderDeckDocument(parsed.deck, asset, { mode: "contact", columns: 2 }), {
  screenshot: resolve(output, "contact.png"),
  width: parsed.deck.size.width * 2 + 96,
  height: parsed.deck.size.height + 96
});

const visibleSlides = parsed.deck.slides.filter((slide) => !slide.hidden);
for (const [index, slide] of visibleSlides.entries()) {
  const slidePath = resolve(output, "slides", `slide-${String(index + 1).padStart(2, "0")}.png`);
  await renderHtml(browser, renderDeckDocument(parsed.deck, asset, { mode: "frame", selectedSlideIds: [slide.id] }), {
    screenshot: slidePath,
    width: parsed.deck.size.width,
    height: parsed.deck.size.height
  });
  if (index === Math.min(1, visibleSlides.length - 1)) {
    await renderHtml(browser, renderDeckDocument(parsed.deck, asset, { mode: "frame", selectedSlideIds: [slide.id] }), {
      screenshot: resolve(output, "single-slide.png"),
      width: parsed.deck.size.width,
      height: parsed.deck.size.height
    });
  }
}

const pdf = await stat(resolve(output, "deck.pdf"));
const png = await stat(resolve(output, "contact.png"));
const singlePng = await stat(resolve(output, "single-slide.png"));
console.log(JSON.stringify({ pdfBytes: pdf.size, pngBytes: png.size, singlePngBytes: singlePng.size, slidePngs: visibleSlides.length, output }));

async function renderHtml(executable, html, target) {
  const htmlPath = resolve(profile, `${Math.random().toString(16).slice(2)}.html`);
  await mkdir(profile, { recursive: true });
  await writeFile(htmlPath, html);
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--hide-scrollbars",
    "--allow-file-access-from-files",
    `--user-data-dir=${profile}`,
    "--virtual-time-budget=10000"
  ];
  if (target.pdf) args.push("--no-pdf-header-footer", `--print-to-pdf=${target.pdf}`);
  if (target.screenshot) args.push(`--window-size=${target.width},${target.height}`, `--screenshot=${target.screenshot}`);
  args.push(htmlPath);
  await run(executable, args);
  const produced = target.pdf ?? target.screenshot;
  if (!existsSync(produced)) throw new Error(`Browser did not write ${produced}`);
}

function run(executable, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`${executable} exited ${code}`)));
  });
}

function browserExecutable() {
  const candidates = process.platform === "darwin"
    ? [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Chromium.app/Contents/MacOS/Chromium"
      ]
    : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error("Google Chrome or Microsoft Edge must be installed to render the smoke PDF.");
  return found;
}

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
