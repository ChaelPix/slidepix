import { describe, expect, it } from "vitest";
import {
  emptyDocumentHistory,
  historyFlags,
  MAX_DOCUMENT_HISTORY,
  recordDocumentEdit,
  redoDocument,
  undoDocument
} from "./document-history";

describe("document history", () => {
  it("records each distinct edit and undoes one step at a time", () => {
    let history = emptyDocumentHistory();
    history = recordDocumentEdit(history, "A", "B");
    history = recordDocumentEdit(history, "B", "C");
    expect(historyFlags(history)).toEqual({ canUndo: true, canRedo: false });

    const first = undoDocument(history, "C");
    expect(first?.text).toBe("B");
    const second = undoDocument(first!.history, "B");
    expect(second?.text).toBe("A");
    expect(undoDocument(second!.history, "A")).toBeUndefined();
  });

  it("redoes the step that was just undone", () => {
    let history = recordDocumentEdit(emptyDocumentHistory(), "A", "B");
    const undone = undoDocument(history, "B");
    const redone = redoDocument(undone!.history, "A");
    expect(redone?.text).toBe("B");
    expect(historyFlags(redone!.history)).toEqual({ canUndo: true, canRedo: false });
  });

  it("clears redo when a new edit is recorded", () => {
    let history = recordDocumentEdit(emptyDocumentHistory(), "A", "B");
    history = undoDocument(history, "B")!.history;
    history = recordDocumentEdit(history, "A", "C");
    expect(redoDocument(history, "C")).toBeUndefined();
    expect(undoDocument(history, "C")?.text).toBe("A");
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
    expect(history.past[0]).toBe("v5");
  });
});
