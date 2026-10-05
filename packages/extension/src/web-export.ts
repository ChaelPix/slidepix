import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { renderDeckDocument, type Deck, type MediaStorage } from "@slidepix/core";
import { resolveMediaPath } from "@slidepix/core/assets";

type MediaReference = { reference: string; storage: MediaStorage };

export class WebExportDestinationExistsError extends Error {
  constructor(readonly destination: string) {
    super(`Web export destination already exists: ${destination}`);
    this.name = "WebExportDestinationExistsError";
  }
}

export async function buildWebExport(
  deck: Deck,
  deckPath: string,
  destination: string,
  allowedLinkedRoots: string[]
): Promise<{ assetCount: number }> {
  if (await pathExists(destination)) throw new WebExportDestinationExistsError(destination);

  const parent = path.dirname(destination);
  const staging = await mkdtemp(path.join(parent, `.${path.basename(destination)}-`));
  let committed = false;
  try {
    const assetDirectory = path.join(staging, "assets");
    await mkdir(assetDirectory);

    const references = collectMediaReferences(deck);
    const resolvedAssets = new Map<string, string>();
    const filenameByHash = new Map<string, string>();
    for (const [key, item] of [...references].sort(([left], [right]) => left.localeCompare(right))) {
      const source = resolveMediaPath(deckPath, item.reference, item.storage, allowedLinkedRoots);
      const bytes = await readFile(source);
      const hash = createHash("sha256").update(bytes).digest("hex");
      let filename = filenameByHash.get(hash);
      if (!filename) {
        filename = `${hash}${safeExtension(source)}`;
        await writeFile(path.join(assetDirectory, filename), bytes, { flag: "wx" });
        filenameByHash.set(hash, filename);
      }
      resolvedAssets.set(key, `assets/${filename}`);
    }

    const html = addOfflineRuntime(renderDeckDocument(
      deck,
      (reference, storage) => resolvedAssets.get(mediaKey(reference, storage)) ?? reference,
      { mode: "present" }
    ), deck.slides.filter((slide) => !slide.hidden).length);
    await writeFile(path.join(staging, "index.html"), html, "utf8");

    if (await pathExists(destination)) throw new WebExportDestinationExistsError(destination);
    await rename(staging, destination);
    committed = true;
    return { assetCount: filenameByHash.size };
  } finally {
    if (!committed) await rm(staging, { recursive: true, force: true });
  }
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function collectMediaReferences(deck: Deck): Map<string, MediaReference> {
  const references = new Map<string, MediaReference>();
  for (const slide of deck.slides) {
    if (slide.hidden) continue;
    if (slide.backgroundImage) references.set(mediaKey(slide.backgroundImage.src, slide.backgroundImage.storage), { reference: slide.backgroundImage.src, storage: slide.backgroundImage.storage });
    for (const element of slide.elements) {
      if (element.hidden) continue;
      if (element.type === "manim") {
        if (element.outputMedia) references.set(mediaKey(element.outputMedia.src, element.outputMedia.storage), { reference: element.outputMedia.src, storage: element.outputMedia.storage });
        continue;
      }
      if (element.type !== "image" && element.type !== "video") continue;
      references.set(mediaKey(element.src, element.storage), { reference: element.src, storage: element.storage });
      if (element.type === "video" && element.poster) {
        references.set(mediaKey(element.poster, "embedded"), { reference: element.poster, storage: "embedded" });
      }
    }
  }
  return references;
}

function mediaKey(reference: string, storage: MediaStorage): string {
  return `${storage}\0${reference}`;
}

function safeExtension(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : "";
}

function addOfflineRuntime(html: string, slideCount: number): string {
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file: data:; media-src 'self' file:; style-src 'unsafe-inline' data:; script-src 'unsafe-inline'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">`;
  const controller = `<script data-slidepix-offline-controller>(function(){
const count=${slideCount},nextKeys=new Set(['ArrowRight','ArrowDown',' ','PageDown']),previousKeys=new Set(['ArrowLeft','ArrowUp','PageUp']);let index=0;
function next(){if(window.slidepixAdvance?.())return;if(index<count-1){index++;window.slidepixShow?.(index,'initial')}}
function previous(){if(index>0){index--;window.slidepixShow?.(index,'final')}}
addEventListener('keydown',event=>{if(nextKeys.has(event.key)){event.preventDefault();next()}else if(previousKeys.has(event.key)){event.preventDefault();previous()}});
addEventListener('click',()=>next());
})();</script>`;
  return html.replace("<head>", `<head>${csp}`).replace("</body>", `${controller}</body>`);
}
