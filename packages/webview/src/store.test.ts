import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeck, duplicateSlide, parseDeckText, serializeDeck, type Deck, type HostToWebviewMessage } from "@slidepix/core";

vi.mock("./vscode", () => ({ postMessage: vi.fn() }));

import { postMessage } from "./vscode";
import { useDeckStore } from "./store";

function fixture(): Deck {
  const deck = createDeck("Queue");
  deck.slides[0]!.id = "slide-a";
  deck.slides[0]!.elements[0]!.id = "element-a";
  const second = duplicateSlide(deck.slides[0]!);
  second.id = "slide-b";
  second.elements[0]!.id = "element-b";
  deck.slides.push(second);
  return deck;
}

beforeEach(() => {
  vi.mocked(postMessage).mockClear();
  useDeckStore.setState({
    deck: undefined,
    confirmedDeck: undefined,
    revision: undefined,
    sourceUri: undefined,
    linkedSourceUri: undefined,
    error: undefined,
    gitConflict: false,
    selectedSlideId: undefined,
    selectedElementId: undefined,
    zoom: 0.5,
    dirty: false,
    pending: undefined,
    mergeState: undefined,
    historyPending: undefined,
    historyQueue: [],
    deferredCommands: [],
    historyError: undefined
  });
});

describe("revision-safe persistence queue", () => {
  it("debounces preview commits", () => {
    vi.useFakeTimers();
    const base = fixture();
    useDeckStore.getState().setFromHost(base, "revision-0", "asset", "linked");
    useDeckStore.getState().preview((deck) => { deck.slides[0]!.notes = "typed"; });
    useDeckStore.getState().scheduleCommit();
    expect(postMessage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(599);
    expect(postMessage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(postMessage).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("allows one in-flight write and coalesces later changes", () => {
    const base = fixture();
    useDeckStore.getState().setFromHost(base, "revision-0", "asset", "linked");
    useDeckStore.getState().mutate((deck) => { deck.slides[0]!.notes = "first"; });
    useDeckStore.getState().mutate((deck) => { deck.slides[0]!.title = "second"; });
    expect(postMessage).toHaveBeenCalledTimes(1);

    const first = firstEdit();
    const submitted = parseDeckText(first.text);
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    useDeckStore.getState().handleEditResult(accepted(first.requestId, submitted.deck, "revision-1"));

    expect(postMessage).toHaveBeenCalledTimes(2);
    const second = vi.mocked(postMessage).mock.calls[1]![0];
    expect(second.type).toBe("replaceDocument");
    if (second.type === "replaceDocument") {
      const parsed = parseDeckText(second.text);
      expect(parsed.ok && parsed.deck.slides[0]!.notes).toBe("first");
      expect(parsed.ok && parsed.deck.slides[0]!.title).toBe("second");
      expect(second.baseRevision).toBe("revision-1");
    }
  });

  it("rebases a pending edit over an independent external change", () => {
    const base = fixture();
    useDeckStore.getState().setFromHost(base, "revision-0", "asset", "linked");
    useDeckStore.getState().mutate((deck) => { deck.slides[0]!.notes = "mine"; });
    const external = structuredClone(base);
    external.slides[1]!.notes = "external";
    useDeckStore.getState().setFromHost(external, "revision-external", "asset", "linked");

    expect(useDeckStore.getState().mergeState).toBeUndefined();
    expect(postMessage).toHaveBeenCalledTimes(2);
    const retry = vi.mocked(postMessage).mock.calls[1]![0];
    if (retry.type !== "replaceDocument") return;
    const parsed = parseDeckText(retry.text);
    expect(parsed.ok && parsed.deck.slides.map((slide) => slide.notes)).toEqual(["mine", "external"]);
  });

  it("pauses on a true concurrent conflict", () => {
    const base = fixture();
    useDeckStore.getState().setFromHost(base, "revision-0", "asset", "linked");
    useDeckStore.getState().mutate((deck) => { deck.slides[0]!.title = "Mine"; });
    const external = structuredClone(base);
    external.slides[0]!.title = "External";
    useDeckStore.getState().setFromHost(external, "revision-external", "asset", "linked");

    expect(useDeckStore.getState().mergeState?.conflicts[0]).toMatchObject({ kind: "value", slideId: "slide-a" });
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it("reports a rejected WorkspaceEdit", () => {
    const base = fixture();
    useDeckStore.getState().setFromHost(base, "revision-0", "asset", "linked");
    useDeckStore.getState().mutate((deck) => { deck.slides[0]!.notes = "mine"; });
    const request = firstEdit();
    useDeckStore.getState().handleEditResult({ version: 2, type: "documentEditResult", requestId: request.requestId, accepted: false, revision: "revision-0", text: serializeDeck(base), reason: "applyFailed", message: "Rejected" });
    expect(useDeckStore.getState().error).toBe("Rejected");
  });

  it("defers save until the pending write is acknowledged", () => {
    const base = fixture();
    useDeckStore.getState().setFromHost(base, "revision-0", "asset", "linked");
    useDeckStore.getState().mutate((deck) => { deck.slides[0]!.notes = "mine"; });
    useDeckStore.getState().runCommand("save");
    expect(postMessage).toHaveBeenCalledTimes(1);

    const request = firstEdit();
    const submitted = parseDeckText(request.text);
    if (!submitted.ok) return;
    useDeckStore.getState().handleEditResult(accepted(request.requestId, submitted.deck, "revision-1"));
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(postMessage).mock.calls[1]![0]).toMatchObject({ type: "command", command: "save" });
  });

  it("flushes edits before sending an acknowledged history request", () => {
    const base = fixture();
    useDeckStore.getState().setFromHost(base, "revision-0", "asset", "linked");
    useDeckStore.getState().preview((deck) => { deck.slides[0]!.notes = "mine"; });
    useDeckStore.getState().runCommand("undo");
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(postMessage).mock.calls[0]![0].type).toBe("replaceDocument");

    const request = firstEdit();
    const submitted = parseDeckText(request.text);
    if (!submitted.ok) return;
    useDeckStore.getState().handleEditResult(accepted(request.requestId, submitted.deck, "revision-1"));
    expect(vi.mocked(postMessage).mock.calls[1]![0]).toMatchObject({ type: "history", command: "undo" });
  });

  it("serializes rapid undo and redo requests", () => {
    const base = fixture();
    useDeckStore.getState().setFromHost(base, "revision-0", "asset", "linked");
    useDeckStore.getState().runCommand("undo");
    useDeckStore.getState().runCommand("redo");
    expect(postMessage).toHaveBeenCalledTimes(1);
    const undo = vi.mocked(postMessage).mock.calls[0]![0];
    if (undo.type !== "history") return;
    useDeckStore.getState().handleHistoryResult({ version: 2, type: "historyResult", requestId: undo.requestId, command: "undo", ok: true, revision: "revision-undo", text: serializeDeck(base), deck: base });
    expect(vi.mocked(postMessage).mock.calls[1]![0]).toMatchObject({ type: "history", command: "redo" });
  });

  it("acknowledges a no-op history command", () => {
    const base = fixture();
    useDeckStore.getState().setFromHost(base, "revision-0", "asset", "linked");
    useDeckStore.getState().runCommand("undo");
    const request = vi.mocked(postMessage).mock.calls[0]![0];
    if (request.type !== "history") return;
    useDeckStore.getState().handleHistoryResult({ version: 2, type: "historyResult", requestId: request.requestId, command: "undo", ok: true, revision: "revision-0", text: serializeDeck(base), deck: base });
    expect(useDeckStore.getState().historyPending).toBeUndefined();
    expect(useDeckStore.getState().deck).toEqual(base);
  });

  it("reports a failed history request without invalidating the deck", () => {
    const base = fixture();
    useDeckStore.getState().setFromHost(base, "revision-0", "asset", "linked");
    useDeckStore.getState().runCommand("undo");
    const request = vi.mocked(postMessage).mock.calls[0]![0];
    if (request.type !== "history") return;
    useDeckStore.getState().handleHistoryResult({ version: 2, type: "historyResult", requestId: request.requestId, command: "undo", ok: false, revision: "revision-0", text: serializeDeck(base), deck: base, error: "History failed" });
    expect(useDeckStore.getState().deck).toEqual(base);
    expect(useDeckStore.getState().error).toBeUndefined();
    expect(useDeckStore.getState().historyError).toBe("History failed");
  });
});

function firstEdit(): Extract<Parameters<typeof postMessage>[0], { type: "replaceDocument" }> {
  const message = vi.mocked(postMessage).mock.calls[0]![0];
  if (message.type !== "replaceDocument") throw new Error("Expected a document edit");
  return message;
}

function accepted(requestId: string, deck: Deck, revision: string): Extract<HostToWebviewMessage, { type: "documentEditResult" }> {
  return { version: 2, type: "documentEditResult", requestId, accepted: true, revision, text: serializeDeck(deck), deck };
}
