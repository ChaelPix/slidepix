import { toPng } from "html-to-image";

const CSS_URL = /url\(\s*(["']?)([^"')]+)\1\s*\)/gi;
const DATA_URL = /^(data:|blob:)/i;
const CAPTURE_TIMEOUT_MS = 20_000;

export function describeExportError(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause !== undefined ? `\nCaused by: ${describeExportError(error.cause)}` : "";
    const stack = error.stack && error.stack !== `${error.name}: ${error.message}` ? `\n${error.stack}` : "";
    return `${error.name}: ${error.message}${cause}${stack}`;
  }
  if (typeof Event !== "undefined" && error instanceof Event) {
    const target = error.target as { currentSrc?: string; src?: string; constructor?: { name?: string } } | null;
    const src = typeof target?.currentSrc === "string" && target.currentSrc || typeof target?.src === "string" && target.src || "";
    if (src || target?.constructor?.name === "HTMLImageElement") {
      return `HTMLImageElement ${error.type} event (src=${src || "(empty)"})`;
    }
    const name = target?.constructor?.name ?? "unknown";
    return `${error.type} event on ${name}`;
  }
  try {
    const json = JSON.stringify(error);
    if (json && json !== "{}") return json;
  } catch { /* Fall through to String. */ }
  return String(error);
}

export function cssUrls(value: string): string[] {
  const urls: string[] = [];
  for (const match of value.matchAll(CSS_URL)) {
    const url = match[2];
    if (url) urls.push(url);
  }
  return urls;
}

export async function withTimeout<T>(promise: Promise<T>, ms = CAPTURE_TIMEOUT_MS, message = `Timed out after ${ms}ms`): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function inlineImages(root: HTMLElement): Promise<() => void> {
  const restores: Array<() => void> = [];
  const images = [...root.querySelectorAll("img")];
  for (const img of images) {
    const original = img.getAttribute("src") ?? img.src;
    if (!original || DATA_URL.test(original)) continue;
    await waitForImage(img);
    const dataUrl = await imageToDataUri(img);
    img.setAttribute("src", dataUrl);
    restores.push(() => img.setAttribute("src", original));
  }
  const styled = [root, ...root.querySelectorAll<HTMLElement>("*")];
  for (const element of styled) {
    const computed = getComputedStyle(element).backgroundImage;
    const urls = cssUrls(computed).filter((url) => !DATA_URL.test(url));
    if (urls.length === 0) continue;
    const original = element.style.backgroundImage;
    let next = computed;
    for (const url of urls) {
      next = next.split(url).join(await urlToDataUri(url));
    }
    element.style.backgroundImage = next;
    restores.push(() => { element.style.backgroundImage = original; });
  }
  return () => {
    for (const restore of restores.reverse()) restore();
  };
}

export type PlayHud = {
  cx: number;
  cy: number;
  radius: number;
  triangle: [[number, number], [number, number], [number, number]];
};

export function playHud(width: number, height: number): PlayHud {
  const radius = Math.max(28, Math.min(width, height) * 0.14);
  const cx = width / 2;
  const cy = height / 2;
  const reach = radius * 0.46;
  const left = cx - reach * 0.55;
  return {
    cx,
    cy,
    radius,
    triangle: [[left, cy - reach], [cx + reach, cy], [left, cy + reach]]
  };
}

export function firstPresentedTime(duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0.04;
  return Math.min(1 / 30, duration);
}

export function frameIsBlank(pixels: ArrayLike<number>, stride = 4): boolean {
  if (pixels.length < stride) return true;
  const pixelCount = Math.floor(pixels.length / stride);
  const step = Math.max(1, Math.floor(pixelCount / 48));
  let lit = 0;
  let seen = 0;
  for (let pixel = 0; pixel < pixelCount; pixel += step) {
    const index = pixel * stride;
    seen += 1;
    const red = pixels[index] ?? 0;
    const green = pixels[index + 1] ?? 0;
    const blue = pixels[index + 2] ?? 0;
    if (red + green + blue > 30) lit += 1;
  }
  return seen === 0 || lit / seen < 0.04;
}

export function paintPlayHud(context: CanvasRenderingContext2D, width: number, height: number): void {
  const hud = playHud(width, height);
  context.save();
  context.beginPath();
  context.arc(hud.cx, hud.cy, hud.radius, 0, Math.PI * 2);
  context.fillStyle = "rgba(15, 23, 42, 0.62)";
  context.fill();
  context.lineWidth = Math.max(2, hud.radius * 0.07);
  context.strokeStyle = "rgba(255, 255, 255, 0.95)";
  context.stroke();
  context.beginPath();
  const [top, tip, bottom] = hud.triangle;
  context.moveTo(top[0], top[1]);
  context.lineTo(tip[0], tip[1]);
  context.lineTo(bottom[0], bottom[1]);
  context.closePath();
  context.fillStyle = "#ffffff";
  context.fill();
  context.restore();
}

export async function inlineVideos(root: HTMLElement): Promise<() => void> {
  const restores: Array<() => void> = [];
  for (const video of [...root.querySelectorAll("video")]) {
    const still = await videoStillDataUri(video);
    if (!still) continue;
    const image = document.createElement("img");
    image.src = still;
    image.alt = "";
    image.style.position = "absolute";
    image.style.inset = "0";
    image.style.width = "100%";
    image.style.height = "100%";
    image.style.objectFit = "cover";
    image.style.borderRadius = video.style.borderRadius;
    video.replaceWith(image);
    restores.push(() => image.replaceWith(video));
  }
  return () => {
    for (const restore of restores.reverse()) restore();
  };
}

async function videoStillDataUri(video: HTMLVideoElement): Promise<string | undefined> {
  const frame = await drawnVideoFrame(video);
  if (frame) return frame;
  const poster = video.getAttribute("poster") || video.poster;
  if (!poster) return undefined;
  try { return await imageWithPlayHud(DATA_URL.test(poster) ? poster : await urlToDataUri(poster)); } catch { return undefined; }
}

async function drawnVideoFrame(video: HTMLVideoElement): Promise<string | undefined> {
  try {
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    if (video.readyState < 2) {
      if (video.networkState === HTMLMediaElement.NETWORK_EMPTY) video.load();
      await withTimeout(mediaEvent(video, "loadeddata"), 8_000, `Video frame timed out: ${video.currentSrc || video.src}`);
    }
    try { await withTimeout(video.play(), 3_000, "Video play timed out"); } catch { /* A seek can still reveal the first frame. */ }
    const time = firstPresentedTime(video.duration);
    if (Math.abs(video.currentTime - time) < 0.0001) video.currentTime = 0;
    await seekVideo(video, time);
    await waitForPresentedFrame(video);
    return paintPresentedFrame(video);
  } catch {
    return undefined;
  } finally {
    video.pause();
  }
}

async function waitForPresentedFrame(video: HTMLVideoElement): Promise<void> {
  if (typeof video.requestVideoFrameCallback !== "function") return;
  try {
    await withTimeout(new Promise<void>((resolve) => { video.requestVideoFrameCallback(() => resolve()); }), 2_000, "Video frame timed out");
  } catch { /* The seeked frame can still be readable. */ }
}

function seekVideo(video: HTMLVideoElement, time: number): Promise<void> {
  return withTimeout(new Promise((resolve, reject) => {
    const finish = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error(`Video failed to load: ${video.currentSrc || video.src}`)); };
    const cleanup = () => {
      video.removeEventListener("seeked", finish);
      video.removeEventListener("error", fail);
    };
    video.addEventListener("seeked", finish);
    video.addEventListener("error", fail);
    video.currentTime = time;
  }), 4_000, "Video seek timed out");
}

