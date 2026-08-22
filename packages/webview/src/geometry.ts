import type { ImageElement } from "@slidepix/core";

export type ImageCrop = ImageElement["crop"];

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function localPointerDelta(deltaX: number, deltaY: number, rotation: number, zoom: number): { x: number; y: number } {
  const radians = rotation * Math.PI / 180;
  const x = deltaX / zoom;
  const y = deltaY / zoom;
  return { x: x * Math.cos(radians) + y * Math.sin(radians), y: -x * Math.sin(radians) + y * Math.cos(radians) };
}

export function cropZoomPercent(crop: ImageCrop): number {
  return Math.round(100 / Math.max(crop.width, crop.height));
}

export function scaleCrop(crop: ImageCrop, factor: number): ImageCrop {
  return scaleCropAround(crop, factor, 0.5, 0.5);
}

export function scaleCropAround(crop: ImageCrop, factor: number, anchorX: number, anchorY: number): ImageCrop {
  const safeAnchorX = clamp(anchorX, 0, 1);
  const safeAnchorY = clamp(anchorY, 0, 1);
  const sourceX = crop.x + crop.width * safeAnchorX;
  const sourceY = crop.y + crop.height * safeAnchorY;
  const width = clamp(crop.width * factor, 0.05, 1);
  const height = clamp(crop.height * factor, 0.05, 1);
  return { x: clamp(sourceX - width * safeAnchorX, 0, 1 - width), y: clamp(sourceY - height * safeAnchorY, 0, 1 - height), width, height };
}

export function setCropZoom(crop: ImageCrop, percent: number): ImageCrop {
  const targetLargestSide = clamp(100 / percent, 0.05, 1);
  return scaleCrop(crop, targetLargestSide / Math.max(crop.width, crop.height));
}
