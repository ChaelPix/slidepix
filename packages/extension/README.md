# SlidePix

SlidePix opens `*.slidepix.json` files as visual presentations inside desktop
VS Code and Cursor.

## Start without writing code

1. Open the Command Palette with `Ctrl+Shift+P` on Windows/Linux or
   `Cmd+Shift+P` on macOS.
2. Run **SlidePix: Create Deck**.
3. The editor opens `untitled.slidepix.json` next to the selected Explorer
   item, or in the workspace folder.
4. Use the left rail for slides, the center canvas for editing, the top toolbar
   for content/export/presentation, and the right panel for properties, layers,
   and animations.

Text supports Markdown, inline/display LaTeX, and fenced code. Images and videos
can be chosen or dropped from the workspace Explorer and stay relatively linked
by default. Use **Embed all** to copy them into the sibling `.assets` folder.
Selected SlidePix elements can be copied between slides; clipboard images and
plain text can also be pasted. Properties provides system-font selection and
image border/crop controls. Undo and redo work from the toolbar or standard
VS Code/Cursor shortcuts.

PDF/PNG export asks once before downloading the optional Chromium renderer.
**PPTX** needs no renderer and creates native editable text, highlighted code,
OfficeMath equations, shapes, tables, pictures, and embedded video. It also maps
SlidePix transitions, Morph identity, and appear/fade/fly timeline steps to
PowerPoint motion. The `.pptx` is generated directly; LibreOffice is not an
export dependency. Browser-only details use the closest native PowerPoint
equivalent and are listed in the export report; content is never replaced with
slide or element screenshots. Fonts are referenced but not bundled.
**Web** creates an offline `index.html` folder with copied media and needs no
renderer download; the folder can be opened directly or hosted by a static web
server. System fonts are not bundled and may fall back on another computer.
Run **SlidePix: Configure MCP** to preview configuration for the bundled
read-only slide inspection and rendering tools.

For teams using Git, run **SlidePix: Configure Git Collaboration** with a deck
open. The explicitly confirmed, repository-local setup adds stable line endings
and an ID-aware deck merge driver. Independent slide/element changes and
concurrent additions merge automatically; true value, delete/edit, and order
conflicts can be resolved with **SlidePix: Resolve Git Conflict**. Removal is
available through **SlidePix: Remove Git Collaboration**.

If a deck opens as text, choose **Reopen Editor With… → SlidePix Editor**.

For full usage, troubleshooting, development, and architecture documentation,
open the project repository's root `README.md` and `architecture.md`.
