# SlidePix architecture

This is the canonical entry point for developers and coding agents. Read this
file before changing code. Follow only the linked module document relevant to
the task; this keeps context small while making ownership explicit.

## Fast routing

| Goal | Start here | Also inspect |
| --- | --- | --- |
| Change the deck format or defaults | `packages/core/src/schema.ts` | [Core module](docs/modules/core.md), [deck format](docs/format.md) |
| Change Markdown, LaTeX, slide HTML, print, or morph behavior | `packages/core/src/render.ts` | [Core module](docs/modules/core.md) |
| Change editor UI or interactions | `packages/webview/src/App.tsx` | [Webview module](docs/modules/webview.md) |
| Change canvas element rendering | `packages/webview/src/SlideView.tsx` and `packages/core/src/render.ts` | [Webview](docs/modules/webview.md), [Core](docs/modules/core.md) |
| Change save/undo/external-edit behavior | `packages/extension/src/editor.ts` | [Extension module](docs/modules/extension.md) |
| Change commands or extension contributions | `packages/extension/src/extension.ts` and `packages/extension/package.json` | [Extension module](docs/modules/extension.md), `packages/extension/src/create-deck.ts` |
| Change presentation or presenter mode | `packages/extension/src/presentation.ts` | [Extension module](docs/modules/extension.md) |
| Change PDF/PNG export or browser installation | `packages/extension/src/renderer.ts` | [Extension module](docs/modules/extension.md) |
| Change PowerPoint export | `packages/extension/src/pptx-export.ts` | [Extension module](docs/modules/extension.md) |
| Change standalone web export | `packages/extension/src/web-export.ts` | [Extension module](docs/modules/extension.md) |
| Change MCP tools or selection rules | `packages/mcp/src/server.ts` and `packages/mcp/src/tools.ts` | [MCP module](docs/modules/mcp.md) |
| Set up a Linux/macOS toolchain, compile, and install a local VSIX | [Install guide](docs/install.md) | [Development guide](docs/development.md) |
| Change build/package/release work | root and package `package.json` files | [Development guide](docs/development.md) |

## System map

```text
talk.slidepix.json ── CustomTextEditorProvider ── versioned messages ── React webview
       │                         │                                      │
       │                         ├── link workspace media               └── visual edits
       │                         ├── embed copy → talk.assets/
       │                         └── WorkspaceEdit ← serialized deck         │
       └──────────────────────────────────────────────────────────────────────┘

base / ours / theirs ── @slidepix/core semantic merge ── validated canonical deck
          ├── live external-edit and multi-panel rebase
          └── repository-local Git merge driver and conflict resolver

@slidepix/core schema + renderer
       ├── editor canvas/thumbnails
       ├── audience and presenter server
       ├── PDF/PNG through pinned Chromium
       ├── native editable PPTX through semantic OOXML conversion
       ├── standalone offline web folder
       └── read-only MCP inspection/rendering
```

The JSON document is the source of truth. The webview never writes files
directly: it serializes a full deck and asks the extension host to apply a
`WorkspaceEdit`. This is what preserves VS Code/Cursor undo, autosave, backup,
external edits, and multi-editor synchronization.

## Package boundaries

| Package | Owns | Must not own |
| --- | --- | --- |
| `@slidepix/core` | Zod schema, types, parsing, stable serialization, safe asset paths, shared HTML renderer, message protocol | VS Code APIs, React state, MCP transport |
| `@slidepix/webview` | React editor, selection, manipulation, inspector, notes, transient UI state | filesystem access, authoritative persistence, headless browser lifecycle |
| `slidepix` extension | VS Code custom editor lifecycle, commands, assets, local presentation server, renderer download/export | deck-format forks or a second rendering implementation |
| `@slidepix/mcp` | read-only stdio tools and deterministic slide selection/rendering | any create/update/delete operation |

Detailed ownership and method contracts:

- [Core schema, rendering, assets, and protocol](docs/modules/core.md)
- [React webview and state](docs/modules/webview.md)
- [Extension host, presentation, and export](docs/modules/extension.md)
- [MCP server and tools](docs/modules/mcp.md)

## Non-negotiable invariants

1. `*.slidepix.json` remains the authoritative, human-readable document.
2. Every persisted deck is parsed and serialized through `deckSchema`; unknown
   future schema versions are rejected without overwriting the source.
3. Element IDs are unique. Duplicating a slide creates new element IDs but
   preserves each element name. Morph matches that name when it is unique on
   the slide.
