---
name: slidepix-mcp-review
description: Inspect or visually review one or more SlidePix deck slides with the read-only SlidePix MCP tools; use for slide feedback, layout checks, element inspection, notes checks, or contact-sheet rendering, not for editing a deck.
---

# Review SlidePix slides with MCP

Require an absolute path to a `*.slidepix.json` deck.

1. Call `list_slides` unless the requested slide IDs are already known.
2. Call `inspect_slides` when feedback depends on exact geometry, layers,
   transitions, timelines, or speaker notes.
3. Call `render_slides` for visual review. Render several requested slides into
   one grid/row/column image when comparison matters.
4. Refer to slides by title plus ID or 1-based index in the response.
5. Separate facts from structured inspection and visual judgments from the
   rendered image.

The tools are read-only. Do not say they edited, fixed, saved, or exported a
deck. If Chromium is missing, ask the user to run **SlidePix: Configure MCP** or
**SlidePix: Install Export Renderer** in VS Code/Cursor, then retry.

For server implementation details, read
[docs/modules/mcp.md](../../../docs/modules/mcp.md).

