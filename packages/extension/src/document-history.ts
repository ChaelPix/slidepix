import { mergeDecksLive, parseDeckText, type DeckMergeResolution } from "@slidepix/core";

export const MAX_DOCUMENT_HISTORY = 50;

export type HistoryStep = { before: string; after: string };

export type DocumentHistory = {
  past: HistoryStep[];
  future: HistoryStep[];
};

export type HistoryRestore =
  | { history: DocumentHistory; text: string }
  | { history: DocumentHistory; error: string };

export function emptyDocumentHistory(): DocumentHistory {
  return { past: [], future: [] };
}

export function recordDocumentEdit(history: DocumentHistory, previousText: string, nextText: string): DocumentHistory {
  if (previousText === nextText) return history;
  const past = [...history.past, { before: previousText, after: nextText }];
  if (past.length > MAX_DOCUMENT_HISTORY) past.splice(0, past.length - MAX_DOCUMENT_HISTORY);
  return { past, future: [] };
}

export function undoDocument(history: DocumentHistory, currentText: string): HistoryRestore | undefined {
  const step = history.past.at(-1);
  if (!step) return undefined;
  const reverted = revertText(step.after, currentText, step.before);
  const next = { past: history.past.slice(0, -1), future: [...history.future, step] };
  if (!reverted.ok) return { history, error: reverted.error };
  return { history: next, text: reverted.text };
}

export function redoDocument(history: DocumentHistory, currentText: string): HistoryRestore | undefined {
  const step = history.future.at(-1);
  if (!step) return undefined;
  const restored = revertText(step.before, currentText, step.after);
  const next = { past: [...history.past, step], future: history.future.slice(0, -1) };
  if (!restored.ok) return { history, error: restored.error };
  return { history: next, text: restored.text };
}

export function historyFlags(history: DocumentHistory): { canUndo: boolean; canRedo: boolean } {
  return { canUndo: history.past.length > 0, canRedo: history.future.length > 0 };
}

function revertText(expected: string, current: string, target: string): { ok: true; text: string } | { ok: false; error: string } {
  if (current === expected) return { ok: true, text: target };
  const merged = mergeDocumentTexts(expected, current, target, "theirs");
  return merged.ok ? { ok: true, text: merged.text } : { ok: false, error: merged.error };
}

function mergeDocumentTexts(
  baseText: string,
  oursText: string,
  theirsText: string,
  prefer: Exclude<DeckMergeResolution, "base">
): { ok: true; text: string } | { ok: false; error: string } {
  const base = parseDeckText(baseText);
  const ours = parseDeckText(oursText);
  const theirs = parseDeckText(theirsText);
  if (!base.ok || !ours.ok || !theirs.ok) {
    return { ok: false, error: "SlidePix could not undo because the deck text is not a valid document." };
  }
  const merged = mergeDecksLive(base.deck, ours.deck, theirs.deck, prefer);
  if (!merged.ok || !merged.text) {
    return { ok: false, error: "SlidePix could not undo without overwriting another change." };
  }
  return { ok: true, text: merged.text };
}
