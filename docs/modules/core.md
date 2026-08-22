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
same sanitizer. Shape shadows use CSS drop shadows so triangles and ellipses
follow their silhouette.
Presentation state is initialized before a destination morph starts; otherwise
timeline reset would immediately cancel the new Web Animations. The runtime
also tolerates browsers that omit `Element.getAnimations`.

### `src/protocol.ts`

`PROTOCOL_VERSION`, `HostToWebviewMessage`, and `WebviewToHostMessage` define the
only extension↔webview messages. Add a new union member for a new operation and
handle it exhaustively on both sides. Bump the protocol only for an incompatible
wire change, not for every new compatible message.

### `src/index.ts`

The package's stable root export surface. Asset helpers deliberately use the
`@slidepix/core/assets` subpath. Add exports intentionally; consumers should not
reach into `src`.

## Tests

`src/schema.test.ts` covers deck creation, round-trip serialization, invalid
JSON, future schema versions, morph-key duplication, and asset traversal.
`src/render.test.ts` covers presenter-frame selection/fitting, presentation
animation state and video lifecycle, negative layers, print pagination CSS,
syntax highlighting, typography parity, transparent paint, shape shadows,
Markdown tables, four-sided image fades, and resolver storage routing. Put
pure core regressions here before using slower integration tests.
