import * as path from "node:path";

export type McpProcess = {
  command: string;
  args: string[];
  env: { ELECTRON_RUN_AS_NODE: "1"; PLAYWRIGHT_BROWSERS_PATH: string };
};

export type McpTarget = {
  id: "cursor" | "vscode" | "codex" | "claude-code" | "claude-desktop";
  filePath: string;
  format: "mcpServers" | "vscode" | "codex";
};

export function slidepixMcpProcess(command: string, serverPath: string, browsersPath: string): McpProcess {
  return {
    command,
    args: [serverPath],
    env: { ELECTRON_RUN_AS_NODE: "1", PLAYWRIGHT_BROWSERS_PATH: browsersPath }
  };
}

export function mcpTargets(home: string, userDirectory: string, platform: NodeJS.Platform): McpTarget[] {
  return [
    { id: "cursor", filePath: path.join(home, ".cursor", "mcp.json"), format: "mcpServers" },
    { id: "vscode", filePath: path.join(userDirectory, "mcp.json"), format: "vscode" },
    { id: "codex", filePath: path.join(home, ".codex", "config.toml"), format: "codex" },
    { id: "claude-code", filePath: path.join(home, ".claude.json"), format: "mcpServers" },
    { id: "claude-desktop", filePath: claudeDesktopConfig(home, platform), format: "mcpServers" }
  ];
}

export function mergeMcpTarget(existing: string | undefined, target: McpTarget, server: McpProcess): string {
  if (target.format === "codex") return mergeCodexConfig(existing, server);
  return mergeJsonMcp(existing, target.format, server);
}

function claudeDesktopConfig(home: string, platform: NodeJS.Platform): string {
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (platform === "win32") return path.join(home, "AppData", "Roaming", "Claude", "claude_desktop_config.json");
  return path.join(home, ".config", "Claude", "claude_desktop_config.json");
}

function mergeJsonMcp(existing: string | undefined, format: "mcpServers" | "vscode", server: McpProcess): string {
  const parsed = existing?.trim() ? JSON.parse(existing) as unknown : {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("MCP configuration must be a JSON object.");
  const root = parsed as Record<string, unknown>;
  if (format === "mcpServers") {
    const servers = objectField(root, "mcpServers");
    servers.slidepix = server;
    root.mcpServers = servers;
  } else {
    const servers = objectField(root, "servers");
    servers.slidepix = { type: "stdio", ...server };
    root.servers = servers;
  }
  return `${JSON.stringify(root, null, 2)}\n`;
}

function mergeCodexConfig(existing: string | undefined, server: McpProcess): string {
  const kept = stripTomlSections(existing ?? "", ["mcp_servers.slidepix", "mcp_servers.slidepix.env"]).trimEnd();
  const args = server.args.map(tomlString).join(", ");
  const block = [
    "[mcp_servers.slidepix]",
    `command = ${tomlString(server.command)}`,
    `args = [${args}]`,
    "",
    "[mcp_servers.slidepix.env]",
    `ELECTRON_RUN_AS_NODE = ${tomlString(server.env.ELECTRON_RUN_AS_NODE)}`,
    `PLAYWRIGHT_BROWSERS_PATH = ${tomlString(server.env.PLAYWRIGHT_BROWSERS_PATH)}`
  ].join("\n");
  return `${kept}${kept ? "\n\n" : ""}${block}\n`;
}

function stripTomlSections(text: string, names: string[]): string {
  const headers = new Set(names);
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const header = /^\[([^\]]+)\]\s*$/.exec(line)?.[1];
    if (header) skipping = headers.has(header);
    if (!skipping) kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n");
}

function tomlString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

function objectField(root: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = root[key];
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`MCP configuration field "${key}" must be an object.`);
  return { ...value };
}
