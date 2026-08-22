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
  const centerX = crop.x + crop.width / 2;
  const centerY = crop.y + crop.height / 2;
  const width = clamp(crop.width * factor, 0.05, 1);
  const height = clamp(crop.height * factor, 0.05, 1);
  return { x: clamp(centerX - width / 2, 0, 1 - width), y: clamp(centerY - height / 2, 0, 1 - height), width, height };
}

export function setCropZoom(crop: ImageCrop, percent: number): ImageCrop {
  const targetLargestSide = clamp(100 / percent, 0.05, 1);
  return scaleCrop(crop, targetLargestSide / Math.max(crop.width, crop.height));
}
