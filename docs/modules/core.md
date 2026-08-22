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
| `createDeck(title?)` | Creates one valid 1920×1080 deck with a centered title text element. |
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

All extension, presentation, export, and MCP asset reads must use these helpers.
Add security tests for path-handling changes.

### `src/render.ts`

| Export | Contract |
| --- | --- |
| `renderMarkdown(source)` | Produces sanitized HTML from Markdown with KaTeX/MathML. Raw HTML is disabled; links receive safe attributes. |
| `renderSlideMarkup(deck, slide, resolveAsset?, pageIndex?)` | Produces one positioned logical slide with all supported element types. |
| `renderDeckDocument(deck, resolveAsset?, options?)` | Produces a standalone document for `present`, `print`, or `contact` mode, including shared CSS and presentation motion runtime. |
| `AssetResolver` | Maps a stored asset reference to a webview URL, loopback URL, or data URI without changing render logic. |

The React canvas has a separate component tree because it needs interaction,
but it must match this renderer's visual semantics. Any field that changes how
an element looks should be implemented and tested in both `render.ts` and
`packages/webview/src/SlideView.tsx`.

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
JSON, future schema versions, morph-key duplication, and asset traversal. Put
pure core regressions here before using slower integration tests.
