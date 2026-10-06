import { chmod, cp, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const READ_TOOLS = Object.freeze([
  "list_scans", "get_scan", "list_scan_issues", "get_issue_detail", "get_report_metadata", "get_settings",
  "list_link_checks", "get_link_check", "get_link_check_stats", "get_scan_link_check",
  "list_link_check_results", "list_link_check_sources", "get_capabilities", "get_workspace_stats",
  "get_report", "get_screenshot", "get_link_check_export",
]);
export const WRITE_TOOLS = Object.freeze([
  "create_scan", "pause_scan", "resume_scan", "retry_failed_pages", "rescan_scan", "delete_scan",
  "mark_issue_false_positive", "create_link_check", "cancel_link_check", "recheck_link_check",
  "delete_link_check", "update_settings",
]);

export function validateEndpoint(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/mcp") {
    throw new Error("Use the dashboard HTTP(S) /mcp endpoint without credentials, query, or fragment.");
  }
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Remote MCP requires HTTPS. Plain HTTP is allowed only on loopback.");
  }
  return url.href;
}

export async function makeOpenClawConfig({ allowWrites = false, model = "openai/gpt-5.6-sol" } = {}) {
  if (typeof allowWrites !== "boolean") throw new Error("allowWrites must be an explicit boolean.");
  const config = JSON.parse(await readFile(path.join(agentRoot, "openclaw.example.json"), "utf8"));
  const names = [...READ_TOOLS, ...(allowWrites ? WRITE_TOOLS : [])];
  config.tools.allow = ["read", "session_status", ...names.map((name) => `lime__${name}`)];
  config.mcp.servers.lime.toolFilter.include = names;
  config.agents.defaults.model = { primary: model, fallbacks: [] };
  config.agents.defaults.models = { [model]: { agentRuntime: { id: "openclaw" } } };
  return config;
}

async function requireRegularTree(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) throw new Error("Agent workspace must contain only regular files and directories, not links/devices.");
    if (entry.isDirectory()) await requireRegularTree(target);
  }
}

// Generates a separate local profile; never merges, imports, or replaces a user's OpenClaw config/auth.
export async function createOpenClawDemo({ directory, workspace = path.join(agentRoot, "workspace"), mcpUrl, model, allowWrites = false }) {
  const endpoint = validateEndpoint(mcpUrl);
  if (!model || !/^openai\/[a-zA-Z0-9_./-]{1,200}$/.test(model)) throw new Error("This hardened demo requires an authenticated openai/<model> in the embedded OpenClaw runtime. CLI-backed models are not supported.");
  if (!directory || !path.isAbsolute(directory)) throw new Error("Profile directory must be an absolute path.");
  const source = await realpath(workspace);
  await requireRegularTree(source);
  const target = path.resolve(directory);
  if (target === source || target.startsWith(source + path.sep) || source.startsWith(target + path.sep)) throw new Error("Profile directory and source workspace must not overlap.");
  await mkdir(target, { recursive: true, mode: 0o700 });
  if ((await lstat(target)).isSymbolicLink() || (await realpath(target)) !== target) throw new Error("Use a resolved profile path without symlinks.");
  if ((await readdir(target)).length) throw new Error("Profile directory must be empty; existing files are never overwritten.");
  await chmod(target, 0o700);
  const copiedWorkspace = path.join(target, "workspace");
  await cp(source, copiedWorkspace, { recursive: true, force: false, errorOnExist: true });
  const stateDir = path.join(target, "state");
  await mkdir(stateDir, { mode: 0o700 });
  const configPath = path.join(target, "openclaw.json");
  const config = await makeOpenClawConfig({ allowWrites, model });
  config.agents.defaults.workspace = copiedWorkspace;
  config.agents.list[0].workspace = copiedWorkspace;
  config.mcp.servers.lime.url = endpoint;
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await writeFile(path.join(target, ".gitignore"), "*\n", { flag: "wx", mode: 0o600 });
  const env = { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath, LIME_AGENT_WORKSPACE: copiedWorkspace, LIME_MCP_URL: endpoint, LIME_AGENT_MODEL: model };
  return { configPath, stateDir, workspace: copiedWorkspace, env };
}

const help = `Usage: node agent/scripts/openclaw-config.mjs --directory /absolute/empty/path --url <dashboard>/mcp --model provider/model [--allow-writes]

Creates a private, independent embedded OpenClaw profile and copies the LIME workspace/skills.
No keys are stored. Supply LIME_MCP_KEY in the process environment later.
Read-only by default. --allow-writes exposes known action tools locally but DOES NOT
enable writes in LIME or authorize any action. Existing directories are never overwritten.
No login, gateway service, channels, or global settings are changed.
Select an installed/authenticated openai/<model>; CLI-backed models are not supported
because their native host tools may bypass the OpenClaw allowlist.
The demo selects openai:default subscription OAuth (existing Codex sign-in or isolated
profile login). It does not configure Platform API-key billing.
`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.includes("--help") || args.includes("-h")) { console.log(help); process.exit(0); }
    const options = {};
    for (let index = 0; index < args.length; index++) {
      const flag = args[index];
      if (flag === "--allow-writes") { options.allowWrites = true; continue; }
      const key = { "--directory": "directory", "--url": "mcpUrl", "--model": "model" }[flag];
      if (!key || !args[index + 1] || args[index + 1].startsWith("--") || key in options) throw new Error("Unknown, duplicate, or incomplete argument. Use --help.");
      options[key] = args[++index];
    }
    const result = await createOpenClawDemo(options);
    console.log(JSON.stringify({ ...result, access: options.allowWrites ? "writes locally allowed; LIME permission and human authorization still required" : "read-only" }, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
