---
name: slidepix-mcp-review
description: Inspect or review one or more SlidePix deck slides with the read-only SlidePix MCP tools; use for slide feedback, layout checks, element inspection, or notes checks, not for editing a deck.
---

# Review SlidePix slides with MCP

Require an absolute path to a `*.slidepix.json` deck.

1. Call `list_slides` unless the requested slide IDs are already known.
2. Call `inspect_slides` when feedback depends on exact geometry, layers,
   transitions, timelines, or speaker notes.
3. Refer to slides by title plus ID or 1-based index in the response.
4. Separate facts from structured inspection.

The tools are read-only. Do not say they edited, fixed, saved, or exported a
deck.

For server implementation details, read
[docs/modules/mcp.md](../../../docs/modules/mcp.md).

