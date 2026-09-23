import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorResolveRecovery, type EditorRecoveryHost } from "./editor-recovery";

const KEY = "file:///deck.slidepix.json";

function host(overrides: Partial<EditorRecoveryHost<string>> = {}) {
  return {
    isResolved: vi.fn(() => false),
    hasDocument: vi.fn(() => false),
    reopen: vi.fn(async () => undefined),
    report: vi.fn(),
    ...overrides
  };
}

describe("EditorResolveRecovery", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("reopens an active tab whose document never reached the extension host", () => {
    const fake = host();
    new EditorResolveRecovery(fake, 100).watch(KEY, "tab");
    vi.advanceTimersByTime(100);
    expect(fake.reopen).toHaveBeenCalledWith("tab");
  });

  it("does nothing once the editor resolves", () => {
    const fake = host();
    const recovery = new EditorResolveRecovery(fake, 100);
    recovery.watch(KEY, "tab");
    recovery.resolved(KEY);
    vi.advanceTimersByTime(100);
    expect(fake.reopen).not.toHaveBeenCalled();
  });

  it("leaves a synchronized document alone while its resolve is still running", () => {
    const fake = host({ hasDocument: vi.fn(() => true) });
    new EditorResolveRecovery(fake, 100).watch(KEY, "tab");
    vi.advanceTimersByTime(100);
    expect(fake.reopen).not.toHaveBeenCalled();
  });

  it("retries at most once per cooldown so a persistent failure cannot loop", () => {
    const fake = host();
    let now = 0;
    const recovery = new EditorResolveRecovery(fake, 100, () => now);
    recovery.watch(KEY, "tab");
    vi.advanceTimersByTime(100);
    recovery.watch(KEY, "tab");
    vi.advanceTimersByTime(100);
    expect(fake.reopen).toHaveBeenCalledTimes(1);
    now = 20_000;
    recovery.watch(KEY, "tab");
    vi.advanceTimersByTime(100);
    expect(fake.reopen).toHaveBeenCalledTimes(2);
  });

  it("reports a failed reopen instead of swallowing it", async () => {
    const error = new Error("closed");
    const fake = host({ reopen: vi.fn(async () => { throw error; }) });
    new EditorResolveRecovery(fake, 100).watch(KEY, "tab");
    await vi.advanceTimersByTimeAsync(100);
    expect(fake.report).toHaveBeenCalledWith(error);
  });
});
