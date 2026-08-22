import { mkdir, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDeckText, renderDeckDocument } from "../packages/core/dist/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const input = resolve(process.argv[2] ?? resolve(root, "examples/research-talk.slidepix.json"));
const output = resolve(process.argv[3] ?? "/private/tmp/slidepix-render-smoke");
const parsed = parseDeckText(await readFile(input, "utf8"));
if (!parsed.ok) throw new Error(parsed.message);
await mkdir(output, { recursive: true });

const require = createRequire(import.meta.url);
const { chromium } = require(resolve(root, "packages/extension/vendor/playwright-core"));
const browser = await chromium.launch({ headless: true });
try {
  const print = await browser.newPage();
  await print.setContent(renderDeckDocument(parsed.deck, undefined, { mode: "print" }), { waitUntil: "networkidle" });
  await print.pdf({
    path: resolve(output, "deck.pdf"),
    width: `${parsed.deck.size.width}px`,
    height: `${parsed.deck.size.height}px`,
    printBackground: true,
    preferCSSPageSize: true,
    margin: { top: 0, right: 0, bottom: 0, left: 0 }
  });

  const contact = await browser.newPage({ viewport: { width: parsed.deck.size.width, height: parsed.deck.size.height } });
  await contact.setContent(renderDeckDocument(parsed.deck, undefined, { mode: "contact", columns: 2 }), { waitUntil: "networkidle" });
  await contact.screenshot({ path: resolve(output, "contact.png"), fullPage: true });
} finally {
  await browser.close();
}

const pdf = await stat(resolve(output, "deck.pdf"));
const png = await stat(resolve(output, "contact.png"));
console.log(JSON.stringify({ pdfBytes: pdf.size, pngBytes: png.size, output }));
