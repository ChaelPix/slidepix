import { describe, expect, it } from "vitest";
import { mcpTargets, mergeMcpTarget, slidepixMcpProcess } from "./mcp-config";

const server = slidepixMcpProcess("/usr/bin/cursor", "/ext/dist/mcp.cjs");

describe("mcp targets", () => {
  it("registers Cursor, VS Code, Codex, Claude Code, and Claude Desktop", () => {
    const ids = mcpTargets("/home/pix", "/home/pix/.config/Cursor/User", "linux").map((target) => [target.id, target.filePath]);
    expect(ids).toEqual([
      ["cursor", "/home/pix/.cursor/mcp.json"],
      ["vscode", "/home/pix/.config/Cursor/User/mcp.json"],
      ["codex", "/home/pix/.codex/config.toml"],
      ["claude-code", "/home/pix/.claude.json"],
      ["claude-desktop", "/home/pix/.config/Claude/claude_desktop_config.json"]
    ]);
  });
});

describe("mergeMcpTarget", () => {
  it("keeps other Cursor servers", () => {
    const target = mcpTargets("/home/pix", "/unused", "linux").find((item) => item.id === "cursor")!;
    const merged = JSON.parse(mergeMcpTarget(JSON.stringify({ mcpServers: { other: { command: "other" } } }), target, server));
    expect(merged.mcpServers.other).toEqual({ command: "other" });
    expect(merged.mcpServers.slidepix.args).toEqual(["/ext/dist/mcp.cjs"]);
  });

  it("creates a VS Code stdio server", () => {
    const target = mcpTargets("/home/pix", "/home/pix/.config/Code/User", "linux").find((item) => item.id === "vscode")!;
    const merged = JSON.parse(mergeMcpTarget(undefined, target, server));
    expect(merged.servers.slidepix).toMatchObject({ type: "stdio", args: ["/ext/dist/mcp.cjs"] });
  });

  it("keeps Claude Code settings outside mcpServers", () => {
    const target = mcpTargets("/home/pix", "/unused", "linux").find((item) => item.id === "claude-code")!;
    const merged = JSON.parse(mergeMcpTarget(JSON.stringify({ theme: "dark", mcpServers: { other: { command: "other" } } }), target, server));
    expect(merged.theme).toBe("dark");
    expect(merged.mcpServers.slidepix.command).toBe("/usr/bin/cursor");
  });

  it("replaces only the Codex slidepix tables", () => {
    const target = mcpTargets("/home/pix", "/unused", "linux").find((item) => item.id === "codex")!;
    const existing = [
      "[mcp_servers.node_repl]",
      "command = \"node\"",
      "",
      "[mcp_servers.slidepix]",
      "command = \"old\"",
      "",
      "[mcp_servers.slidepix.env]",
      "ELECTRON_RUN_AS_NODE = \"0\"",
      "",
      "[features]",
      "js_repl = false",
      ""
    ].join("\n");
    const merged = mergeMcpTarget(existing, target, server);
    expect(merged).toContain("[mcp_servers.node_repl]");
    expect(merged).toContain("js_repl = false");
    expect(merged).not.toContain("command = \"old\"");
    expect(merged).toContain("command = \"/usr/bin/cursor\"");
    expect(merged.split("[mcp_servers.slidepix.env]")[1]).toBe("\nELECTRON_RUN_AS_NODE = \"1\"\n");
  });

  it("refuses a malformed server map", () => {
    const target = mcpTargets("/home/pix", "/unused", "linux").find((item) => item.id === "cursor")!;
    expect(() => mergeMcpTarget('{"mcpServers":[]}', target, server)).toThrow(/mcpServers/);
  });
});
