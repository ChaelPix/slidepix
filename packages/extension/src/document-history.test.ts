import { describe, expect, it } from "vitest";
import { createDeck, serializeDeck } from "@slidepix/core";
import {
  emptyDocumentHistory,
  historyFlags,
  MAX_DOCUMENT_HISTORY,
  recordDocumentEdit,
  redoDocument,
  undoDocument
} from "./document-history";

function restored(result: ReturnType<typeof undoDocument>): string {
  if (!result || !("text" in result)) throw new Error(result?.error ?? "history step failed");
  return result.text;
}

describe("document history", () => {
  it("records each distinct edit and undoes one step at a time", () => {
    let history = emptyDocumentHistory();
    history = recordDocumentEdit(history, "A", "B");
    history = recordDocumentEdit(history, "B", "C");
    expect(historyFlags(history)).toEqual({ canUndo: true, canRedo: false });

    const first = undoDocument(history, "C");
    expect(restored(first)).toBe("B");
    const second = undoDocument(first!.history, "B");
    expect(restored(second)).toBe("A");
    expect(undoDocument(second!.history, "A")).toBeUndefined();
  });

  it("redoes the step that was just undone", () => {
    let history = recordDocumentEdit(emptyDocumentHistory(), "A", "B");
    const undone = undoDocument(history, "B");
    const redone = redoDocument(undone!.history, "A");
    expect(restored(redone)).toBe("B");
    expect(historyFlags(redone!.history)).toEqual({ canUndo: true, canRedo: false });
  });

  it("clears redo when a new edit is recorded", () => {
    let history = recordDocumentEdit(emptyDocumentHistory(), "A", "B");
    history = undoDocument(history, "B")!.history;
    history = recordDocumentEdit(history, "A", "C");
    expect(redoDocument(history, "C")).toBeUndefined();
    expect(restored(undoDocument(history, "C"))).toBe("A");
  });

  it("ignores no-op replacements", () => {
    const history = recordDocumentEdit(emptyDocumentHistory(), "A", "A");
    expect(history).toEqual(emptyDocumentHistory());
  });

  it("caps recorded snapshots", () => {
    let history = emptyDocumentHistory();
    for (let index = 0; index < MAX_DOCUMENT_HISTORY + 5; index += 1) {
      history = recordDocumentEdit(history, `v${index}`, `v${index + 1}`);
    }
    expect(history.past).toHaveLength(MAX_DOCUMENT_HISTORY);
    expect(history.past[0]?.before).toBe("v5");
  });

  it("undoes only the local step when a collaborator changed another field", () => {
    const base = createDeck("History");
    const edited = structuredClone(base);
    edited.slides[0]!.title = "Local title";
    const remote = structuredClone(edited);
    remote.slides[0]!.notes = "Remote notes";
    const history = recordDocumentEdit(emptyDocumentHistory(), serializeDeck(base), serializeDeck(edited));
    const undone = undoDocument(history, serializeDeck(remote));
    expect(undone && "text" in undone).toBe(true);
    if (!undone || !("text" in undone)) return;
    expect(undone.text).toContain("Remote notes");
    expect(undone.text).not.toContain("Local title");
  });
});
