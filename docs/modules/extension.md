# Extension module

Package: `slidepix`

Purpose: connect the shared deck model and React webview to VS Code/Cursor APIs,
own assets and persistence, serve presentations, and manage deterministic
PDF, PNG, PowerPoint, and standalone web exports.

## `src/extension.ts`

`activate(context)` constructs one `SlidePixEditorProvider` and registers every
public command. Command IDs must stay aligned with `package.json` contributions
and webview command union members.

Private command helpers:

- `createDeckCommand()` writes `untitled.slidepix.json` beside the selected
  Explorer file/folder (falling back to the active SlidePix document, the
  active editor tab, or the workspace root) and opens it with `writeFile`.
  Existing untitled decks increment to `untitled-2.slidepix.json`. Unique names
  come from `uniqueDeckFilename()` in `src/create-deck.ts`. Command Palette and
  Explorer both skip the save dialog and filename prompt.
- `withDeck(editor, action)` requires an active deck, validates current text,
  and only invokes the action for a valid document.
- `configureMcp(context)` installs the renderer, then adds a `slidepix` stdio
  server for Cursor (`~/.cursor/mcp.json`), VS Code (profile `mcp.json`),
  Codex (`~/.codex/config.toml`), Claude Code (`~/.claude.json`), and Claude
  Desktop. Other servers and unrelated settings in those files are kept. A
  malformed file is skipped and reported.
- Git collaboration commands configure/remove only repository-local settings
  for the active deck and resolve remaining conflicts from Git index stages.

## `src/editor.ts`

`SlidePixEditorProvider` implements `CustomTextEditorProvider`.

| Method | Responsibility |
| --- | --- |
| `register()` | Registers the provider, listens for text changes, and disposes live presentation sessions. |
| `resolveCustomTextEditor(document, panel)` | Configures safe webview roots/CSP, tracks panels, installs message handlers, and preserves multiple views per document. |
| `currentDocument()` | Returns the most recently active SlidePix text document for commands. |
| `present(document, presenter?)` | Validates, creates an authenticated loopback session, opens the audience browser, and optionally creates the presenter panel. |
| `updatePanels` / `postDeck` | Reparse every document change and send either a valid deck or diagnostic plus its exact-text revision. |
| `receive` | Validates protocol/base revisions and deck text before applying a `WorkspaceEdit`, records a snapshot, acknowledges the result, and routes host-owned commands. |
| `applyHistory` | Restores the previous or next recorded snapshot through `WorkspaceEdit`. |
| `importAsset` | Enforces the 100 MB limit and stores clipboard/browser file bytes as deduplicated embedded content. |
| `selectMedia` / `resolveMedia` | Chooses or accepts an Explorer-dropped local file, validates kind/size, links it relative to the deck when it is inside an open workspace, and embeds otherwise. |
| `embedMedia` | Converts selected or all linked media to content-addressed copies and applies the changed deck through `WorkspaceEdit`. |
| `selectFont` | Scans platform font directories, opens a native searchable quick picker, and returns the selected CSS family through the versioned protocol. |
| `webviewHtml` | Builds nonce-protected HTML with restricted resource roots and CSP, including `connect-src` limited to `webview.cspSource`, `data:`, and `blob:` so export inlining can fetch already-allowed local assets. |

`src/document-history.ts` owns the capped snapshot stack used by undo/redo.

`src/editor-recovery.ts` works around a Cursor case where the workbench holds
a deck's text model without synchronizing it to extensions. The custom editor
then fails before `resolveCustomTextEditor` runs, and every reopen of that path
fails the same way. If an active SlidePix tab is unresolved after 1.5 s and
the extension host has no document for it, the provider opens the document
with an explicit encoding, which forces workbench synchronization, then closes
and reopens the tab once per 10 s cooldown. Failures are reported, not
swallowed. `src/editor-recovery.test.ts` covers the decision rules.

Webview-triggered PowerPoint and web exports carry an optional request ID. The
provider reports completion or failure through a typed `notify` message so the
editor can replace its non-blocking progress toast; command-palette exports
keep their native VS Code notifications. Toolbar PDF/PNG capture sends
`saveExport` with a data URI; the provider writes the chosen file through
`workspace.fs`. `log` messages append to the SlidePix output channel and show
it on errors.

Normal visual edits must remain `WorkspaceEdit`s in `receive`; direct file writes
would break the editor's autosave/external-change lifecycle.
Each successful replacement records the previous document text on a per-document
snapshot stack (capped). Acknowledged history messages restore the previous or
next snapshot through `WorkspaceEdit` instead of `executeCommand("undo")`, which
is a no-op while the custom-editor webview has focus. The webview serializes
these acknowledgements, so it never races a pending replacement.

## `src/git-collaboration.ts` and `src/merge-driver.ts`

