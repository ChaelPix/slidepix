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
| `src/align.ts` | Page/selection alignment and equal-gap distribution of element boxes. |
| `src/snap.ts` | Logical-space edge/center snapping against the page and peer boxes. |
| `src/store.ts` | Zustand state, single-flight revisioned persistence, semantic external-edit rebasing, immutable mutation helpers, selection, and zoom. |
| `src/vscode.ts` | Typed adapter around `acquireVsCodeApi`, version stamping, host listener, and browser fallback used during local development. |
| `src/toasts.ts` | App-wide transient notification events and stack update helpers. |
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
- `useDeckStore.preview(mutator)` clones and updates local UI state without a
  document write. Pointer drags use it for smooth feedback.
- `useDeckStore.commit()` persists the current preview once. A pointer drag
  must commit on release/cancel rather than posting a `WorkspaceEdit` per pixel.
- `useDeckStore.mutate(mutator)` performs a one-step preview and persistence for
  ordinary discrete edits. Do not mutate the existing store deck directly.
- Only one replacement may be in flight. Later mutations remain optimistic and
  coalesce behind it. Continuous text, numeric, color, notes, and keyboard
  nudging preview locally, debounce for 600 ms, and flush on blur or Done.
- A new host revision rebases pending local work through core `mergeDecks`.
  Clean merges retry automatically; structured conflicts stop persistence and
  require an explicit base/ours/theirs choice. Save/undo/redo wait for the
  pending edit queue to settle.
- `postMessage(message)` adds `PROTOCOL_VERSION`; `onHostMessage(handler)`
  filters mismatched host messages.

Clipboard/browser file import sends base64 plus metadata to the host. Explorer
drop and file selection send a file URI to the host, which returns a safe
workspace-relative linked reference or embeds an outside-workspace file. The
webview never resolves or reads a local filesystem path itself. `SlideView`
always calls its resolver with both `src` and `storage`, including thumbnails.

## Interaction invariants

- Stored coordinates remain logical slide units regardless of zoom.
- Pointer deltas are divided by canvas zoom and inverse-rotated into element
  coordinates before changing radius, fade, crop pan, or crop zoom.
- Only the interactive canvas emits `element-<id>` DOM IDs. Thumbnails must not
  duplicate them, because selection and Moveable target lookup require a unique
  main-canvas element.
- A locked item cannot be manipulated from the canvas.
- Deleting an element also removes timeline steps that target it.
- Selecting another slide clears element selection.
- Clicking a transition gap opens a visual editor for the destination slide's
  incoming transition and duration.
- Selecting an image exposes canvas handles for radius and four-sided edge
  fade. The fade uses the same geometry-derived rounded SVG mask in editor and
  export, so it follows the configured corner radius. Double-clicking, or
  **Crop edges**, cuts the picture by dragging an edge or corner. Scroll
  zooms that crop while keeping its ratio. **Done** or Escape leaves the mode.
  Videos expose only the shared radius handle.
- Workspace media is linked by default. Properties embeds one selected item;
  **Embed all** embeds every linked image/video in the deck.
- Copy/cut writes a typed SlidePix clipboard payload plus a private marker.
  Paste checks it before plain text, assigns new element IDs, and preserves
  morph keys only when copying to a different slide in the same deck.
- Double-clicking a text element, pressing `Enter`/`F2`, or inserting a new
  text box opens an in-place Markdown textarea at the element's logical
  geometry. A small **editing...** badge marks inline Markdown editing versus
  the rendered slide. Moveable forwards its intercepted double-click before
  pausing while editing is active. `Escape` and `Ctrl/Cmd+Enter` finish; the
  optional **Advanced editor** retains the larger source and live shared-renderer
  preview for LaTeX and code. Tab inserts a tab stop in the inline editor,
  advanced editor, and table cells; Shift+Tab removes one. Rendered text keeps
  those stops. Text properties include **Vertical spacing**, which sets
  `lineHeight`.
- The stable second toolbar row is contextual. Text and table selections expose
  compact typography plus icon-button horizontal/vertical alignment. During
  inline text editing, Bold, Italic, and list actions transform the active
  Markdown selection without losing its caret. Element arrange, lock,
  duplicate, and delete actions remain available in the same row.
