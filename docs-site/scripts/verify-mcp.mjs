import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const MCP_TOOL_NAMES = [
  "list_scans", "get_scan", "list_scan_issues", "get_issue_detail",
  "get_report_metadata", "get_settings",
];

// Real SDK handshake, including initialized notification and negotiated headers.
// Trace only transport metadata; never record Authorization or response bodies.
export async function connectMcp(url, key, { sdk = "v1" } = {}) {
  assert.ok(["v1", "v2"].includes(sdk), "MCP SDK must be v1 or v2");
  const constructors = sdk === "v2"
    ? await import("@modelcontextprotocol/client")
    : { Client, StreamableHTTPClientTransport };
  const trace = [];
  const client = new constructors.Client(
    { name: `lime-verification-${sdk}`, version: "1.0.0" },
    sdk === "v2" ? { versionNegotiation: { mode: "legacy" } } : undefined,
  );
  const transport = new constructors.StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      const message = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      const response = await fetch(input, { ...init, signal: AbortSignal.timeout(30_000) });
      trace.push({
        method: init?.method || "GET",
        rpcMethod: message?.method,
        protocol: headers.get("MCP-Protocol-Version"),
        accept: headers.get("Accept"),
        status: response.status,
      });
      return response;
    },
  });
  try {
    await client.connect(transport);
  } catch (error) {
    await client.close();
    throw error;
  }
  return { client, transport, trace };
}

export async function readMcpTool(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, `${name}: ${result.content?.[0]?.text}`);
  assert.ok(result.structuredContent, `${name} returns structured data`);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent,
    `${name} text and structured results agree`);
  return result.structuredContent;
}

// Optional operator smoke test: read-only, never enables MCP or rotates a key.
export async function verifyMcpReadClient(url, key, scanId, options) {
  const { client, trace } = await connectMcp(url, key, options);
  const checked = [];
  try {
    await client.ping();
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [...MCP_TOOL_NAMES].sort());
    const scans = await readMcpTool(client, "list_scans", { limit: 1 });
    checked.push("list_scans");
    await readMcpTool(client, "get_settings");
    checked.push("get_settings");
    const id = scanId || scans.scans[0]?.id;
    if (id) {
      await readMcpTool(client, "get_scan", { scan_id: id });
      checked.push("get_scan");
      const groups = await readMcpTool(client, "list_scan_issues", { scan_id: id, limit: 1 });
      checked.push("list_scan_issues");
      await readMcpTool(client, "get_report_metadata", { scan_id: id });
      checked.push("get_report_metadata");
      if (groups.issues[0]) {
        const { kind, key: groupKey } = groups.issues[0];
        await readMcpTool(client, "get_issue_detail", { scan_id: id, kind, key: groupKey, limit: 1 });
        checked.push("get_issue_detail");
      }
    }
    return {
      server: client.getServerVersion(), checked, trace,
      protocol: options?.sdk === "v2"
        ? { era: client.getProtocolEra(), version: client.getNegotiatedProtocolVersion() }
        : undefined,
    };
  } finally {
    await client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.LIME_MCP_URL || "http://localhost:3000/mcp";
  const key = process.env.LIME_MCP_KEY;
  if (!key) throw new Error("Set LIME_MCP_KEY to a key generated in LIME Settings. No settings will be changed.");
  console.log(JSON.stringify(await verifyMcpReadClient(url, key, process.env.LIME_MCP_SCAN_ID, { sdk: process.env.LIME_MCP_SDK || "v1" }), null, 2));
}
