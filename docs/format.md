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
- New decks default to a white background, dark foreground, blue accent, and a
  portable system UI font stack. Existing decks keep their persisted theme.
- `(0, 0)` is the top-left corner. Positive X moves right; positive Y moves
  down.
- IDs are stable non-empty strings. New objects currently use UUIDs.
- Element `id` identifies one concrete object. Morph matches a trimmed
  `name` that is unique among the visible elements on its slide. A blank name,
  or the same name twice on one slide, does not morph. `morphKey` stays in the
  file for compatibility and is not the match.
- Slide duplication generates a new slide ID and new element IDs, preserves
  element names and morph keys, and clears the animation timeline.

## Version and validation

`schemaVersion` is currently `1`. A higher version is rejected explicitly so an
older extension cannot silently discard fields. Malformed or schema-invalid
manual edits produce diagnostics and leave the last valid visual preview
untouched in memory; the error screen remains visible until valid source is
saved. Invalid source is not overwritten by the webview.

Serialization uses two-space JSON indentation and one final newline. All writes
pass through the Zod schema, which also fills declared defaults.

Validation also requires unique slide, element, and animation IDs. Every
animation target must exist on its slide, and every slide layout reference must
name a persisted layout.

## Git merge semantics

The optional SlidePix Git driver performs a three-way merge by stable entity
ID. One-sided edits, identical edits, different properties, different table
cells, and concurrent additions merge automatically. When both branches insert
into the same ordered gap, each branch's order is retained and the current
branch's additions come first.

Delete-versus-edit, different values for the same property, and incompatible
two-sided reorders remain conflicts. A one-sided reorder is accepted. Every
clean or interactively resolved result is validated and serialized canonically;
invalid inputs fall back to ordinary Git conflict markers.

## Top-level model

- `metadata`: title, author, and description.
- `size`: logical width and height.
- `theme`: deck background, foreground, accent, and default font family.
- `pageNumbers`: color and size. Numbers are always shown; a saved deck forces
  `enabled` on and clears per-slide `hidePageNumber`.
- `layouts`: reusable named background definitions. The UI designer is not yet
  implemented.
- `slides`: at least one ordered slide.

A slide contains its title, optional layout/background color, optional
`backgroundImage` (`src` plus explicit linked/embedded storage), speaker notes,
hidden state, incoming transition, animation timeline,
and ordered elements. Background images stretch to the exact logical slide
rectangle in every renderer and export.

Element types are `text`, `image`, `video`, `manim`, `shape`, and `table`. Shared geometry fields
are `x`, `y`, `width`, `height`, `rotation`, `opacity`, and `z`; shared behavior
includes locking, hiding, optional name, and optional accessibility text.
Image and video elements also carry `storage: "linked" | "embedded"`; the
`src` string alone is never enough to decide its security boundary. Optional
`lockAspectRatio` defaults to on. `aspectRatio` is the ratio of the current
media frame (width divided by height): new media starts at its source ratio,
while cropping updates it to the cropped frame ratio. The flag constrains
interactive resizing; parsing and saving never rewrite stored geometry.

A `manim` element stores a workspace-linked `script` path (POSIX relative to
the deck), optional `scene` class name, `output` (`image` or `video`),
`quality` (`low`, `medium`, `high`, or `production`), optional `transparent`
background, optional embedded `outputMedia` produced by the extension host,
and video `playback` settings when `output` is `video`. The `.py` source stays
linked in the workspace; only rendered PNG/MP4/WebM bytes are embedded in
`talk.assets/`. Re-render from the editor after changing the script.

Text paints past its box. The slide still clips at its own edges. Tab characters
in Markdown stay as tab stops. `style.lineHeight` is the spacing within a
paragraph. A blank line separates blocks with a `0.5em` margin on each side.

Shape fills and strokes accept CSS colors including the literal `transparent`.
A shape also stores a shadow object (`enabled`, color, X/Y offset, and blur);
older shapes receive a disabled shadow through schema defaults. Tables store
bounded row/column counts, a Markdown cell matrix, an optional header row, and
typography/fill/border style. Renderers treat missing cells as empty, while the
editor's row/column actions normalize the matrix before it is saved.

See [Core module](modules/core.md) for parser and serializer method contracts.
