import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString, type PDFPage, type PDFRef } from "pdf-lib";
import type { Deck } from "@slidepix/core";
import { resolveMediaPath } from "@slidepix/core/assets";

export type PdfVideoEmbedResult = {
  bytes: Uint8Array;
  embedded: number;
  warnings: string[];
};

type Box = { x: number; y: number; width: number; height: number; rotation: number };

type Placement = Box & {
  pageIndex: number;
  filePath?: string;
  fileName: string;
  mime: string;
  controls: boolean;
  autoplay: boolean;
  resolveError?: string;
};

export function videoPdfRect(slideWidth: number, slideHeight: number, pageWidth: number, pageHeight: number, box: Box): Box {
  const bounds = axisAlignedBounds(box);
  const scaleX = pageWidth / slideWidth;
  const scaleY = pageHeight / slideHeight;
  const width = bounds.width * scaleX;
  const height = bounds.height * scaleY;
  return {
    x: bounds.x * scaleX,
    y: pageHeight - (bounds.y * scaleY + height),
    width,
    height,
    rotation: 0
  };
}

export async function embedDeckVideos(pdfBytes: Uint8Array, deck: Deck, deckPath: string, allowedLinkedRoots: string[]): Promise<PdfVideoEmbedResult> {
  const placements = visibleVideos(deck, deckPath, allowedLinkedRoots);
  if (!placements.length) return { bytes: pdfBytes, embedded: 0, warnings: [] };
  const doc = await PDFDocument.load(pdfBytes);
  const warnings: string[] = [];
  let embedded = 0;
  for (const placement of placements) {
    if (placement.resolveError || !placement.filePath) {
      warnings.push(`Could not embed ${placement.fileName}: ${placement.resolveError ?? "missing path"}`);
      continue;
    }
    if (placement.pageIndex >= doc.getPageCount()) {
      warnings.push(`Video ${placement.fileName} is on a page the PDF does not contain.`);
      continue;
    }
    try {
      const bytes = new Uint8Array(await readFile(placement.filePath));
      const page = doc.getPage(placement.pageIndex);
      const rect = videoPdfRect(deck.size.width, deck.size.height, page.getWidth(), page.getHeight(), placement);
      addScreenVideo(doc, page, { ...rect, bytes, fileName: placement.fileName, mime: placement.mime, controls: placement.controls, autoplay: placement.autoplay });
      embedded += 1;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      warnings.push(`Could not embed ${placement.fileName}: ${detail}`);
    }
  }
  if (!embedded) return { bytes: pdfBytes, embedded: 0, warnings };
  return { bytes: await doc.save(), embedded, warnings };
}

function visibleVideos(deck: Deck, deckPath: string, allowedLinkedRoots: string[]): Placement[] {
  const videos: Placement[] = [];
  for (const [pageIndex, slide] of deck.slides.filter((item) => !item.hidden).entries()) {
    for (const element of slide.elements) {
      if (element.type !== "video" || element.hidden) continue;
      const fileName = safeVideoName(element.src, element.id);
      const placement: Placement = {
        pageIndex,
        x: element.x,
        y: element.y,
        width: element.width,
        height: element.height,
        rotation: element.rotation,
        fileName,
        mime: videoMime(fileName),
        controls: element.playback.controls,
        autoplay: element.playback.mode === "autoplay"
      };
      try {
        placement.filePath = resolveMediaPath(deckPath, element.src, element.storage, allowedLinkedRoots);
      } catch (error) {
        placement.resolveError = error instanceof Error ? error.message : String(error);
      }
      videos.push(placement);
    }
  }
  return videos;
}

function safeVideoName(reference: string, id: string): string {
  const base = path.basename(reference).replace(/[^\w.-]+/g, "_");
  return base && base !== "." && base !== ".." ? base : `${id}.mp4`;
}

function videoMime(fileName: string): string {
  const mime: Record<string, string> = { ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".ogv": "video/ogg" };
  return mime[path.extname(fileName).toLowerCase()] ?? "video/mp4";
}

function axisAlignedBounds(box: Box): Box {
  if (!box.rotation) return box;
  const radians = box.rotation * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  const corners = [[box.x, box.y], [box.x + box.width, box.y], [box.x, box.y + box.height], [box.x + box.width, box.y + box.height]];
  const rotated = corners.map(([x, y]) => {
    const dx = x! - centerX;
    const dy = y! - centerY;
    return [centerX + dx * cosine - dy * sine, centerY + dx * sine + dy * cosine];
  });
  const xs = rotated.map((point) => point[0]!);
  const ys = rotated.map((point) => point[1]!);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY, rotation: 0 };
}

function addScreenVideo(doc: PDFDocument, page: PDFPage, video: Box & { bytes: Uint8Array; fileName: string; mime: string; controls: boolean; autoplay: boolean }): void {
  const context = doc.context;
  const fileRef = context.register(context.stream(video.bytes, { Type: "EmbeddedFile", Subtype: video.mime }));
  const fileSpecRef = context.register(context.obj({
    Type: "Filespec",
    F: PDFString.of(video.fileName),
    UF: PDFString.of(video.fileName),
    EF: { F: fileRef }
  }));
  const annot = context.obj({
    Type: "Annot",
    Subtype: "Screen",
    Rect: [video.x, video.y, video.x + video.width, video.y + video.height],
    P: page.ref,
    Border: [0, 0, 0],
    F: 4,
    Contents: PDFString.of(video.fileName)
  }) as PDFDict;
  const annotRef = context.register(annot);
  const actionRef = context.register(context.obj({
    Type: "Action",
    S: "Rendition",
    OP: 0,
    AN: annotRef,
    R: {
      Type: "Rendition",
      S: "MR",
      C: {
        Type: "MediaClip",
        S: "MCD",
        CT: PDFString.of(video.mime),
        D: fileSpecRef,
        Alt: [PDFString.of(""), PDFString.of(video.fileName)],
        P: { TF: "TEMPACCESS" }
      },
      P: { Type: "MediaPlayParams", BE: { C: video.controls } }
    }
  }));
  annot.set(PDFName.of("A"), actionRef);
  pushAnnot(page, annotRef);
  if (video.autoplay) queuePageOpen(doc, page, actionRef);
}

function pushAnnot(page: PDFPage, annotRef: PDFRef): void {
  const existing = page.node.lookup(PDFName.of("Annots"));
  const annots = existing instanceof PDFArray ? existing : page.node.context.obj([]);
  if (!(existing instanceof PDFArray)) page.node.set(PDFName.of("Annots"), annots);
  annots.push(annotRef);
}

function queuePageOpen(doc: PDFDocument, page: PDFPage, actionRef: PDFRef): void {
  const name = PDFName.of("AA");
  const existing = page.node.lookup(name);
  if (existing instanceof PDFDict) {
    const previous = existing.get(PDFName.of("O"));
    if (previous) doc.context.lookup(actionRef, PDFDict).set(PDFName.of("Next"), previous);
    existing.set(PDFName.of("O"), actionRef);
    return;
  }
  page.node.set(name, doc.context.obj({ O: actionRef }));
}
