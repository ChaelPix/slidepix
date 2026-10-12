import { readFile } from "node:fs/promises";
import { parseDeckText, type Deck, type Slide } from "@slidepix/core";

export async function loadDeck(deckPath: string): Promise<Deck> {
  const parsed = parseDeckText(await readFile(deckPath, "utf8"));
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.deck;
}

export function selectSlides(deck: Deck, slideIds?: string[], indices?: number[]): Slide[] {
  if (slideIds?.length) {
    const wanted = new Set(slideIds);
    const slides = deck.slides.filter((slide) => wanted.has(slide.id));
    const missing = slideIds.filter((id) => !slides.some((slide) => slide.id === id));
    if (missing.length) throw new Error(`Unknown slide IDs: ${missing.join(", ")}`);
    return slides;
  }
  if (indices?.length) {
    return indices.map((index) => {
      const slide = deck.slides[index - 1];
      if (!slide) throw new Error(`Slide index ${index} is out of range (indices are 1-based).`);
      return slide;
    });
  }
  return deck.slides.filter((slide) => !slide.hidden);
}


