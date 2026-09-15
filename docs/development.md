# Development and release guide

This guide is for people modifying SlidePix. People who only want to use the
extension should follow the root [README](../README.md).

## Prerequisites

- Node.js 20 or newer
- pnpm 10.29.3 (the repository pins this version in `package.json`)
- desktop VS Code for the Extension Development Host

From the repository root:

```sh
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm docs:check
```

Extension and MCP Vitest configurations alias `@slidepix/core` directly to its
source. Tests therefore work in a fresh checkout before `packages/core/dist`
exists; do not remove those aliases or make `pnpm test` depend on stale build
output.

No browser is downloaded by `pnpm install` or embedded in the VSIX. PDF, PNG,
MCP rendering, and the smoke script need a Chromium binary installed through
**SlidePix: Install Export Renderer** or Playwright with
`PLAYWRIGHT_BROWSERS_PATH` pointing to that installation.

## Debug the extension

1. Run `pnpm build`.
2. Open the repository root in VS Code.
3. Press `F5` and choose **VS Code Extension Development** if prompted.
4. In the new Extension Development Host, run **SlidePix: Create Deck**.
5. After source changes, run `pnpm build` again and reload the development host.

`pnpm dev` watches the webview and extension bundles, but the Extension
Development Host may still require **Developer: Reload Window** to load a new
extension bundle.

## Verification by change type

| Change | Minimum verification |
| --- | --- |
| Documentation only | `pnpm docs:check` |
| Schema/assets/protocol | `pnpm test`, `pnpm typecheck`, `pnpm build` |
| Webview behavior | `pnpm typecheck`, `pnpm build`, manual Extension Development Host test |
| Rendering/motion | previous checks plus `node scripts/render-smoke.mjs`; inspect the contact sheet, PDF, and `slides/` exact-size PNG frames |
| Presentation/export | previous checks plus audience/presenter and PDF/PNG/Web manual smoke tests |
| MCP | `pnpm test`, `pnpm typecheck`, build, start bundled stdio server, and render one/many slides |
| Release | all checks on the target OS, then `pnpm package` and install the produced VSIX |

## Package a VSIX

Run:

```sh
pnpm package
```

The artifact is written to `packages/extension/slidepix-<version>.vsix`. Install
that file with **Extensions → … → Install from VSIX…** in both VS Code and
Cursor before publishing it.

## Generated-output discipline

Never patch `dist`, `media`, vendored Playwright, or the generated JSON Schema.
Change their sources and rebuild. The complete generated-file table and all
script responsibilities are in [architecture.md](../architecture.md).
