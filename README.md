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
3. Choose a folder and a name. Keep the automatically added
   `.slidepix.json` ending.
4. The visual editor opens automatically.

The screen is organized like a simple slide application:

- **left:** slides, previews, duplicate/reorder/hide/delete buttons, and the
  transition control between slides;
- **center:** the current slide; click an item to move, resize, or rotate it;
- **top:** add text, images, videos, shapes, and editable tables; save, export,
  or present;
- **right:** item properties, layer order, visibility/locking, and animations;
- **bottom:** speaker notes and zoom.

## Everyday actions

- Add text with **Text**, then double-click the text box to write Markdown,
  LaTeX such as `$x^2$`, or fenced code.
- Add media with **Image** or **Video**, or drag a workspace file from the
  Explorer. Workspace media stays linked by a relative path by default; use
  **Embed in .assets** or **Embed all** when the deck must be portable.
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
- Use **Export PDF**, **Export PNG**, or **Export Web**. PDF/PNG asks you to
  approve a one-time Chromium renderer download; Web export needs no download.
  It creates a portable folder with `index.html` and copied media that works
  offline in a modern browser.

Save the deck normally with `Ctrl+S` or `Cmd+S`. Undo with `Ctrl+Z`/`Cmd+Z` and
redo with `Ctrl+Y` or `Cmd+Shift+Z`; matching toolbar buttons are also present.
VS Code/Cursor owns that history, autosave, backup, and recovery because the
deck is a text document.

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
- If an image or video is missing, confirm the matching `.assets` folder was
  copied with the deck.
- If export fails before producing a file, run
  **SlidePix: Install Export Renderer** from the Command Palette and retry.
- Browser video support depends on the operating system codec. MP4/H.264 and
  WebM are the safest choices.

## AI review with MCP

Run **SlidePix: Configure MCP** from the Command Palette. SlidePix installs the
renderer with consent and produces previewable host configuration for its
read-only tools. Those tools list, inspect, and render slides; they never modify
the deck.

Repository-native agent guidance is not kept in a loose MCP tutorial:

- Cursor loads [.cursor/rules/slidepix-mcp.mdc](.cursor/rules/slidepix-mcp.mdc).
- Codex discovers the
  [.agents/skills/slidepix-mcp-review/SKILL.md](.agents/skills/slidepix-mcp-review/SKILL.md)
  skill.

## Developers and coding agents

Start with [architecture.md](architecture.md). It is the canonical map of
modules, methods, scripts, runtime flows, invariants, tests, and known gaps.
Repository-wide agent instructions live in [AGENTS.md](AGENTS.md).

The canonical [product-demo and visual-regression example](examples/slidepix-demo.slidepix.json)
demonstrates Markdown, LaTeX, highlighted code, image borders/radius/crop/fade,
video, shapes, animations, ordinary transitions, and a two-slide crop morph. Its
embedded demo reel is assembled from exact-size slide PNG exports with FFmpeg;
the reproducible asset flow is documented in [examples/README.md](examples/README.md).
