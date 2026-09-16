import { create } from "zustand";
import {
  mergeDecks,
  serializeDeck,
  type Deck,
  type DeckMergeConflict,
  type DeckMergeResolution,
  type HostToWebviewMessage,
  type WebviewToHostMessage
} from "@slidepix/core";
import { postMessage } from "./vscode";

type PendingEdit = {
  requestId: string;
  baseDeck: Deck;
  text: string;
};

type MergeState = {
  base: Deck;
  ours: Deck;
  theirs: Deck;
  theirsRevision: string;
  resolutions: Record<string, DeckMergeResolution>;
  conflicts: DeckMergeConflict[];
};

type DeferredCommand = Extract<WebviewToHostMessage, { type: "command" }>;

export type DeckStore = {
  deck?: Deck;
  confirmedDeck?: Deck;
  revision?: string;
  sourceUri?: string;
  linkedSourceUri?: string;
  error?: string;
  gitConflict: boolean;
  selectedSlideId?: string;
  selectedElementId?: string;
  zoom: number;
  dirty: boolean;
  pending?: PendingEdit;
  mergeState?: MergeState;
  setFromHost(deck: Deck, revision: string, sourceUri: string, linkedSourceUri: string): void;
  setInvalid(message: string, gitConflict: boolean, sourceUri: string, linkedSourceUri: string): void;
  handleEditResult(message: Extract<HostToWebviewMessage, { type: "documentEditResult" }>): void;
  selectSlide(id: string): void;
  selectElement(id?: string): void;
  setZoom(zoom: number): void;
  preview(mutator: (draft: Deck) => void): void;
  scheduleCommit(): void;
  commit(): void;
  mutate(mutator: (draft: Deck) => void): void;
  runCommand(command: DeferredCommand["command"], slideIds?: string[]): void;
  resolveMergeConflict(id: string, resolution: DeckMergeResolution): void;
  useLatestDeck(): void;
};

let commitTimer: ReturnType<typeof setTimeout> | undefined;
const deferredCommands: DeferredCommand[] = [];

