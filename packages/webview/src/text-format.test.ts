import { describe, expect, it } from "vitest";
import { toggleInlineMarkdown, toggleMarkdownList } from "./text-format";

describe("Markdown selection formatting", () => {
  it("wraps and unwraps a selected range", () => {
    const wrapped = toggleInlineMarkdown("hello world", { start: 6, end: 11 }, "**");
    expect(wrapped).toEqual({ text: "hello **world**", selection: { start: 8, end: 13 } });
    expect(toggleInlineMarkdown(wrapped.text, wrapped.selection, "**")).toEqual({ text: "hello world", selection: { start: 6, end: 11 } });
  });

  it("inserts paired emphasis markers at an empty selection", () => {
    expect(toggleInlineMarkdown("hello", { start: 5, end: 5 }, "_")).toEqual({ text: "hello__", selection: { start: 6, end: 6 } });
  });

  it("toggles multiline unordered lists", () => {
    const listed = toggleMarkdownList("one\ntwo", { start: 0, end: 7 }, false);
    expect(listed.text).toBe("- one\n- two");
    expect(toggleMarkdownList(listed.text, listed.selection, false).text).toBe("one\ntwo");
  });

  it("numbers selected lines and replaces another list style", () => {
    expect(toggleMarkdownList("- one\n- two", { start: 0, end: 11 }, true).text).toBe("1. one\n2. two");
  });

  it("does not format the next line when a selection ends at its start", () => {
    expect(toggleMarkdownList("one\ntwo", { start: 0, end: 4 }, false).text).toBe("- one\ntwo");
  });
});
