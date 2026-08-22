# SlidePix repository instructions

- Read `architecture.md` before changing code. Use its fast-routing table, then
  load only the relevant document under `docs/modules/`.
- Treat `packages/core/src/schema.ts` and `packages/core/src/render.ts` as the
  authoritative data and headless rendering definitions.
- Preserve the invariants listed in `architecture.md`, especially text-document
  persistence, asset path containment, CSP, tokenized loopback access, shared
  rendering, and read-only MCP behavior.
- Do not hand-edit generated `dist`, `media`, `vendor`, JSON Schema, or VSIX
  artifacts.
- Update the relevant architecture/module documentation when methods, ownership,
  commands, scripts, persisted fields, or known gaps change.
- Run `pnpm docs:check` for documentation changes. For code changes, run the
  closest tests plus `pnpm typecheck` and `pnpm build`; visually verify rendering
  changes.
- Codex workflows are available as repository skills under `.agents/skills/`.

## Code review rules

- Flag any new normal editor write that bypasses `WorkspaceEdit`.
- Flag asset reads that bypass `resolveAssetPath` or network listeners that are
  not loopback-only and token-authenticated.
- Flag independent render logic that can drift between editor, presentation,
  export, and MCP without a documented reason and matching tests.
- Flag any MCP operation that can mutate a deck or asset in the v0.1 surface.