export const useDeckStore = create<DeckStore>((set, get) => {
  const drainCommands = (state: DeckStore) => {
    if (state.pending || state.dirty || state.mergeState || state.error) return;
    while (deferredCommands.length) postMessage(deferredCommands.shift()!);
  };

  const flush = () => {
    const state = get();
    if (state.pending || state.mergeState || state.error || !state.dirty || !state.deck || !state.confirmedDeck || !state.revision) {
      drainCommands(state);
      return;
    }
    const text = serializeDeck(state.deck);
    if (text === serializeDeck(state.confirmedDeck)) {
      set({ dirty: false });
      drainCommands(get());
      return;
    }
    const requestId = crypto.randomUUID();
    set({
      pending: {
        requestId,
        baseDeck: structuredClone(state.confirmedDeck),
        text
      },
      dirty: false
    });
    postMessage({ type: "replaceDocument", requestId, baseRevision: state.revision, text });
  };

  const acceptHostDeck = (deck: Deck, revision: string) => {
    const state = get();
    if (state.pending?.text === serializeDeck(deck)) {
      set({
        confirmedDeck: structuredClone(deck),
        revision,
        pending: undefined,
        deck: state.dirty ? state.deck : deck,
        error: undefined,
        gitConflict: false
      });
      flush();
      return;
    }

    if ((state.pending || state.dirty) && state.deck && state.confirmedDeck) {
      const base = state.pending?.baseDeck ?? state.confirmedDeck;
      const result = mergeDecks(base, state.deck, deck);
      if (result.ok) {
        set({ deck: result.deck, confirmedDeck: structuredClone(deck), revision, pending: undefined, dirty: true, error: undefined, gitConflict: false });
        flush();
      } else {
        set({
          confirmedDeck: structuredClone(deck),
          revision,
          pending: undefined,
          mergeState: { base, ours: state.deck, theirs: deck, theirsRevision: revision, resolutions: {}, conflicts: result.conflicts }
        });
      }
      return;
    }

    set((current) => selectionState(current, deck, {
      deck,
      confirmedDeck: structuredClone(deck),
      revision,
      dirty: false,
      pending: undefined,
      mergeState: undefined,
      error: undefined,
      gitConflict: false
    }));
    drainCommands(get());
  };

  return {
    zoom: 0.5,
    dirty: false,
    gitConflict: false,
    setFromHost: (deck, revision, sourceUri, linkedSourceUri) => {
      set({ sourceUri, linkedSourceUri });
      acceptHostDeck(deck, revision);
    },
    setInvalid: (message, gitConflict, sourceUri, linkedSourceUri) => set({ error: message, gitConflict, sourceUri, linkedSourceUri, pending: undefined }),
    handleEditResult: (message) => {
      const state = get();
      if (state.pending && state.pending.requestId !== message.requestId) return;
      if ((message.accepted || message.reason === "stale") && message.deck) {
        acceptHostDeck(message.deck, message.revision);
        return;
      }
      set({ pending: undefined, error: message.message ?? "SlidePix could not apply the document edit." });
    },
    selectSlide: (id) => set({ selectedSlideId: id, selectedElementId: undefined }),
    selectElement: (id) => set({ selectedElementId: id }),
    setZoom: (zoom) => set({ zoom: Math.min(1.5, Math.max(0.1, zoom)) }),
    preview: (mutator) => {
      const deck = get().deck;
      if (!deck || get().mergeState) return;
      const next = structuredClone(deck);
      mutator(next);
      set({ deck: next, dirty: true });
    },
    scheduleCommit: () => {
      if (commitTimer) clearTimeout(commitTimer);
      commitTimer = setTimeout(flush, 250);
    },
    commit: () => {
      if (commitTimer) clearTimeout(commitTimer);
      commitTimer = undefined;
      flush();
    },
    mutate: (mutator) => {
      const deck = get().deck;
      if (!deck || get().mergeState) return;
      const next = structuredClone(deck);
      mutator(next);
      set({ deck: next, dirty: true });
      flush();
    },
    runCommand: (command, slideIds) => {
      deferredCommands.push({ version: 2, type: "command", command, slideIds });
      if (get().dirty) flush();
      else drainCommands(get());
    },
    resolveMergeConflict: (id, resolution) => {
      const mergeState = get().mergeState;
      if (!mergeState) return;
      const resolutions = { ...mergeState.resolutions, [id]: resolution };
      const result = mergeDecks(mergeState.base, mergeState.ours, mergeState.theirs, resolutions);
      if (result.ok) {
        set({ deck: result.deck, confirmedDeck: structuredClone(mergeState.theirs), revision: mergeState.theirsRevision, mergeState: undefined, dirty: true });
        flush();
      } else {
        set({ mergeState: { ...mergeState, resolutions, conflicts: result.conflicts } });
      }
    },
    useLatestDeck: () => {
      const mergeState = get().mergeState;
      if (!mergeState) return;
      set((state) => selectionState(state, mergeState.theirs, {
        deck: mergeState.theirs,
        confirmedDeck: structuredClone(mergeState.theirs),
        revision: mergeState.theirsRevision,
        mergeState: undefined,
        pending: undefined,
        dirty: false
      }));
      drainCommands(get());
    }
  };
});

function selectionState(state: DeckStore, deck: Deck, patch: Partial<DeckStore>): Partial<DeckStore> {
  const selectedSlideId = deck.slides.some((slide) => slide.id === state.selectedSlideId) ? state.selectedSlideId : deck.slides[0]?.id;
  const selectedElementId = deck.slides.find((slide) => slide.id === selectedSlideId)?.elements.some((element) => element.id === state.selectedElementId)
    ? state.selectedElementId
    : undefined;
  return { ...patch, selectedSlideId, selectedElementId };
}
