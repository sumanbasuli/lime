export type McpClient = "codex" | "claude-code" | "opencode" | "opencode-legacy";

export const MCP_CLIENT_OPTIONS: ReadonlyArray<{ id: McpClient; label: string }> = [
  { id: "codex", label: "Codex" },
  { id: "claude-code", label: "Claude Code" },
  { id: "opencode", label: "OpenCode 2.x" },
  { id: "opencode-legacy", label: "OpenCode 1.x (legacy)" },
];

export const MCP_KEY_PLACEHOLDER = "<YOUR_MCP_KEY>";
export const MCP_ENDPOINT_PLACEHOLDER = "https://your-lime-host/mcp";

// The inputs are display-only. This helper never reads persisted key hashes,
// writes client configuration, launches a client, or makes network requests.
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function getMcpClientConfiguration(
  client: McpClient,
  endpoint: string,
  generatedKey: string | null = null,
) {
  const url = endpoint || MCP_ENDPOINT_PLACEHOLDER;
  const key = generatedKey || MCP_KEY_PLACEHOLDER;
  if (client === "codex") {
    return {
      label: "Codex",
      format: "TOML",
      instructions: "Add this to ~/.codex/config.toml. Set LIME_MCP_KEY in the environment that launches Codex, then reconnect or start a new session. The key stays out of this config.",
      docsUrl: "https://learn.chatgpt.com/docs/extend/mcp?surface=cli",
      config: [
        "[mcp_servers.lime]",
        `url = ${tomlString(url)}`,
        'bearer_token_env_var = "LIME_MCP_KEY"',
      ].join("\n"),
      environmentCommand: `export LIME_MCP_KEY=${shellQuote(key)}`,
    };
  }
  if (client === "claude-code") {
    return {
      label: "Claude Code",
      format: "POSIX shell",
      instructions: "Run this command in a macOS/Linux/WSL terminal with Claude Code installed. It adds LIME in the current project's local scope. Check the connection with claude mcp list or /mcp inside Claude Code.",
      docsUrl: "https://code.claude.com/docs/en/mcp#option-1-add-a-remote-http-server",
      config: `claude mcp add --transport http lime ${shellQuote(url)} \\\n  --header ${shellQuote(`Authorization: Bearer ${key}`)}`,
      environmentCommand: null,
    };
  }
  const legacy = client === "opencode-legacy";
  const server = {
    type: "remote",
    url,
    headers: { Authorization: `Bearer ${key}` },
    oauth: false,
    ...(legacy ? { enabled: true } : { disabled: false }),
  };
  return {
    label: legacy ? "OpenCode 1.x" : "OpenCode 2.x",
    format: "JSON",
    instructions: legacy
      ? "Merge this entry into your OpenCode 1.x opencode.json. This legacy version places lime directly under mcp and uses enabled. Restart OpenCode and check opencode mcp list."
      : "Merge this entry into your OpenCode 2.x opencode.jsonc. Version 2 uses mcp.servers and disabled, not the 1.x format. Restart OpenCode and check opencode mcp list.",
    docsUrl: legacy ? "https://opencode.ai/docs/mcp-servers/" : "https://opencode.ai/v2/docs/mcp-servers",
    config: JSON.stringify({
      // The hosted schema still validates the legacy shape, despite V2 docs
      // using its URL. Omit this optional editor hint for the V2 configuration.
      ...(legacy ? { $schema: "https://opencode.ai/config.json" } : {}),
      mcp: legacy ? { lime: server } : { servers: { lime: server } },
    }, null, 2),
    environmentCommand: null,
  };
}
