# Extension module

Package: `slidepix`

Purpose: connect the shared deck model and React webview to VS Code/Cursor APIs,
own assets and persistence, serve presentations, and manage deterministic
exports.

## `src/extension.ts`

`activate(context)` constructs one `SlidePixEditorProvider` and registers every
public command. Command IDs must stay aligned with `package.json` contributions
and webview command union members.

Private command helpers:

- `createDeckCommand()` asks for a path, normalizes the suffix, writes a valid
  default deck, and opens it with the custom editor.
- `withDeck(editor, action)` requires an active deck, validates current text,
  and only invokes the action for a valid document.
- `configureMcp(context)` ensures the renderer exists and produces previewable
  VS Code/Cursor stdio configuration. It intentionally does not edit workspace
  agent configuration.

## `src/editor.ts`

`SlidePixEditorProvider` implements `CustomTextEditorProvider`.

| Method | Responsibility |
| --- | --- |
| `register()` | Registers the provider, listens for text changes, and disposes live presentation sessions. |
| `resolveCustomTextEditor(document, panel)` | Configures safe webview roots/CSP, tracks panels, installs message handlers, and preserves multiple views per document. |
| `currentDocument()` | Returns the most recently active SlidePix text document for commands. |
| `present(document, presenter?)` | Validates, creates an authenticated loopback session, opens the audience browser, and optionally creates the presenter panel. |
| `updatePanels` / `postDeck` | Reparse every document change and send either a valid deck or diagnostic while preserving the source text. |
| `receive` | Validates protocol version and routes document replacement, host-owned undo/redo, import, save, export, presentation, and MCP commands. |
| `importAsset` | Enforces the 100 MB limit and stores clipboard/browser file bytes as deduplicated embedded content. |
| `selectMedia` / `resolveMedia` | Chooses or accepts an Explorer-dropped local file, validates kind/size, links it relative to the deck when it is inside an open workspace, and embeds otherwise. |
| `embedMedia` | Converts selected or all linked media to content-addressed copies and applies the changed deck through `WorkspaceEdit`. |
| `selectFont` | Scans platform font directories, opens a native searchable quick picker, and returns the selected CSS family through the versioned protocol. |
| `webviewHtml` | Builds nonce-protected HTML with restricted resource roots and CSP. |

Normal visual edits must remain `WorkspaceEdit`s in `receive`; direct file writes
would break the editor's undo/autosave/external-change lifecycle.
Undo/redo messages execute VS Code's built-in history commands rather than
maintaining a competing history inside the webview.

## `src/fonts.ts`

`discoverSystemFontFamilies()` scans bounded platform font directories without
loading font binaries. `fontFamilyFromFilename()` derives searchable family
labels and `cssFontFamily()` creates a quoted stack with a suitable fallback.
Keep these pure helpers independently testable; the VS Code picker stays in
`editor.ts`.

## `src/presentation.ts`

`PresentationServer` owns one short-lived HTTP/WebSocket service.

- `start()` binds an ephemeral port on `127.0.0.1`, requires the session token
  for HTTP and WebSocket access, and sends initial state.
- `url(pathname)` returns a tokenized loopback URL.
- `command(next|previous|first|last)` clamps visible-slide state and broadcasts
  only when the index changes. Forward navigation initializes entrance state;
  backward navigation completes the destination's timeline so a previously
  visited slide is not an unexpectedly empty canvas.
- `control(next|previous)` asks the connected audience to advance its current
  animation sequence before moving slides; without an audience it falls back
  to direct clamped navigation.
- `dispose()` closes clients and the server.
- Private routing serves `/audience`, `/print`, `/contact`, `/frame`, and safe
  `/asset/<reference>` resources through storage-aware core rendering and safe
  embedded/workspace-linked resolution.
  `/frame` uses core's viewport-fitting frame mode for presenter previews and
  returns an explicit end-of-presentation frame for out-of-range indices.

Presenter current/next iframes are double-buffered. A loaded preview replaces
the old frame atomically, preventing black flashes or stale rapid-click loads.
Preview shells and the explicit end-of-deck frame use the deck theme background
instead of a hard-coded dark placeholder.

Keep notes out of the audience document. New endpoints must retain token checks,
`no-store`, MIME safety, and loopback-only binding.
The audience runtime pauses every video on the slide being left and whenever
the browser becomes hidden; autoplay media resumes only on the active slide.

`src/presentation.test.ts` verifies boundary navigation, audience-less control
fallback, and the explicit end-of-deck frame.

## `src/presenter.ts`

`presenterHtml(session, deck)` builds the VS Code presenter panel without
depending on the VS Code runtime, so its current/next double-buffer behavior is
unit-testable in `src/presenter.test.ts`. Keep speaker notes in this private
panel and out of audience HTML.

## `src/renderer.ts`

- `installRenderer(context, forcePrompt?)` stores a pinned Chromium build under
  extension global storage and asks for consent before downloading.
- `exportPdf(context, deck, deckPath)` prints `/print` at exact logical page
  size with backgrounds and caps the PDF page range to the visible-slide count,
  preventing Chromium from retaining a trailing blank pagination page.
- `exportPng(context, deck, deckPath, slideIds?)` screenshots the single slide
  element at exact logical dimensions, or the full `/contact` page for a
  multi-slide contact sheet.

Both exporters must close the browser and server in `finally`. Playwright Core
is vendored into the VSIX; OS-specific Chromium is not.

## Manifest and build scripts

`package.json` owns custom editor selectors, JSON validation, commands, menus,
keybindings, bundled files, and VS Code engine compatibility. See the script
table in root [architecture.md](../../architecture.md) before altering build
outputs.