- Font family uses a portable select plus a host-native **System fonts…** quick
  picker. The extension scans platform font directories and returns the chosen
  CSS family through a typed request/response message, avoiding the unreliable
  Local Font Access API inside VS Code/Cursor webviews.
- The Insert ribbon's Shape control uses the same themed dropdown as Export.
  The Insert ribbon adds a 3×3 table. Properties provides direct cell editing,
  add/remove row and column actions, a header toggle, typography, and
  transparent header/cell/border colors. Limits match the core schema.
- Shape Properties provides explicit transparent fill/border toggles and an
  optional silhouette-aware shadow with color, offsets, and blur. Image borders
  use the same transparent toggle.
- Toolbar Undo/Redo and Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, or Ctrl+Y flush previews,
  then enter one request-ID-based queue. The host keeps a snapshot stack of
  committed decks and restores the previous or next snapshot through
  `WorkspaceEdit`, so delete/add/move undo works while the webview has focus.
  The host reports `canUndo`/`canRedo` on deck and history acknowledgements.
- The export ribbon orders PNG, PDF, PPTX, then Web. PPTX delegates destination
  selection and native OOXML generation to the extension host and never reads
  local media from the webview.
- Properties starts with the editable element `name`; immutable IDs remain the
  timeline reference. Missing names display as `<type>-<id prefix>`.
- Animation cards identify their target by element name, show click grouping,
  and follow timeline array order from top to bottom.
- Ctrl/Cmd plus mouse wheel and the docked zoom-in/zoom-out controls on the
  right of the context toolbar adjust canvas zoom. Speaker notes can collapse
  to a compact header without changing persisted notes. The slide rail and
  inspector collapse independently from chevrons on their inner edges; both
  collapsed states stay transient. Hold a slide thumbnail and drag it up or
  down to reorder; the deck updates once on release.
- Checkbox fields use an explicit horizontal row so narrow inspectors do not
  separate the control from its label.
- Numeric Properties fields use large decrement/increment targets, select their
  value on focus, support focused-wheel adjustment, and use Shift for ×10 or
  Alt for ×0.1 nudges. Range properties use a visible card and slider.
- All persistent changes go through `mutate` or the `preview`/`commit` queue;
  selections, zoom, open tabs, panel collapse, and modal state stay transient.
- Drag and resize snap only while Shift is held, in logical slide units, to
  visible peer left/center/right and top/middle/bottom edges and to the slide
  edges and center. Resize snaps only the dragged edges, and stays on a guide
  until the pointer pulls away. The catch radius is 24 CSS pixels, divided by
  canvas zoom. Guidelines are overlay lines on the canvas frame (no distance
  digits). Shift-click adds items to the selection. The
  contextual toolbar aligns left/center/right and top/middle/bottom to the
  page or the selection, centers on the page, and distributes three or more
  unlocked items by centers or equal gaps. Dragging one selected item moves
  the whole unlocked selection.
- Image and video Properties include **Keep original aspect ratio**, on by
  default for newly inserted media. Turning it on measures the source ratio
  and fits the box inside the slide. Later width edits, including a width
  written into the deck, keep that ratio. Page numbers stay on every slide.
  Text renders past its box; the slide still clips at the page edge.
- Slide Properties exposes the same incoming transition controls as the rail
  and can choose, replace, or remove a storage-aware background image.
- Blocking browser alerts are not used. Success toasts auto-dismiss after 2.5
  seconds, errors remain dismissible, and host-owned exports update a progress
  toast through the versioned protocol.
- App-wide canvas paste handling ignores inputs, textareas, selects, and
  content-editable targets, so pasting inside the Markdown editor or inspector
  edits that field instead of creating a new slide element.

## Verification

Vite uses a relative asset base so bundled Codicon and KaTeX fonts resolve from
the VS Code webview origin instead of appearing as missing-glyph squares.

Run `pnpm --filter @slidepix/webview typecheck` and `pnpm build`, then test the
changed flow in an Extension Development Host. Visual changes also require a
render/export comparison because the core renderer is a second consumer.
`src/store.test.ts` covers write serialization, debounce, rebasing, conflicts,
failed edits, deferred document commands, and host undo availability. `src/align.test.ts` covers page
and selection alignment plus distribution. `src/snap.test.ts` covers edge
snapping and the zoom-aware catch radius.