4. Every media element declares `storage`. `embedded` references stay inside
   the sibling asset directory; `linked` references stay relative and may only
   resolve inside an open workspace root. All consumers receive the storage
   mode explicitly and use the shared safe resolver.
5. Editor changes cross the versioned protocol and become `WorkspaceEdit`s.
   Do not bypass the text-document lifecycle with `writeFile` for normal edits.
6. Webview HTML keeps a restrictive content security policy and narrowly scoped
   `localResourceRoots`. Markdown does not execute arbitrary HTML or script.
7. Rendering semantics belong in `@slidepix/core`. Editor, presentation, export,
   and MCP should not independently reinterpret deck fields.
8. Presentation HTTP and WebSocket services bind only to `127.0.0.1` and require
   an unguessable per-session token.
9. MCP v0.1 stays read-only. Its tools must not write a deck or its assets.
10. Chromium is OS-specific, consented, pinned, and stored outside the VSIX.
11. Every document replacement names its exact base revision. Stale edits are
    semantically rebased or surfaced as conflicts; they are never applied
    blindly over newer source.

## Source, generated, and packaged files

Edit source files, then regenerate outputs with the documented commands.

| Path | Kind | Rule |
| --- | --- | --- |
| `packages/*/src/**` | source | Edit directly. |
| `packages/extension/schema/slidepix.schema.json` | generated | Change `packages/core/src/schema.ts`, then run `pnpm build`. |
| `packages/core/dist`, `packages/mcp/dist`, `packages/extension/dist` | generated | Never hand-edit. |
| `packages/extension/media` | generated webview bundle | Change `packages/webview/src`, then run `pnpm build`. |
| `packages/extension/vendor/playwright-core` | generated vendored runtime | Regenerated by the extension build; never patch in place. |
| `packages/extension/slidepix-*.vsix` | packaged artifact | Produce with `pnpm package`; do not treat it as source. |

## Commands and scripts

| Command or script | Responsibility |
| --- | --- |
| `pnpm build` | Builds core, webview, MCP, extension, and the standalone Git merge driver in dependency order; also generates schema and vendors Playwright Core. |
| `pnpm dev` | Watches the webview and extension packages for local extension development. |
| `pnpm test` | Runs core schema/rendering tests, extension presentation-state tests, and MCP selection tests. |
| `pnpm typecheck` | Type-checks every workspace package without emitting files. |
| `pnpm docs:check` | Verifies local Markdown links and required agent-native files. |
| `pnpm package` | Performs a full workspace build and creates the VSIX. |
| `packages/extension/scripts/generate-schema.mjs` | Converts the Zod deck schema into the contributed draft-7 JSON Schema. |
| `packages/extension/scripts/vendor-playwright.mjs` | Copies the installed `playwright-core` package into the extension bundle. |
| `scripts/render-smoke.mjs [deck] [output]` | Uses installed Chromium to create a smoke-test PDF, contact sheet, exact-size single-slide PNG, and one exact-size PNG per visible slide from a built deck. |
| `scripts/build-demo.mjs <hero> [video poster]` | Rebuilds the canonical light-theme product demo through the core schema; the optional embedded reel is generated separately from exported PNGs with FFmpeg. |
| `scripts/check-docs.mjs` | Implements `pnpm docs:check`; reports broken local links or missing native agent files. |

See [docs/install.md](docs/install.md) for Linux/macOS (zsh) toolchain setup,
first build, packaging, and local VSIX install. See
[docs/development.md](docs/development.md) for exact commands, debugging,
verification levels, and packaging.

## Change protocol

For any nontrivial change:

1. Locate the owning package using **Fast routing**.
2. Read its module document and the source it names.
3. Identify whether a schema, protocol, renderer, or security invariant changes.
4. Make the smallest change in the owning module; reuse shared rendering.
5. Add or update the closest test.
6. Run `pnpm docs:check`, `pnpm test`, `pnpm typecheck`, and `pnpm build` as
   appropriate to the touched packages.
7. If visuals changed, run the render smoke test and inspect both outputs.
8. Update this index or the relevant module document when ownership, public
   methods, scripts, commands, or invariants change.

## Current v0.1 gaps

Do not assume every planned feature is complete. Current known gaps include:

- grouping is not implemented;
- layouts exist in the schema but have no layout designer;
- portable `.slidepix` archives, font importing, and embedded fonts are not
  implemented;
- the text source editor is a textarea; CodeMirror and syntax-highlighted code
  output are not integrated;
- automated VS Code custom-editor integration and Cursor smoke tests are still
  missing.

When implementing a gap, update this list in the same change.
