# Core module

Package: `@slidepix/core`

Purpose: define the only authoritative deck model, safe asset addressing,
cross-process message types, and shared DOM/HTML rendering semantics.

## Files and public methods

### `src/schema.ts`

| Export | Contract |
| --- | --- |
| `deckSchema` and child schemas | Zod v4 executable data model. `deckSchema` is also the JSON Schema source. |
| `parseDeckText(text)` | Parses JSON, rejects unsupported future versions, validates the full model, and returns a discriminated success/error result instead of throwing. |
| `serializeDeck(deck)` | Revalidates a deck and returns stable two-space JSON with a final newline. Throws on invalid in-memory data. |
| `createDeck(title?)` | Creates one valid 1920×1080 light-theme deck with a centered dark title using a portable system-font stack. |
| `duplicateSlide(slide)` | Deep-copies the slide, creates new slide/element IDs, preserves morph keys, and clears the timeline. |
| `Deck`, `Slide`, element and motion types | Types inferred from their schemas; do not maintain parallel handwritten interfaces. |

When adding a persisted field, define validation/defaults here, add parser and
serialization tests, rebuild the contributed JSON Schema, and update
`docs/format.md`. Schema migrations are planned but not yet implemented; a
version bump must include an explicit migration strategy.

The deck refinement enforces unique slide, element, and animation IDs, local
animation targets, and valid layout references. These checks protect manual and
Git-merged documents as well as normal editor writes.

### `src/merge.ts`

| Export | Contract |
| --- | --- |
| `mergeDecks(base, ours, theirs, resolutions?)` | Pure ID-aware three-way deck merge with canonical output. It never reads Git or the filesystem. |
| `DeckMergeResult` | Clean result with validated deck/text, or a partial validated deck plus structured conflicts. |
| `DeckMergeConflict` | Stable conflict ID, kind, property path, entity IDs, values, and user-facing message. |
| `DeckMergeResolution` | Explicit `base`, `ours`, or `theirs` choice used to rerun the deterministic merge. |

The editor rebase path and bundled Git driver must both use this function. Do
not create a second merge interpretation in the extension or webview.

### `src/assets.ts`

| Export | Contract |
| --- | --- |
| `deckAssetDirectory(deckPath)` | Maps `talk.slidepix.json` to sibling `talk.assets`. |
| `normalizeAssetReference(reference)` | Converts backslashes to POSIX separators and removes one leading `./`. |
| `resolveAssetPath(deckPath, reference)` | Resolves inside the asset root and rejects absolute, empty, NUL, or escaping paths. |
| `resolveMediaPath(deckPath, reference, storage, allowedLinkedRoots?)` | Resolves embedded media through the asset root or linked media through an allowlist of workspace roots. |

All extension, presentation, export, and MCP asset reads must use these helpers.
Add security tests for path-handling changes.

### `src/render.ts`

| Export | Contract |
| --- | --- |
| `renderMarkdown(source)` | Produces sanitized HTML from Markdown with KaTeX/MathML and deterministic Highlight.js code tokens. Raw HTML is disabled; links receive safe attributes. |
| `parsePresentationMarkdown(source)` | Produces presentation-neutral rich text, list, code, math, and table blocks from the same configured Markdown parser for semantic exporters. |
| `renderPresentationMathMl(latex, displayMode?)` | Produces MathML for native equation exporters using the core KaTeX dependency. |
| `renderSlideMarkup(deck, slide, visibleIndex, resolveAsset?)` | Produces one positioned logical slide with all supported element types. |
| `renderDeckDocument(deck, resolveAsset?, options?)` | Produces a standalone document for `present`, `frame`, `print`, or `contact` mode, including shared CSS and the relevant viewport/motion runtime. |
| `AssetResolver` | Maps `(reference, storage)` to a webview URL, loopback URL, or data URI without changing render logic. Never infer storage from the path string. |

The React canvas has a separate component tree because it needs interaction,
but it must match this renderer's visual semantics. Any field that changes how
an element looks should be implemented and tested in both `render.ts` and
`packages/webview/src/SlideView.tsx`.

Slides are isolated stacking contexts: their background paints below every
element, including deliberately negative `z` values. Print mode relies on each
slide's exact page height and avoids breaks inside slides; it does not force an
after-break that could create a trailing blank PDF page. Shared code-token
classes and colors are consumed by editor, presentation, export, and MCP.
Text keeps its declared logical pixel size in every output: editor and
standalone documents use the same `slidepix-text-content` typography contract
and disable browser text autoscaling. Tables render cell Markdown through the
same sanitizer and center header cells independently of body alignment. Image
edge fade is a geometry-derived blurred rounded-rectangle SVG mask shared with
the editor, so it follows corner radius rather than producing square corners.
Shape shadows use CSS drop shadows so triangles and ellipses follow their
silhouette.
Presentation state is initialized before a destination morph starts; otherwise
timeline reset would immediately cancel the new Web Animations. The runtime
also tolerates browsers that omit `Element.getAnimations`. Directional slide
transitions keep both complete slides mounted and push them together across an
absolutely positioned, clipped stage; the document and letterbox background is
the deck theme background rather than a hard-coded dark color.

### `src/protocol.ts`

`PROTOCOL_VERSION` (currently 2), `HostToWebviewMessage`, and
`WebviewToHostMessage` define the
only extension↔webview messages. Media import, native system-font selection,
and serialized history use request IDs with typed host responses. History
results include the authoritative post-command revision before another
undo/redo runs. Add a new union member for a new operation and handle it
exhaustively on both sides. Bump the protocol only for an incompatible wire
change, not for every new compatible message.

Export commands include the compatible `exportPptx` member; adding it did not
change protocol version 2.

Deck messages carry an opaque exact-text revision. Replacement requests echo
their base revision and receive an explicit accepted, stale, invalid, or failed
response; a host must never apply a replacement against another revision.

### `src/index.ts`

The package's stable root export surface. Asset helpers deliberately use the
`@slidepix/core/assets` subpath. Add exports intentionally; consumers should not
reach into `src`.

## Tests

`src/schema.test.ts` covers deck creation, round-trip serialization, invalid
JSON, future schema versions, identity/reference integrity, morph-key
duplication, and asset traversal. `src/merge.test.ts` covers clean semantic
merges, additions, cells, delete/edit and value conflicts, resolutions,
ordering, and determinism.
`src/render.test.ts` covers presenter-frame selection/fitting, presentation
animation state and video lifecycle, negative layers, print pagination CSS,
syntax highlighting, typography parity, transparent paint, shape shadows,
Markdown tables, four-sided image fades, and resolver storage routing. Put
pure core regressions here before using slower integration tests.
