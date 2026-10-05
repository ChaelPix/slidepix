# SlidePix

SlidePix is a visual presentation editor that runs inside desktop VS Code and
Cursor on Windows, macOS, and Linux. A presentation is stored as a readable
`*.slidepix.json` file plus a sibling folder for pictures and videos.

You do not need to know how to program to install or use the extension.

## Install SlidePix without a terminal

You need:

- desktop [VS Code](https://code.visualstudio.com/) or
  [Cursor](https://www.cursor.com/);
- the `slidepix-0.1.0.vsix` installation file from the project release or from
  the person who built SlidePix.

Then:

1. Open VS Code or Cursor.
2. Click the **Extensions** icon in the left sidebar. It looks like four small
   squares.
3. Click the **…** menu at the top of the Extensions panel.
4. Choose **Install from VSIX…**.
5. Select `slidepix-0.1.0.vsix` and approve the installation.
6. Click **Reload Window** if the editor asks you to reload.

The same VSIX works on Windows, macOS, and Linux. The extension itself is small;
the optional PDF/PNG renderer is downloaded separately the first time you need
it.

## Create your first presentation

1. Open the Command Palette:
   - Windows/Linux: `Ctrl+Shift+P`
   - macOS: `Cmd+Shift+P`
2. Type **SlidePix: Create Deck** and press Enter.
3. SlidePix creates `untitled.slidepix.json` next to the file selected in
   Explorer, or in the workspace folder. If that name is taken, it uses
   `untitled-2.slidepix.json`, and so on.
4. The visual editor opens automatically. Move the file in Explorer if you
   want it somewhere else.

The screen is organized like a simple slide application:

- **left:** slides, previews, duplicate/reorder/hide/delete buttons, and the
  transition control between slides;
- **center:** the current slide; click an item to move, resize, or rotate it;
- **top:** add text, images, videos, shapes, and editable tables; use the
  contextual second row to format or arrange the current item; save, export,
  or present;
- **right:** item properties, layer order, visibility/locking, and animations;
- **bottom:** speaker notes and zoom.

## Everyday actions

- Add text with **Text** and type immediately. Double-click an existing text
  box (or select it and press `Enter`/`F2`) to edit Markdown directly on the
  slide. An **editing...** label appears on the box so you can tell quick edit
  apart from the rendered slide. Use the contextual Bold, Italic, list,
  alignment, font, size, and color controls; **Advanced editor** opens the
  larger source-and-preview view for LaTeX such as `$x^2$` and fenced code.
  Press `Escape` or `Ctrl/Cmd+Enter` to finish.
- Add media with **Image** or **Video**, or drag a workspace file from the
  Explorer. Workspace media stays linked by a relative path by default; use
  **Embed in .assets** or **Embed all** when the deck must be portable.
- Shift-click a second item (on the slide or in **Layers**) to multi-select.
  The contextual **Align** controls snap items to the page or to the selection
  (left/center/right, top/middle/bottom, or center on page). With three or more
  unlocked items, distribute centers or equal gaps. Dragging one selected item
  moves the whole unlocked selection. While dragging, snap lines appear against
  other text, shapes, media, and the slide edges—no distance numbers.
- Copy and paste selected SlidePix elements between slides. Cross-slide copies
  preserve their morph identity; plain text and clipboard images still create
  new elements.
- Pick a text font from the system-font selector in **Properties**; SlidePix
  defaults to the operating system's UI font instead of requiring a CSS name.
- Select an image to set border width/color, corner radius, and edge fade.
  Double-click it to enter crop mode, then drag to pan and use the visible
  zoom/reset/done controls.
- Change a slide transition by clicking the labelled gap between two slide
  previews. The transition belongs to the destination slide.
- Add entrance animations from the **animations** tab after selecting an item.
- Use **Present** for one audience screen. Use **Presenter** for the audience
  window plus current/next slides, notes, and a timer in the editor.
- Use **Export PDF**, **Export PNG**, **Export PPTX**, or **Export Web**.
  PDF/PNG asks you to approve a one-time Chromium renderer download; PPTX and
  Web need no download. PPTX creates native editable text, code, equations,
  shapes, tables, pictures, and video, plus PowerPoint transitions and common
  animations. SlidePix writes `.pptx` directly; LibreOffice is not required.
  PowerPoint and browser layout differ, so the export reports approximations
  such as soft-edge image fading, media playback options, and missing fonts.
  It never replaces text or shapes with screenshots. **Web** creates a portable
  folder with `index.html` and copied media that works offline in a modern browser.

Save the deck normally with `Ctrl+S` or `Cmd+S`. Undo with `Ctrl+Z`/`Cmd+Z` and
redo with `Ctrl+Y` or `Cmd+Shift+Z`; matching toolbar buttons use the same
history even while a SlidePix text field is active. Continuous typing, nudging,
and dragging are grouped into useful undo steps. VS Code/Cursor owns that
history, autosave, backup, and recovery because the deck is a text document.

## Work on a deck with Git

Run **SlidePix: Configure Git Collaboration** while the deck is open. After a
confirmation preview, SlidePix adds a managed rule to the repository's
`.gitattributes` and configures a repository-local semantic merge driver. It
does not change global Git settings.

The driver understands stable slide, element, and animation IDs. It combines
changes to different slides or properties and preserves concurrent additions.
It stops for genuine ambiguity: both people changing the same value,
delete-versus-edit, or incompatible slide/element/timeline reorders. For best
results, let one person own deck-wide theme/layout changes and major slide
ordering while other contributors work on separate slides.

When a conflict remains, open the deck and choose **Resolve with SlidePix**, or
run **SlidePix: Resolve Git Conflict**. SlidePix offers base/ours/theirs choices
for each semantic conflict, validates the result, and writes it through the
normal editor history. It stages the file only if you explicitly choose
**Stage resolved file**. **SlidePix: Remove Git Collaboration** removes only the
managed attributes block and matching repository-local configuration.

## Put a presentation on a web server or Raspberry Pi

Click **Web** beside **PDF**, choose a new folder name such as `my-talk-web`,
and copy that complete folder to the target computer. Open `index.html`
directly in Chromium, or point any static server such as nginx at the folder.
Click or use the arrow keys, Space, and Page Up/Page Down to present; press `F`
for fullscreen. Animations, transitions, images, video, and linked workspace
media are included without needing SlidePix, Node.js, or an internet
connection.

Only visible audience content is exported: hidden slides, speaker notes, and
the source deck are omitted. Fonts are not bundled, so a system font selected
on the authoring computer may fall back to an available Raspberry Pi font.

## Move a presentation to another computer

Copy both items together:

```text
my-talk.slidepix.json
my-talk.assets/
```

The asset folder is created only after media is imported. Do not rename it
independently; its name must match the deck.

## If something does not open

- If a deck opens as raw JSON, right-click its editor tab, choose
  **Reopen Editor With…**, then **SlidePix Editor**.
- If SlidePix reports invalid JSON, use **Reopen Editor With… → Text Editor**,
  fix the highlighted error, and save. SlidePix does not overwrite the invalid
  source while you repair it.
- If Git conflict markers are present, choose **Resolve with SlidePix** in the
  error screen. If Git does not provide all three merge stages, open the text
  editor and resolve the markers manually.
- If an image or video is missing, confirm the matching `.assets` folder was
  copied with the deck.
- Browser video support depends on the operating system codec. MP4/H.264 and
  WebM are the safest choices. A PDF shows the first video frame with a play
  control; it does not contain a playable video.

## AI review with MCP

The **AI** button and **SlidePix: Configure MCP** install the read-only MCP
server for Cursor, VS Code, Codex, Claude Code, and Claude Desktop. Each app
keeps its own config: `~/.cursor/mcp.json`, the VS Code profile `mcp.json`,
`~/.codex/config.toml`, `~/.claude.json`, and the Claude Desktop config.
Existing servers in those files stay. A file that is not valid is left unchanged.

After adding it, start a new chat in the app you want to use. That chat can call `list_slides`
and `inspect_slides` with an absolute deck path. Those tools
never modify the deck. Enable **slidepix** in MCP settings if the editor asks.
The chat that was already open will not see a server added after it started.

Repository-native agent guidance is not kept in a loose MCP tutorial:

- Cursor loads [.cursor/rules/slidepix-mcp.mdc](.cursor/rules/slidepix-mcp.mdc).
- Codex discovers the
  [.agents/skills/slidepix-mcp-review/SKILL.md](.agents/skills/slidepix-mcp-review/SKILL.md)
  skill.

## Developers and coding agents

To install Node.js, pnpm, compile the extension, and install the VSIX on
Ubuntu or macOS (zsh), follow [docs/install.md](docs/install.md).

Start with [architecture.md](architecture.md). It is the canonical map of
modules, methods, scripts, runtime flows, invariants, tests, and known gaps.
Repository-wide agent instructions live in [AGENTS.md](AGENTS.md).

The canonical [product-demo and visual-regression example](examples/slidepix-demo.slidepix.json)
demonstrates Markdown, LaTeX, highlighted code, image borders/radius/crop/fade,
video, shapes, animations, ordinary transitions, and a two-slide crop morph. Its
embedded demo reel is assembled from exact-size slide PNG exports with FFmpeg;
the reproducible asset flow is documented in [examples/README.md](examples/README.md).
