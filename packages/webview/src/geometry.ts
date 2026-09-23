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

const MIN_CROP_SPAN = 0.05;

function anchoredScaleLimit(span: number, point: number, anchor: number): number {
  const before = anchor > 0 ? point / (span * anchor) : Number.POSITIVE_INFINITY;
  const after = anchor < 1 ? (1 - point) / (span * (1 - anchor)) : Number.POSITIVE_INFINITY;
  return Math.min(before, after);
}

export function scaleCropAround(crop: ImageCrop, factor: number, anchorX: number, anchorY: number): ImageCrop {
  const safeAnchorX = clamp(anchorX, 0, 1);
  const safeAnchorY = clamp(anchorY, 0, 1);
  const sourceX = crop.x + crop.width * safeAnchorX;
  const sourceY = crop.y + crop.height * safeAnchorY;
  const maxFactor = Math.min(
    anchoredScaleLimit(crop.width, sourceX, safeAnchorX),
    anchoredScaleLimit(crop.height, sourceY, safeAnchorY),
  );
  const applied = clamp(factor, MIN_CROP_SPAN / Math.max(crop.width, crop.height), maxFactor);
  if (Math.abs(applied - 1) < 1e-9) return crop;
  const width = crop.width * applied;
  const height = crop.height * applied;
  return {
    x: sourceX - width * safeAnchorX,
    y: sourceY - height * safeAnchorY,
    width,
    height
  };
}

export function setCropZoom(crop: ImageCrop, percent: number): ImageCrop {
  const targetLargestSide = clamp(100 / percent, 0.05, 1);
  return scaleCrop(crop, targetLargestSide / Math.max(crop.width, crop.height));
}

export function panCrop(crop: ImageCrop, deltaX: number, deltaY: number, frameWidth: number, frameHeight: number): ImageCrop {
  return {
    ...crop,
    x: clamp(crop.x - deltaX * crop.width / Math.max(1, frameWidth), 0, 1 - crop.width),
    y: clamp(crop.y - deltaY * crop.height / Math.max(1, frameHeight), 0, 1 - crop.height),
  };
}

export type CropBox = { x: number; y: number; width: number; height: number; crop: ImageCrop };
export type CropInsets = { left: number; top: number; right: number; bottom: number };

const MIN_CROP_EDGE = 24;

export function cropBoxByEdges(box: CropBox, insets: CropInsets): CropBox {
  const scaleX = box.width / Math.max(box.crop.width, 1e-6);
  const scaleY = box.height / Math.max(box.crop.height, 1e-6);
  const left = clamp(insets.left, -box.crop.x * scaleX, Math.max(0, box.width - MIN_CROP_EDGE));
  const right = clamp(insets.right, -(1 - box.crop.x - box.crop.width) * scaleX, Math.max(0, box.width - MIN_CROP_EDGE - left));
  const top = clamp(insets.top, -box.crop.y * scaleY, Math.max(0, box.height - MIN_CROP_EDGE));
  const bottom = clamp(insets.bottom, -(1 - box.crop.y - box.crop.height) * scaleY, Math.max(0, box.height - MIN_CROP_EDGE - top));
  const width = box.width - left - right;
  const height = box.height - top - bottom;
  const cropWidth = clamp(width / scaleX, 0.02, 1);
  const cropHeight = clamp(height / scaleY, 0.02, 1);
  return {
    x: box.x + left,
    y: box.y + top,
    width,
    height,
    crop: {
      x: clamp(box.crop.x + left / scaleX, 0, 1 - cropWidth),
      y: clamp(box.crop.y + top / scaleY, 0, 1 - cropHeight),
      width: cropWidth,
      height: cropHeight
    }
  };
}

export function cropBoxToSquare(box: CropBox): CropBox {
  const side = Math.min(box.width, box.height);
  const insetX = (box.width - side) / 2;
  const insetY = (box.height - side) / 2;
  return cropBoxByEdges(box, { left: insetX, top: insetY, right: insetX, bottom: insetY });
}
