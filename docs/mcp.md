# SlidePix MCP

The bundled MCP server is read-only. It provides `list_slides`, `inspect_slides`,
and `render_slides`; none of these tools writes to a deck.

Run **SlidePix: Configure MCP** in VS Code or Cursor. After the renderer is
installed, SlidePix produces configuration snippets for both `.vscode/mcp.json`
and `.cursor/mcp.json`. You can copy or preview the snippets; SlidePix does not
change agent configuration automatically.

`render_slides` accepts slide IDs or 1-based indices and returns one PNG image in
grid, row, or column layout.
