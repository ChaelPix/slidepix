# SlidePix deck format

This document records storage invariants. The executable definition is
`packages/core/src/schema.ts`; when prose and code disagree, the schema is the
current behavior and the documentation should be corrected.

## Files

A deck named `talk.slidepix.json` can link media inside the open workspace or
store portable copies in `talk.assets/`:

```text
talk.slidepix.json
talk.assets/
  1ad8…e3.png
  a772…19.mp4
```

New files chosen from or dropped out of the VS Code/Cursor Explorer use
`storage: "linked"` by default and keep a POSIX-style path relative to the deck.
They may resolve only inside an open workspace root. **Embed in .assets** and
the toolbar's **Embed all** command copy linked media into the sibling asset
directory and change the element to `storage: "embedded"`.

Embedded assets are named by SHA-256 content hash plus a safe extension, which
deduplicates identical media. Embedded references resolve only inside the asset
directory. Absolute paths, NUL bytes, and traversal outside the applicable
root are rejected. Decks created before `storage` existed parse as `embedded`
for backward compatibility.

## Coordinates and identity

- Default slide size is 1920×1080 logical units; custom positive dimensions
  are valid.
- `(0, 0)` is the top-left corner. Positive X moves right; positive Y moves
  down.
- IDs are stable non-empty strings. New objects currently use UUIDs.
- Element `id` identifies one concrete object. `morphKey` identifies the same
  visual object across slides.
- Slide duplication generates a new slide ID and new element IDs, preserves
  element morph keys, and clears the animation timeline.

## Version and validation

`schemaVersion` is currently `1`. A higher version is rejected explicitly so an
older extension cannot silently discard fields. Malformed or schema-invalid
manual edits produce diagnostics and leave the last valid visual preview
untouched in memory; the error screen remains visible until valid source is
saved. Invalid source is not overwritten by the webview.

Serialization uses two-space JSON indentation and one final newline. All writes
pass through the Zod schema, which also fills declared defaults.

## Top-level model

- `metadata`: title, author, and description.
- `size`: logical width and height.
- `theme`: deck background, foreground, accent, and default font family.
- `pageNumbers`: deck-wide visibility, color, and size.
- `layouts`: reusable named background definitions. The UI designer is not yet
  implemented.
- `slides`: at least one ordered slide.

A slide contains its title, optional layout/background, speaker notes, hidden
state, page-number override, incoming transition, animation timeline, and
ordered elements.

Element types are `text`, `image`, `video`, and `shape`. Shared geometry fields
are `x`, `y`, `width`, `height`, `rotation`, `opacity`, and `z`; shared behavior
includes locking, hiding, optional name, and optional accessibility text.
Image and video elements also carry `storage: "linked" | "embedded"`; the
`src` string alone is never enough to decide its security boundary.

See [Core module](modules/core.md) for parser and serializer method contracts.
