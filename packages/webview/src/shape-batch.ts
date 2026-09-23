import type { Deck, SlideElement } from "@slidepix/core";

export function syncNamedShapes(deck: Deck, slideId: string, elementId: string): void {
  const source = deck.slides.find((slide) => slide.id === slideId)?.elements.find((element) => element.id === elementId);
  if (source?.type !== "shape") return;
  const name = source.name?.trim();
  if (!name) return;
  for (const slide of deck.slides) {
    if (slide.id === slideId) continue;
    for (const element of slide.elements) {
      if (element.type !== "shape" || element.name?.trim() !== name) continue;
      copyShapeAppearance(source, element);
    }
  }
}

function copyShapeAppearance(source: Extract<SlideElement, { type: "shape" }>, target: Extract<SlideElement, { type: "shape" }>): void {
  target.x = source.x;
  target.y = source.y;
  target.width = source.width;
  target.height = source.height;
  target.rotation = source.rotation;
  target.opacity = source.opacity;
  target.fill = source.fill;
  target.stroke = source.stroke;
  target.strokeWidth = source.strokeWidth;
  target.borderRadius = source.borderRadius;
  target.shadow = { ...source.shadow };
}
