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
type HistoryCommand = "undo" | "redo";

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
  selectedElementIds: string[];
  zoom: number;
  dirty: boolean;
  pending?: PendingEdit;
  mergeState?: MergeState;
  historyPending?: { requestId: string; command: HistoryCommand };
  historyQueue: HistoryCommand[];
  deferredCommands: DeferredCommand[];
  historyError?: string;
  canUndo: boolean;
  canRedo: boolean;
  setFromHost(deck: Deck, revision: string, sourceUri: string, linkedSourceUri: string, history?: { canUndo?: boolean; canRedo?: boolean }): void;
  setInvalid(message: string, gitConflict: boolean, sourceUri: string, linkedSourceUri: string): void;
  handleEditResult(message: Extract<HostToWebviewMessage, { type: "documentEditResult" }>): void;
  handleHistoryResult(message: Extract<HostToWebviewMessage, { type: "historyResult" }>): void;
  clearHistoryError(): void;
  selectSlide(id: string): void;
  selectElement(id?: string, additive?: boolean): void;
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

export const useDeckStore = create<DeckStore>((set, get) => {
  const drainCommands = (state: DeckStore) => {
    if (state.pending || state.dirty || state.mergeState || state.error || state.historyPending) return;
    const history = state.historyQueue[0];
    if (history) {
      const requestId = crypto.randomUUID();
      set({ historyPending: { requestId, command: history }, historyQueue: state.historyQueue.slice(1) });
      postMessage({ type: "history", requestId, command: history });
      return;
    }
    if (state.deferredCommands.length) {
      const [command, ...remaining] = state.deferredCommands;
      set({ deferredCommands: remaining });
      if (command) postMessage(command);
      drainCommands(get());
    }
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
    selectedElementIds: [],
    historyQueue: [],
    deferredCommands: [],
    canUndo: false,
    canRedo: false,
    setFromHost: (deck, revision, sourceUri, linkedSourceUri, history) => {
      set({
        sourceUri,
        linkedSourceUri,
        canUndo: history?.canUndo ?? get().canUndo,
        canRedo: history?.canRedo ?? get().canRedo
      });
      acceptHostDeck(deck, revision);
    },
    setInvalid: (message, gitConflict, sourceUri, linkedSourceUri) => set({ error: message, gitConflict, sourceUri, linkedSourceUri, pending: undefined }),
    handleEditResult: (message) => {
      const state = get();
      if (state.pending && state.pending.requestId !== message.requestId) return;
      if (message.canUndo !== undefined || message.canRedo !== undefined) {
        set({ canUndo: message.canUndo ?? false, canRedo: message.canRedo ?? false });
      }
      if ((message.accepted || message.reason === "stale") && message.deck) {
        acceptHostDeck(message.deck, message.revision);
        return;
      }
      set({ pending: undefined, error: message.message ?? "SlidePix could not apply the document edit." });
    },
    handleHistoryResult: (message) => {
      const state = get();
      if (state.historyPending?.requestId !== message.requestId) return;
      set({
        historyPending: undefined,
        canUndo: message.canUndo ?? state.canUndo,
        canRedo: message.canRedo ?? state.canRedo
      });
      if (!message.ok || !message.deck) {
        set({ historyError: message.error ?? `SlidePix could not ${message.command}.` });
        drainCommands(get());
        return;
      }
      acceptHostDeck(message.deck, message.revision);
    },
    clearHistoryError: () => set({ historyError: undefined }),
    selectSlide: (id) => set({ selectedSlideId: id, selectedElementId: undefined, selectedElementIds: [] }),
    selectElement: (id, additive = false) => set((state) => {
      if (!id) return { selectedElementId: undefined, selectedElementIds: [] };
      if (!additive) return { selectedElementId: id, selectedElementIds: [id] };
      const selected = state.selectedElementIds.includes(id)
        ? state.selectedElementIds.filter((item) => item !== id)
        : [...state.selectedElementIds, id];
      return { selectedElementId: selected.at(-1), selectedElementIds: selected };
    }),
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
      commitTimer = setTimeout(flush, 600);
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
      if (command === "undo" || command === "redo") set((state) => ({ historyQueue: [...state.historyQueue, command] }));
      else set((state) => ({ deferredCommands: [...state.deferredCommands, { version: 2, type: "command", command, slideIds }] }));
      if (commitTimer) clearTimeout(commitTimer);
      commitTimer = undefined;
      if (get().dirty) flush(); else drainCommands(get());
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
  const slide = deck.slides.find((item) => item.id === selectedSlideId);
  const selectedElementIds = (state.selectedElementIds ?? []).filter((id) => slide?.elements.some((element) => element.id === id));
  const selectedElementId = selectedElementIds.includes(state.selectedElementId ?? "") ? state.selectedElementId : selectedElementIds.at(-1);
  return { ...patch, selectedSlideId, selectedElementId, selectedElementIds };
}
