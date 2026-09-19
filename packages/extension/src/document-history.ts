export const MAX_DOCUMENT_HISTORY = 50;

export type DocumentHistory = {
  past: string[];
  future: string[];
};

export function emptyDocumentHistory(): DocumentHistory {
  return { past: [], future: [] };
}

export function recordDocumentEdit(history: DocumentHistory, previousText: string, nextText: string): DocumentHistory {
  if (previousText === nextText) return history;
  const past = [...history.past, previousText];
  if (past.length > MAX_DOCUMENT_HISTORY) past.splice(0, past.length - MAX_DOCUMENT_HISTORY);
  return { past, future: [] };
}

export function undoDocument(history: DocumentHistory, currentText: string): { history: DocumentHistory; text: string } | undefined {
  const text = history.past.at(-1);
  if (text === undefined) return undefined;
  return {
    text,
    history: { past: history.past.slice(0, -1), future: [...history.future, currentText] }
  };
}

export function redoDocument(history: DocumentHistory, currentText: string): { history: DocumentHistory; text: string } | undefined {
  const text = history.future.at(-1);
  if (text === undefined) return undefined;
  return {
    text,
    history: { past: [...history.past, currentText], future: history.future.slice(0, -1) }
  };
}

export function historyFlags(history: DocumentHistory): { canUndo: boolean; canRedo: boolean } {
  return { canUndo: history.past.length > 0, canRedo: history.future.length > 0 };
}