function mediaEvent(video: HTMLVideoElement, type: "loadeddata"): Promise<void> {
  return new Promise((resolve, reject) => {
    video.addEventListener(type, () => resolve(), { once: true });
    video.addEventListener("error", () => reject(new Error(`Video failed to load: ${video.currentSrc || video.src}`)), { once: true });
  });
}

function paintPresentedFrame(video: HTMLVideoElement): string | undefined {
  if (!video.videoWidth || !video.videoHeight) return undefined;
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return undefined;
  context.drawImage(video, 0, 0);
  if (frameIsBlank(context.getImageData(0, 0, canvas.width, canvas.height).data)) return undefined;
  paintPlayHud(context, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.92);
}

async function imageWithPlayHud(src: string): Promise<string | undefined> {
  const image = await loadImage(src);
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  if (!width || !height) return src;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return src;
  context.drawImage(image, 0, 0, width, height);
  paintPlayHud(context, width, height);
  return canvas.toDataURL("image/jpeg", 0.92);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not read the video still"));
    image.src = src;
  });
}

async function waitForImage(img: HTMLImageElement): Promise<void> {
  if (img.complete && img.naturalWidth > 0) {
    try { await img.decode(); } catch { /* SVG/decode failures still allow canvas or fetch. */ }
    return;
  }
  if (img.complete && img.naturalWidth === 0 && img.src && !DATA_URL.test(img.src)) {
    throw new Error(`Image failed to load: ${img.currentSrc || img.src}`);
  }
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      img.addEventListener("load", () => resolve(), { once: true });
      img.addEventListener("error", () => reject(new Error(`Image failed to load: ${img.currentSrc || img.src}`)), { once: true });
    }),
    10_000,
    `Image load timed out: ${img.currentSrc || img.src}`
  );
}

async function imageToDataUri(img: HTMLImageElement): Promise<string> {
  const rasterized = rasterizeElement(img);
  if (rasterized) return rasterized;
  return urlToDataUri(img.currentSrc || img.src);
}

function rasterizeElement(img: HTMLImageElement): string | undefined {
  if (!img.naturalWidth || !img.naturalHeight) return undefined;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    context.drawImage(img, 0, 0);
    return canvas.toDataURL("image/png");
  } catch {
    return undefined;
  }
}

export async function urlToDataUri(url: string): Promise<string> {
  if (DATA_URL.test(url)) return url;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  const blob = await response.blob();
  return await blobToDataUri(blob);
}

export async function captureSlidePng(node: HTMLElement, width: number, height: number): Promise<string> {
  return withTimeout(
    toPng(node, { width, height, skipFonts: true, cacheBust: false, pixelRatio: 1 }),
    CAPTURE_TIMEOUT_MS,
    `Slide rasterization timed out after ${CAPTURE_TIMEOUT_MS}ms`
  );
}

async function blobToDataUri(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return `data:${blob.type || "application/octet-stream"};base64,${btoa(binary)}`;
}
