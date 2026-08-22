# Webview module

Package: `@slidepix/webview`

Purpose: render and manipulate a deck inside the VS Code/Cursor custom-editor
webview. The webview has no direct filesystem or Node access.

## Files and responsibilities

| File | Responsibility |
| --- | --- |
| `src/main.tsx` | React entry point and stylesheet loading. |
| `src/App.tsx` | Editor shell, toolbar, slide rail, transition gaps, selection/manipulation, inspector, notes, clipboard/drop imports, and command dispatch. |
| `src/SlideView.tsx` | Interactive React rendering for slides/elements and thumbnails. Must visually agree with core's headless renderer. |
| `src/store.ts` | Zustand transient state, host-document synchronization, immutable mutation helper, selection, and zoom. |
| `src/vscode.ts` | Typed adapter around `acquireVsCodeApi`, version stamping, host listener, and browser fallback used during local development. |
| `src/styles.css` / `src/fixes.css` | Layout and editor appearance. Keep logical slide geometry in element data, not CSS-only state. |
| `vite.config.ts` | Builds the webview into the extension's `media` directory. |

## Important methods and flows

- `App()` composes the entire editor. A feature should usually be extracted
  from this file once it has independent state or tests; v0.1 remains compact.
- `SlideView(props)` renders one slide at a logical size and applies a visual
  scale. It sorts elements by `z`, resolves media through a supplied resolver,
  and generates visible-order page numbers.
- The main editor keeps `SlideView` and Moveable inside one logical-size
  `canvas-scale` wrapper. The wrapper alone is zoomed, so selection geometry,
  drag, resize, rotation, and morph inputs stay in logical slide units while
  controls remain visually consistent.
- `useDeckStore.mutate(mutator)` clones the current deck, applies the mutation,
  updates optimistic UI state, serializes through core, and posts one
  `replaceDocument` message. Do not mutate the existing store deck directly.
- `postMessage(message)` adds `PROTOCOL_VERSION`; `onHostMessage(handler)`
  filters mismatched host messages.

Media import sends base64 plus metadata to the host. The host chooses the safe,
content-addressed filename and responds with the stored reference. Never build
local filesystem paths in the webview.

## Interaction invariants

- Stored coordinates remain logical slide units regardless of zoom.
- Only the interactive canvas emits `element-<id>` DOM IDs. Thumbnails must not
  duplicate them, because selection and Moveable target lookup require a unique
  main-canvas element.
- A locked item cannot be manipulated from the canvas.
- Deleting an element also removes timeline steps that target it.
- Selecting another slide clears element selection.
- Clicking a transition gap changes the destination slide's incoming
  transition.
- Text editing is available by double-clicking a text element or using
  **Edit Markdown · LaTeX · Code…** in Properties. The editor includes a live
  rendered preview using the shared core Markdown renderer.
- Properties starts with the editable element `name`; immutable IDs remain the
  timeline reference. Missing names display as `<type>-<id prefix>`.
- Animation cards identify their target by element name, show click grouping,
  and follow timeline array order from top to bottom.
- Ctrl/Cmd plus mouse wheel and the bottom slider adjust canvas zoom. Speaker
  notes can collapse to a compact header without changing persisted notes.
- Checkbox fields use an explicit horizontal row so narrow inspectors do not
  separate the control from its label.
- All persistent changes go through `mutate`; selections, zoom, open tabs, and
  modal state stay transient.
- App-wide canvas paste handling ignores inputs, textareas, selects, and
  content-editable targets, so pasting inside the Markdown editor or inspector
  edits that field instead of creating a new slide element.

## Verification

Vite uses a relative asset base so bundled Codicon and KaTeX fonts resolve from
the VS Code webview origin instead of appearing as missing-glyph squares.

Run `pnpm --filter @slidepix/webview typecheck` and `pnpm build`, then test the
changed flow in an Extension Development Host. Visual changes also require a
render/export comparison because the core renderer is a second consumer.