- **Configure Git Collaboration** previews and then writes one managed
  `.gitattributes` block plus repository-local `merge.slidepix` settings.
- The bundled driver is copied to stable extension global storage and invoked
  with the editor's Electron runtime in Node mode. It uses core `mergeDecks` and
  falls back to `git merge-file` markers for invalid or ambiguous inputs.
- **Resolve Git Conflict** reads stages 1/2/3 with argument-safe Git processes,
  collects explicit choices, validates, writes through `WorkspaceEdit`, and
  stages only after a separate action and successful save.
- **Remove Git Collaboration** removes only the managed block and matching
  configuration; customized settings are preserved with a warning.

`src/git-collaboration.test.ts` verifies managed attributes and the bundled
driver directly and through a temporary Git repository, including paths with
spaces and marker fallback. `src/document-history.test.ts` covers snapshot
undo/redo, redo invalidation, and the history cap. `src/mcp-config.test.ts`
covers the Codex table replacement and JSON merges that keep other servers.

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

- `launchSystemBrowser()` finds the user's existing Google Chrome or Microsoft Edge installation through Playwright channels, requiring no heavy binary downloads.
- `exportPdf(context, deck, deckPath)` prints `/print` at exact logical page
  size with backgrounds and caps the PDF page range to the visible-slide count,
  preventing Chromium from retaining a trailing blank pagination page.
- `exportPng(context, deck, deckPath, slideIds?)` screenshots the single slide
  element at exact logical dimensions, or the full `/contact` page for a
  multi-slide contact sheet.

Both exporters must close the browser and server in `finally`. Playwright Core
is vendored into the VSIX; it connects to the system's Edge/Chrome browser.

## `src/pptx-export.ts` and `src/pptx-export-command.ts`

- `exportPptx(context, deck, deckPath)` owns the save dialog, progress, and the
  approximation report in the SlidePix PowerPoint Export output channel. It
  does not install or launch Chromium.
- `buildPptxExport(deck, deckPath, destination, allowedLinkedRoots)` validates
  every visible media reference with `resolveMediaPath`, builds native objects,
  writes a sibling temporary file, and replaces the selected `.pptx` only after
  generation succeeds.
- A slide background image is resolved with the same storage-aware path rules
  and exported as the bottommost full-slide native picture.
- The extension generates OOXML directly with pinned PptxGenJS. LibreOffice is
  useful as a compatibility oracle in development but is not a runtime
  dependency or conversion step.
- Rich Markdown and Highlight.js tokens become editable PowerPoint text runs.
  Equations use native OfficeMath in an OOXML compatibility choice, with an
  editable linear-math fallback for readers that do not implement OfficeMath;
  unsupported conversions also retain editable linear LaTeX and emit a warning.
  Shapes, tables, pictures, video, notes, and page numbers remain native objects.
  There is no screenshot fallback.
- `src/pptx-ooxml.ts` patches package XML for OfficeMath, picture crop/rounding/
  soft-edge/border effects, fade/push/Morph transitions, `!!` object names
  taken from the unique element name, and appear/fade/fly animation timing.
- Hidden slides and elements are omitted. System fonts are referenced rather
  than embedded; unsupported CSS easing and browser-only details use the closest
  native PowerPoint equivalent and produce structured warnings.

`src/playwright.ts` is the VS Code-independent loader for the vendored
Playwright Core package, allowing renderer-backed exporters to remain directly
unit-testable.

## `src/web-export.ts` and `src/web-export-command.ts`

- `buildWebExport(deck, deckPath, destination, allowedLinkedRoots)` stages a
  static `index.html` plus content-addressed media under `assets/`, then renames
  the complete directory into place. Existing destinations are never merged or
  replaced, and failed builds remove their private staging directory.
- The bundle uses core's `present` document and adds only the offline
  click/keyboard controller needed in place of the live server's WebSocket
  bridge. Hidden slides, notes, source JSON, and unused media are excluded.
- Embedded and linked media reads must pass through `resolveMediaPath`. Linked
  files are limited to open file-workspace roots, while video posters retain
  the renderer's embedded-storage contract.
- `exportWeb(deck, deckPath)` owns the save dialog, collision retry, progress,
  and user-facing completion/error messages. It does not install Chromium.

## Manifest and build scripts

`package.json` owns custom editor selectors, JSON validation, commands, menus,
keybindings, bundled files, and VS Code engine compatibility. Its build emits
the extension, MCP server, and standalone semantic merge-driver bundles. See
the script table in root [architecture.md](../../architecture.md) before
altering build outputs.

The Explorer context menu contributes **SlidePix: Create Deck** so the selected
file or folder URI can be used as the creation location without opening a
filesystem-wide save dialog or filename prompt.
