# SlidePix

SlidePix is a Git-friendly presentation editor for VS Code and Cursor. Open a
`*.slidepix.json` file to edit slides visually, present them, or export them.

## Development

```sh
pnpm install
pnpm build
pnpm test
```

Press `F5` in VS Code after building to launch the Extension Development Host.
Run **SlidePix: Create Deck**, choose a `*.slidepix.json` file, and the custom
editor opens automatically.

## Workspace packages

- `@slidepix/core`: schema, validation, renderer, and shared protocol
- `@slidepix/webview`: React custom-editor interface
- `@slidepix/extension`: VS Code/Cursor extension host
- `@slidepix/mcp`: read-only MCP server for inspecting and rendering decks

See [docs/format.md](docs/format.md) for the deck format and [docs/mcp.md](docs/mcp.md)
for AI-agent configuration.
