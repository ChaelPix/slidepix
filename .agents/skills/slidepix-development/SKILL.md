---
name: slidepix-development
description: Diagnose, extend, test, review, or document the SlidePix VS Code/Cursor presentation extension, including its deck schema, React webview, rendering, presentation, export, assets, or MCP server.
---

# Develop SlidePix

1. Read [architecture.md](../../../architecture.md).
2. Use its Fast routing table to identify the owner package.
3. Read only the corresponding file in
   [docs/modules](../../../docs/modules), plus source named there.
4. State which invariant the change touches before editing when it affects the
   schema, protocol, persistence, assets, security, rendering, or MCP.
5. Change the owning source module; do not patch generated output.
6. Add or update the closest test.
7. Run the validation level in
   [docs/development.md](../../../docs/development.md).
8. Update architecture/module docs if responsibilities, public methods,
   scripts, commands, persisted fields, or known gaps changed.

Keep normal editor persistence inside VS Code `WorkspaceEdit`, asset paths under
the deck's sibling asset directory, webview resources under CSP, presentation
servers on authenticated loopback, rendering semantics in `@slidepix/core`, and
MCP tools read-only.

