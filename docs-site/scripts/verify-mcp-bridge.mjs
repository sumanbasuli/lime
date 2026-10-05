import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MCP_TOOL_NAMES, readMcpTool } from "./verify-mcp.mjs";

// Reviewed release: https://github.com/punkpeye/mcp-remote/tree/v0.14.3
// npm gitHead: 6a06aca546a8fd3b7beb040f39761b364893198d.
export const MCP_BRIDGE_PACKAGE = "mcp-remote@0.14.3";

async function availablePort(port = 0) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const selected = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return selected;
}

// SDK stdio -> a real pinned bridge subprocess -> canonical dashboard HTTP.
// Call only with the isolated suite's key; this never enables MCP or edits settings.
export async function verifyMcpBridge(url, key, scanId) {
  const endpoint = new URL(url);
  assert.ok(["http:", "https:"].includes(endpoint.protocol), "Bridge endpoint must be HTTP(S)");
  assert.ok(!endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash,
    "Keep credentials out of the bridge URL");
  assert.ok(endpoint.protocol === "https:" || ["localhost", "127.0.0.1"].includes(endpoint.hostname),
    "Use HTTPS except for the isolated loopback test");
  assert.ok(typeof key === "string" && key && scanId,
    "Bridge verification needs an isolated MCP key and saved fixture scan");

  const callbackPort = await availablePort();
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "lime-mcp-bridge-"));
  const client = new Client({ name: "lime-stdio-bridge-verification", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: "npx",
    args: [
      "--yes", MCP_BRIDGE_PACKAGE, endpoint.href, String(callbackPort),
      "--host", "127.0.0.1", "--transport", "http-only",
      "--header", "Authorization:${LIME_MCP_AUTH_HEADER}", "--silent",
    ],
    env: {
      LIME_MCP_AUTH_HEADER: `Bearer ${key}`,
      MCP_REMOTE_CONFIG_DIR: path.join(temporaryDirectory, "auth"),
      npm_config_cache: path.join(temporaryDirectory, "npm-cache"),
      npm_config_ignore_scripts: "true",
      npm_config_audit: "false",
      npm_config_fund: "false",
    },
    stderr: "pipe",
  });
  // connect() also closes on failed initialization. Await that same close operation.
  const originalClose = transport.close.bind(transport);
  let closing;
  transport.close = () => closing ||= originalClose();
  let stderr = "";
  transport.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-16_384);
  });
  const redact = (value) => String(value).replaceAll(key, "[REDACTED]")
    .replace(/Bearer\s+[^\s"',}]+/gi, "Bearer [REDACTED]");
  const signal = AbortSignal.timeout(60_000);
  const requestOptions = { signal, timeout: 20_000 };
  const reader = { callTool: (params) => client.callTool(params, undefined, requestOptions) };
  let phase = "starting pinned npx bridge and initializing";
  let childPid;
  let evidence;
  try {
    try {
      const connecting = client.connect(transport, { signal, timeout: 60_000 });
      await connecting;
      childPid = transport.pid;
      phase = "ping and tool listing";
      await client.ping(requestOptions);
      const tools = (await client.listTools(undefined, requestOptions)).tools;
      assert.deepEqual(tools.map((tool) => tool.name).sort(), [...MCP_TOOL_NAMES].sort());

      const checked = [];
      const read = async (name, args) => {
        phase = name;
        const data = await readMcpTool(reader, name, args);
        checked.push(name);
        return data;
      };
      await read("list_scans", { limit: 1 });
      await read("get_settings");
      await read("get_scan", { scan_id: scanId });
      const groups = await read("list_scan_issues", { scan_id: scanId, limit: 1 });
      await read("get_report_metadata", { scan_id: scanId });
      assert.ok(groups.issues[0], "Bridge fixture must include an issue group");
      const { kind, key: groupKey } = groups.issues[0];
      await read("get_issue_detail", { scan_id: scanId, kind, key: groupKey, limit: 1 });
      assert.ok(!stderr.includes(key), "Bridge stderr must not expose the MCP key");
      evidence = {
        bridge: MCP_BRIDGE_PACKAGE,
        sdk: "@modelcontextprotocol/sdk@1.32.0",
        transport: "stdio -> Streamable HTTP",
        server: client.getServerVersion(),
        tools: tools.map((tool) => tool.name),
        checked,
      };
    } finally {
      childPid ||= transport.pid;
      await client.close();
      await transport.close();
      assert.ok(childPid, "Bridge launcher PID was captured");
      assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" }, "Bridge launcher exited after close");
      await availablePort(callbackPort);
    }
    return { ...evidence, cleanup: { launcherExited: true, callbackPortReleased: true } };
  } catch (error) {
    const detail = stderr.trim() ? ` Bridge stderr: ${redact(stderr.trim())}` : "";
    throw new Error(`MCP bridge failed during ${phase}: ${redact(error.message)}.${detail}`);
  } finally {
    // Only this helper's generated cache/auth directory, never a user's MCP config.
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
