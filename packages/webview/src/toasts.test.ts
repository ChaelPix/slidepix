import { describe, expect, it } from "vitest";
import { updateToasts, type ToastMessage } from "./toasts";

describe("toast updates", () => {
  it("replaces progress with completion while preserving unrelated notices", () => {
    const current: ToastMessage[] = [
      { id: "export", kind: "progress", message: "Exporting…" },
      { id: "other", kind: "error", message: "Keep me" }
    ];
    expect(updateToasts(current, { id: "export", kind: "success", message: "Exported" })).toEqual([
      { id: "other", kind: "error", message: "Keep me" },
      { id: "export", kind: "success", message: "Exported" }
    ]);
  });

  it("dismisses only the requested notice", () => {
    const current: ToastMessage[] = [
      { id: "one", kind: "error", message: "One" },
      { id: "two", kind: "error", message: "Two" }
    ];
    expect(updateToasts(current, { id: "one", kind: "dismiss" })).toEqual([{ id: "two", kind: "error", message: "Two" }]);
  });

  it("replaces a progress toast with the latest percent", () => {
    const current: ToastMessage[] = [{ id: "render", kind: "progress", message: "Rendering", progress: 10 }];
    expect(updateToasts(current, { id: "render", kind: "progress", message: "Rendering", progress: 40 })).toEqual([
      { id: "render", kind: "progress", message: "Rendering", progress: 40 }
    ]);
  });
});
