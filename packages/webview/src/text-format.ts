export type TextSelection = { start: number; end: number };
export type TextEdit = { text: string; selection: TextSelection };

export function toggleInlineMarkdown(text: string, selection: TextSelection, marker: "**" | "_"): TextEdit {
  const start = Math.min(selection.start, selection.end);
  const end = Math.max(selection.start, selection.end);
  const selected = text.slice(start, end);

  if (selected.startsWith(marker) && selected.endsWith(marker) && selected.length >= marker.length * 2) {
    const inner = selected.slice(marker.length, -marker.length);
    return {
      text: text.slice(0, start) + inner + text.slice(end),
      selection: { start, end: start + inner.length }
    };
  }

  if (start >= marker.length && text.slice(start - marker.length, start) === marker && text.slice(end, end + marker.length) === marker) {
    return {
      text: text.slice(0, start - marker.length) + selected + text.slice(end + marker.length),
      selection: { start: start - marker.length, end: end - marker.length }
    };
  }

  const replacement = `${marker}${selected}${marker}`;
  const caretStart = start + marker.length;
  return {
    text: text.slice(0, start) + replacement + text.slice(end),
    selection: selected
      ? { start: caretStart, end: caretStart + selected.length }
      : { start: caretStart, end: caretStart }
  };
}

export function insertTextTab(text: string, selection: TextSelection, outward: boolean): TextEdit {
  const start = Math.min(selection.start, selection.end);
  const end = Math.max(selection.start, selection.end);
  const blockStart = text.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const effectiveEnd = end > start && text[end - 1] === "\n" ? end - 1 : end;
  const nextBreak = text.indexOf("\n", effectiveEnd);
  const blockEnd = nextBreak === -1 ? text.length : nextBreak;
  const multiline = end > start && text.slice(start, end).includes("\n");

  if (multiline) {
    const lines = text.slice(blockStart, blockEnd).split("\n");
    const nextLines = lines.map((line) => outward ? (line.startsWith("\t") ? line.slice(1) : line) : `\t${line}`);
    const nextBlock = nextLines.join("\n");
    return { text: text.slice(0, blockStart) + nextBlock + text.slice(blockEnd), selection: { start: blockStart, end: blockStart + nextBlock.length } };
  }

  if (!outward) {
    const next = text.slice(0, start) + "\t" + text.slice(end);
    return { text: next, selection: { start: start + 1, end: start + 1 } };
  }

  if (text[blockStart] === "\t") {
    const next = text.slice(0, blockStart) + text.slice(blockStart + 1);
    const caret = Math.max(blockStart, start - 1);
    return { text: next, selection: { start: caret, end: caret } };
  }
  if (start === end && start > 0 && text[start - 1] === "\t") {
    const next = text.slice(0, start - 1) + text.slice(start);
    return { text: next, selection: { start: start - 1, end: start - 1 } };
  }
  return { text, selection: { start, end } };
}

export function toggleMarkdownList(text: string, selection: TextSelection, ordered: boolean): TextEdit {
  const start = Math.min(selection.start, selection.end);
  const end = Math.max(selection.start, selection.end);
  const blockStart = text.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const effectiveEnd = end > start && text[end - 1] === "\n" ? end - 1 : end;
  const nextBreak = text.indexOf("\n", effectiveEnd);
  const blockEnd = nextBreak === -1 ? text.length : nextBreak;
  const lines = text.slice(blockStart, blockEnd).split("\n");
  const pattern = ordered ? /^(\s*)\d+[.)]\s+/ : /^(\s*)[-*+]\s+/;
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  const remove = nonEmpty.length > 0 && nonEmpty.every((line) => pattern.test(line));
  let number = 1;
  const changed = lines.map((line) => {
    if (remove) return line.replace(pattern, "$1");
    if (!line.trim() && lines.length > 1) return line;
    const withoutExisting = line.replace(/^(\s*)(?:[-*+]\s+|\d+[.)]\s+)/, "$1");
    const indent = withoutExisting.match(/^\s*/)?.[0] ?? "";
    const content = withoutExisting.slice(indent.length);
    const prefix = ordered ? `${number++}. ` : "- ";
    return `${indent}${prefix}${content}`;
  }).join("\n");
  return {
    text: text.slice(0, blockStart) + changed + text.slice(blockEnd),
    selection: { start: blockStart, end: blockStart + changed.length }
  };
}
