import { create } from "zustand";
import { serializeDeck, type Deck } from "@slidepix/core";
import { postMessage } from "./vscode";

type DeckStore = {
  deck?: Deck;
  sourceUri?: string;
  linkedSourceUri?: string;
  error?: string;
  selectedSlideId?: string;
  selectedElementId?: string;
  zoom: number;
  setFromHost(deck: Deck, sourceUri: string, linkedSourceUri: string): void;
  setInvalid(message: string, sourceUri: string, linkedSourceUri: string): void;
  selectSlide(id: string): void;
  selectElement(id?: string): void;
  setZoom(zoom: number): void;
  preview(mutator: (draft: Deck) => void): void;
  commit(): void;
  mutate(mutator: (draft: Deck) => void): void;
};

export const useDeckStore = create<DeckStore>((set, get) => ({
  zoom: 0.5,
  setFromHost: (deck, sourceUri, linkedSourceUri) => set((state) => {
    const selectedSlideId = deck.slides.some((slide) => slide.id === state.selectedSlideId)
      ? state.selectedSlideId
      : deck.slides[0]?.id;
    const selectedElementId = deck.slides.find((slide) => slide.id === selectedSlideId)?.elements.some((element) => element.id === state.selectedElementId)
      ? state.selectedElementId
      : undefined;
    return { deck, sourceUri, linkedSourceUri, error: undefined, selectedSlideId, selectedElementId };
  }),
  setInvalid: (message, sourceUri, linkedSourceUri) => set({ error: message, sourceUri, linkedSourceUri }),
  selectSlide: (id) => set({ selectedSlideId: id, selectedElementId: undefined }),
  selectElement: (id) => set({ selectedElementId: id }),
  setZoom: (zoom) => set({ zoom: Math.min(1.5, Math.max(0.1, zoom)) }),
  preview: (mutator) => {
    const deck = get().deck;
    if (!deck) return;
    const next = structuredClone(deck);
    mutator(next);
    set({ deck: next });
  },
  commit: () => {
    const deck = get().deck;
    if (deck) postMessage({ type: "replaceDocument", text: serializeDeck(deck) });
  },
  mutate: (mutator) => {
    const deck = get().deck;
    if (!deck) return;
    const next = structuredClone(deck);
    mutator(next);
    set({ deck: next });
    postMessage({ type: "replaceDocument", text: serializeDeck(next) });
  }
}));
