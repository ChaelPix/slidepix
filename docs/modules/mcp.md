# MCP module

Package: `@slidepix/mcp`

Purpose: expose read-only deck inspection over MCP stdio. The extension's **AI**
action writes this server into the Cursor, VS Code, Codex, Claude Code, and
Claude Desktop user configs. Agents only see the tools after a new chat. This
document is an implementation reference, not host setup instructions. Agent
usage guidance lives in Cursor rules and the Codex skill linked below.

## `src/server.ts`

`buildServer()` is private and registers two tools before `serveStdio` starts
the process:

| Tool | Output |
| --- | --- |
| `list_slides(deckPath)` | Deck title/dimensions and every slide's ID, 1-based index, title, hidden state, and notes availability. |
| `inspect_slides(deckPath, slideIds?, indices?)` | Structured slide, transition, timeline, and complete subtype-specific element metadata, including media storage/crop/playback fields. |

Tool inputs use Zod. The server instructions tell agents to list slides before
inspection when identifiers are unknown.

## `src/tools.ts`

| Export | Contract |
| --- | --- |
| `loadDeck(deckPath)` | Reads UTF-8 text and validates it through core. It never writes. |
| `selectSlides(deck, slideIds?, indices?)` | Selects IDs in deck order, maps 1-based indices in requested order, or defaults to all visible slides. Unknown IDs/indices throw clear errors. |

Private helpers must continue to call core's `resolveMediaPath` with the
element's explicit storage mode when they read media. Linked references are
restricted to the MCP process workspace/deck roots; embedded references stay
inside `.assets`. The server does not launch a browser or write files.

## Native agent guidance

- Cursor: [`.cursor/rules/slidepix-mcp.mdc`](../../.cursor/rules/slidepix-mcp.mdc)
- Codex: [`.agents/skills/slidepix-mcp-review/SKILL.md`](../../.agents/skills/slidepix-mcp-review/SKILL.md)

Do not replace these with a generic Markdown setup guide: native rule/skill
discovery is part of the intended agent workflow.

## Tests and security boundary

`src/tools.test.ts` covers selection ordering, out-of-range errors, and the
read-only tool layer. Add tests for every selector change. No MCP code may write,
rename, create, or delete deck or asset files in v0.1.
