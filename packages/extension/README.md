# SlidePix

SlidePix opens `*.slidepix.json` files as visual presentations inside desktop
VS Code and Cursor.

## Start without writing code

1. Open the Command Palette with `Ctrl+Shift+P` on Windows/Linux or
   `Cmd+Shift+P` on macOS.
2. Run **SlidePix: Create Deck**.
3. Choose a filename and folder.
4. Use the left rail for slides, the center canvas for editing, the top toolbar
   for content/export/presentation, and the right panel for properties, layers,
   and animations.

Text supports Markdown, inline/display LaTeX, and fenced code. Images and videos
can be chosen or dropped; clipboard images and plain text can be pasted.
Imported media is copied into a sibling `.assets` folder, so copy that folder
with the JSON deck when moving computers.

PDF/PNG export asks once before downloading the optional Chromium renderer.
Run **SlidePix: Configure MCP** to preview configuration for the bundled
read-only slide inspection and rendering tools.

If a deck opens as text, choose **Reopen Editor With… → SlidePix Editor**.

For full usage, troubleshooting, development, and architecture documentation,
open the project repository's root `README.md` and `architecture.md`.
