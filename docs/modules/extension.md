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
| `receive` | Validates protocol version and routes document replacement, import, save, export, presentation, and MCP commands. |
| `importAsset` | Enforces the 100 MB limit, hashes bytes, chooses a safe extension, creates the asset directory, and writes deduplicated content. |
| `webviewHtml` | Builds nonce-protected HTML with restricted resource roots and CSP. |

Normal visual edits must remain `WorkspaceEdit`s in `receive`; direct file writes
would break the editor's undo/autosave/external-change lifecycle.

## `src/presentation.ts`

`PresentationServer` owns one short-lived HTTP/WebSocket service.

- `start()` binds an ephemeral port on `127.0.0.1`, requires the session token
  for HTTP and WebSocket access, and sends initial state.
- `url(pathname)` returns a tokenized loopback URL.
- `command(next|previous|first|last)` clamps visible-slide state and broadcasts
  it.
- `dispose()` closes clients and the server.
- Private routing serves `/audience`, `/print`, `/contact`, `/frame`, and safe
  `/asset/<reference>` resources through core rendering and asset resolution.

Keep notes out of the audience document. New endpoints must retain token checks,
`no-store`, MIME safety, and loopback-only binding.

## `src/renderer.ts`

- `installRenderer(context, forcePrompt?)` stores a pinned Chromium build under
  extension global storage and asks for consent before downloading.
- `exportPdf(context, deck, deckPath)` prints `/print` at exact logical page
  size with backgrounds.
- `exportPng(context, deck, deckPath, slideIds?)` screenshots `/contact` for one
  slide or a contact sheet.

Both exporters must close the browser and server in `finally`. Playwright Core
is vendored into the VSIX; OS-specific Chromium is not.

## Manifest and build scripts

`package.json` owns custom editor selectors, JSON validation, commands, menus,
keybindings, bundled files, and VS Code engine compatibility. See the script
table in root [architecture.md](../../architecture.md) before altering build
outputs.

