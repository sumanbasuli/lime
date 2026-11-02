import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { connect } from "node:net";
import { Duplex } from "node:stream";
import { createRequire } from "node:module";
import { once } from "node:events";
import vm from "node:vm";
import { gzipSync } from "node:zlib";
import test from "node:test";

const require = createRequire(new URL("../package.json", import.meta.url));
const ts = require("typescript");

// Execute the actual route/helper source, with controlled external boundaries.
// No database, app settings, credentials or running LIME services are changed.
async function loadSource(path, globals = {}, dependencies = {}) {
  if (path === "../src/app/mcp/route.ts" && !("@/lib/bounded-json-body" in dependencies)) {
    dependencies = { ...dependencies, "@/lib/bounded-json-body": await loadSource("../src/lib/bounded-json-body.ts") };
  }
  if (path === "../src/app/mcp/route.ts" && !("@/lib/mcp-report-read" in dependencies)) {
    dependencies = { ...dependencies, "@/lib/mcp-report-read": {
      McpReadPreparationBusyError: class extends Error {},
      withMcpReportRead: async (_signal, work) => work({ controlledScoreRead: true }),
    } };
  }
  if (path === "../src/app/mcp/route.ts" && !("@/lib/mcp-artifact-delivery" in dependencies)) {
    dependencies = { ...dependencies, "@/lib/mcp-artifact-delivery": await loadSource("../src/lib/mcp-artifact-delivery.ts", { __limeMcpArtifactTransportBinding: () => {} }) };
  }
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports, URL, Headers, Response, Request, AbortSignal, Buffer, JSON, Date,
    ReadableStream, Uint8Array, setTimeout, clearTimeout, crypto,
    fetch, process: { env: { SHOPKEEPER_URL: "http://shopkeeper.invalid:8080" } },
    require: (name) => {
      if (name === "@/lib/mcp-dashboard-tools" && !(name in dependencies)) return { runDashboardMcpTool: () => assert.fail("Unexpected dashboard operation") };
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    ...globals,
  });
  return exports;
}

const loadProxy = (globals) => loadSource("../src/lib/shopkeeper-proxy.ts", globals);
const originHelper = await loadSource("../src/lib/ordinary-api-origin.ts");
function mcpToolCall(name) {
  return new Request("http://dashboard.invalid:3000/mcp", {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }),
  });
}
function proxyRequest(body, { method = "POST", signal = new AbortController().signal, headers = {} } = {}) {
  return {
    nextUrl: new URL("http://dashboard.invalid:3000/mcp?probe=1"), method,
    headers: new Headers(headers), signal,
    body: body instanceof ReadableStream ? body : new Blob([body ?? ""]).stream(),
    arrayBuffer: () => new Blob([body ?? ""]).arrayBuffer(),
  };
}

test("catch-all API route forwards an ordinary scan body", async () => {
  const body = '{"sitemap_url":"https://example.test/","scan_type":"single"}';
  const proxy = await loadProxy({ fetch: async (url, init) => {
    assert.equal(String(url), "http://shopkeeper.invalid:8080/api/scans");
    assert.equal(init.body.toString(), body);
    return new Response(null, { status: 201 });
  } });
  const route = await loadSource("../src/app/api/[...path]/route.ts", {}, { "@/lib/shopkeeper-proxy": proxy, "@/lib/ordinary-api-origin": originHelper });
  const request = proxyRequest(body);
  request.nextUrl = new URL("http://dashboard.invalid:3000/api/scans");
  assert.equal((await route.POST(request)).status, 201);
});

test("catch-all API route rejects an oversized chunked body before upstream fetch", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(1024 * 1024));
      controller.enqueue(new Uint8Array(1));
    },
    cancel() { cancelled = true; },
  });
  const proxy = await loadProxy({ fetch: () => assert.fail("Must not fetch oversized body") });
  const route = await loadSource("../src/app/api/[...path]/route.ts", {}, { "@/lib/shopkeeper-proxy": proxy, "@/lib/ordinary-api-origin": originHelper });
  const request = proxyRequest(body);
  request.nextUrl = new URL("http://dashboard.invalid:3000/api/scans");
  assert.equal(request.headers.get("Content-Length"), null);
  assert.equal((await route.POST(request)).status, 413);
  assert.equal(cancelled, true);
});

test("catch-all API route sets an incoming-body deadline without timing out upstream work", async () => {
  const route = await loadSource("../src/app/api/[...path]/route.ts", {}, {
    "@/lib/shopkeeper-proxy": {
      proxyShopkeeperRequest: async (_request, options) => {
        assert.equal(options.bodyLimit, 1024 * 1024);
        assert.equal(options.bodyTimeoutMs, 60_000);
        assert.equal(options.timeoutMs, undefined);
        return new Response(null, { status: 204 });
      },
    },
    "@/lib/ordinary-api-origin": originHelper,
  });
  assert.equal((await route.POST(proxyRequest("{}"))).status, 204);
});

test("ordinary incoming-body deadline cancels a stalled upload before upstream fetch", async () => {
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const { proxyShopkeeperRequest } = await loadProxy({ fetch: () => assert.fail("Must not fetch stalled body") });
  const work = proxyShopkeeperRequest(proxyRequest(body), { bodyLimit: 1024, bodyTimeoutMs: 20 });
  let timer;
  const result = await Promise.race([
    work,
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), 200); }),
  ]);
  clearTimeout(timer);
  if (!result) {
    await body.cancel().catch(() => {});
    assert.fail("Ordinary body timeout did not stop request-body reading");
  }
  assert.equal(result.status, 408);
  assert.equal(result.headers.get("Connection"), "close");
  assert.equal(cancelled, true);
});

test("a partial HTTP upload gets a 408 and its keep-alive socket closes", async () => {
  const { NextRequestAdapter, signalFromNodeResponse } = require("next/dist/server/web/spec-extension/adapters/next-request");
  const { NodeNextRequest, NodeNextResponse } = require("next/dist/server/base-http/node");
  const { sendResponse } = require("next/dist/server/send-response");
  const { proxyShopkeeperRequest } = await loadProxy({ fetch: () => assert.fail("Must not fetch stalled body") });
  const handlerErrors = [];
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      const nextRequest = new NodeNextRequest(incoming);
      const request = NextRequestAdapter.fromNodeNextRequest(nextRequest, signalFromNodeResponse(outgoing));
      const response = await proxyShopkeeperRequest(request, { bodyLimit: 1024, bodyTimeoutMs: 20 });
      await sendResponse(nextRequest, new NodeNextResponse(outgoing), response);
    })().catch((error) => {
      handlerErrors.push(error);
      outgoing.destroy(error);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const socket = connect(server.address().port, "127.0.0.1");
  let timer;
  let wire = "";
  socket.on("data", (chunk) => { wire += chunk.toString(); });
  try {
    await once(socket, "connect");
    socket.write("POST /api/scans HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100\r\nConnection: keep-alive\r\n\r\nx");
    await Promise.race([
      once(socket, "close"),
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Timed-out upload socket stayed open")), 2_000); }),
    ]);
    assert.match(wire, /^HTTP\/1\.1 408 /);
    assert.match(wire, /\r\nconnection: close\r\n/i);
    assert.deepEqual(handlerErrors, []);
  } finally {
    clearTimeout(timer);
    socket.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("proxy preserves MCP auth, raw ID, protocol, status and CORS", async () => {
  const body = '{"jsonrpc":"2.0","id":9007199254740993,"method":"ping"}';
  const { proxyShopkeeperRequest } = await loadProxy({ fetch: async (url, init) => {
    assert.equal(String(url), "http://shopkeeper.invalid:8080/mcp?probe=1");
    assert.equal(init.body.toString(), body);
    assert.equal(init.headers.get("Authorization"), "Bearer fixture-key");
    assert.equal(init.headers.get("MCP-Protocol-Version"), "2025-11-25");
    assert.equal(init.headers.get("Origin"), "http://localhost:3002");
    assert.equal(init.headers.get("Host"), null);
    return new Response(body, { headers: { "Access-Control-Allow-Origin": "http://localhost:3002", Connection: "close" } });
  } });
  const result = await proxyShopkeeperRequest(proxyRequest(body, { headers: {
    Authorization: "Bearer fixture-key", "MCP-Protocol-Version": "2025-11-25",
    Origin: "http://localhost:3002", Host: "dashboard.invalid:3000",
  } }), { bodyLimit: 1024 });
  assert.equal(result.status, 200);
  assert.equal(await result.text(), body);
  assert.equal(result.headers.get("Access-Control-Allow-Origin"), "http://localhost:3002");
  assert.equal(result.headers.get("Connection"), null);
});

test("oversized body is cancelled before upstream fetch", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(5)); },
    cancel() { cancelled = true; },
  });
  const { proxyShopkeeperRequest } = await loadProxy({ fetch: () => assert.fail("Must not fetch oversized body") });
  const result = await proxyShopkeeperRequest(proxyRequest(body), { bodyLimit: 4 });
  assert.equal(result.status, 413);
  assert.equal(result.headers.get("Connection"), "close");
  assert.equal(cancelled, true);
});

test("MCP deadline bounds a stalled incoming body", async () => {
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const { proxyShopkeeperRequest } = await loadProxy({ fetch: () => assert.fail("Must not fetch expired body") });
  const work = proxyShopkeeperRequest(proxyRequest(body), { bodyLimit: 1024, timeoutMs: 20 });
  let timer;
  const result = await Promise.race([
    work,
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), 200); }),
  ]);
  clearTimeout(timer);
  if (!result) {
    await body.cancel().catch(() => {});
    assert.fail("MCP timeout did not stop request-body reading");
  }
  assert.equal(result.status, 504);
  assert.equal(result.headers.get("Connection"), "close");
  assert.equal(cancelled, true);
});

test("body stream failures return a controlled response without upstream fetch", async () => {
  const body = new ReadableStream({ start(controller) { controller.error(new Error("private request internals")); } });
  const { proxyShopkeeperRequest } = await loadProxy({ fetch: () => assert.fail("Must not fetch failed body") });
  const result = await proxyShopkeeperRequest(proxyRequest(body), { bodyLimit: 1024 });
  assert.equal(result.status, 400);
  assert.ok(!(await result.text()).includes("private request internals"));
});

test("client cancellation stops a pending incoming body without upstream fetch", async () => {
  let cancelled = false;
  const controller = new AbortController();
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const { proxyShopkeeperRequest } = await loadProxy({ fetch: () => assert.fail("Must not fetch cancelled body") });
  const work = proxyShopkeeperRequest(proxyRequest(body, { signal: controller.signal }), { bodyLimit: 1024, timeoutMs: 1000 });
  controller.abort();
  const result = await work;
  assert.equal(result.status, 400);
  assert.equal(cancelled, true);
});

test("already cancelled requests never read a body or call upstream", async () => {
  const controller = new AbortController();
  controller.abort();
  const request = proxyRequest("{}", { signal: controller.signal });
  request.arrayBuffer = () => assert.fail("Must not buffer an already cancelled request");
  const { proxyShopkeeperRequest } = await loadProxy({ fetch: () => assert.fail("Must not fetch cancelled request") });
  assert.equal((await proxyShopkeeperRequest(request)).status, 400);
});

test("an upstream fetch deadline returns 504 rather than a network 502", async () => {
  let cancelled = false;
  const { proxyShopkeeperRequest } = await loadProxy({ fetch: (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => { cancelled = true; reject(signal.reason); }, { once: true });
  }) });
  let timer;
  try {
    const result = await Promise.race([
      proxyShopkeeperRequest(proxyRequest(null, { method: "GET" }), { timeoutMs: 20 }),
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Fetch deadline did not fire")), 200); }),
    ]);
    assert.equal(result.status, 504);
    assert.equal(cancelled, true);
  } finally {
    clearTimeout(timer);
  }
});

test("upstream network errors do not disclose configured URLs or credentials", async () => {
  const { proxyShopkeeperRequest } = await loadProxy({
    process: { env: { SHOPKEEPER_URL: "http://fixture-user:fixture-password@shopkeeper.invalid:8080" } },
    fetch: async () => { throw new Error("private network internals"); },
  });
  const result = await proxyShopkeeperRequest(proxyRequest("{}"), { bodyLimit: 1024 });
  assert.equal(result.status, 502);
  const error = await result.text();
  for (const hidden of ["fixture-user", "fixture-password", "shopkeeper.invalid", "private network internals"]) {
    assert.ok(!error.includes(hidden), "Internal upstream configuration must not be returned");
  }
});

test("invalid upstream configuration returns a controlled configuration error", async () => {
  const { proxyShopkeeperRequest } = await loadProxy({ process: { env: { SHOPKEEPER_URL: "not a URL" } } });
  const result = await proxyShopkeeperRequest(proxyRequest("{}"), { bodyLimit: 1024 });
  assert.equal(result.status, 500);
  assert.ok((await result.json()).error);
});

test("missing or non-HTTP upstream configuration does not call fetch", async () => {
  for (const value of [undefined, " ", "file:///private/config", "ftp://internal.invalid"]) {
    const { proxyShopkeeperRequest } = await loadProxy({
      process: { env: { SHOPKEEPER_URL: value } },
      fetch: () => assert.fail("Must not fetch unsupported upstream URL"),
    });
    const result = await proxyShopkeeperRequest(proxyRequest("{}"), { bodyLimit: 1024 });
    assert.equal(result.status, 500);
    assert.ok(!(await result.text()).includes("private/config"));
  }
});

test("actual fetch gzip decoding does not leave invalid compression/length headers", async () => {
  const payload = '{"jsonrpc":"2.0","id":7,"result":{}}';
  const compressed = gzipSync(payload);
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json", "Content-Encoding": "gzip", "Content-Length": compressed.length });
    response.end(compressed);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { proxyShopkeeperRequest } = await loadProxy({
      process: { env: { SHOPKEEPER_URL: `http://127.0.0.1:${server.address().port}` } },
    });
    const result = await proxyShopkeeperRequest(proxyRequest(null, { method: "GET" }));
    assert.equal(await result.text(), payload, "Fetch has already decompressed the body");
    assert.equal(result.headers.get("Content-Encoding"), null);
    assert.equal(result.headers.get("Content-Length"), null);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("canonical get_scan retains numeric IDs and matching structured/text scores", async () => {
  for (const id of ["0", "9007199254740993", "-9007199254740993", "12345678901234567890123456789012345678901234567890", '"client-id"']) {
    let reads = 0;
    const route = await loadSource("../src/app/mcp/route.ts", {}, {
      "@/lib/shopkeeper-proxy": { proxyShopkeeperRequest: async () => new Response(`{"jsonrpc":"2.0","id":${id},"result":{"structuredContent":{"scan":{"id":"fixture-scan","status":"completed"},"score_summary":null}}}`) },
      "@/lib/scan-score-data": { getScanScoreSummaries: async () => { reads++; return { "fixture-scan": { score: 81, hasScore: true } }; } },
    });
    const result = await route.POST(mcpToolCall("get_scan"));
    const text = await result.text();
    assert.ok(text.includes(`"id":${id}`), `Preserve request ID ${id}`);
    const data = JSON.parse(text);
    assert.equal(data.result.structuredContent.score_summary.score, 81);
    assert.deepEqual(JSON.parse(data.result.content[0].text), data.result.structuredContent);
    assert.equal(reads, 1);
    assert.equal(result.headers.get("Cache-Control"), "no-store");
  }
});

test("canonical auth/protocol/method/notification errors never trigger scoring", async () => {
  for (const status of [401, 400, 403, 405, 202]) {
    const route = await loadSource("../src/app/mcp/route.ts", {}, {
      "@/lib/shopkeeper-proxy": { proxyShopkeeperRequest: async () => new Response(status === 202 ? null : "upstream error", { status, headers: { "WWW-Authenticate": "Bearer", Allow: "POST" } }) },
      "@/lib/scan-score-data": { getScanScoreSummaries: () => assert.fail("Unauthorized/error response must not load scores") },
    });
    const result = await route.POST(mcpToolCall("get_scan"));
    assert.equal(result.status, status);
    assert.equal(result.headers.get("WWW-Authenticate"), "Bearer");
    assert.equal(result.headers.get("Allow"), "POST");
    assert.equal(await result.text(), status === 202 ? "" : "upstream error");
  }
});

test("canonical Link Checker reads pass through unchanged without accessibility scoring", async () => {
  const check = { id: "fixture-check", scan_id: null, summary: { broken: 1 }, truncated: true };
  const payloads = [
    ["list_link_checks", { checks: [check], total: 1, limit: 20, offset: 0, has_more: false }],
    ["get_link_check", { check, dashboard_path: "/links/fixture-check", csv_path: "/api/link-checks/fixture-check/export.csv", paths_relative_to: "dashboard_origin" }],
    ["get_link_check_stats", { stats: { total_checks: 1, broken_links: 1 } }],
    ["get_scan_link_check", { scan_id: "fixture-scan", include_link_check: false, check: null, dashboard_path: null, csv_path: null, paths_relative_to: "dashboard_origin" }],
    ["list_link_check_results", { results: [{ id: "fixture-result", status: "broken", status_code: 999 }], total: 1, limit: 20, offset: 0, has_more: false }],
    ["list_link_check_sources", { sources: [{ page_url: "https://example.invalid/", element: "a", attribute: "href", text: "Untrusted captured text" }], total: 1, limit: 20, offset: 0, has_more: false }],
  ];
  for (const [name, data] of payloads) {
    const body = `{"jsonrpc":"2.0","id":9007199254740993,"result":${JSON.stringify({ structuredContent: data, content: [{ type: "text", text: JSON.stringify(data) }] })}}`;
    const route = await loadSource("../src/app/mcp/route.ts", {}, {
      "@/lib/shopkeeper-proxy": { proxyShopkeeperRequest: async () => new Response(body, { headers: { "Access-Control-Allow-Origin": "http://localhost:3002", "Cache-Control": "no-store", "X-Lime-MCP-Transform": "none" } }) },
      "@/lib/scan-score-data": { getScanScoreSummaries: () => assert.fail("Link data must not invoke the accessibility scorer") },
    });
    const result = await route.POST(mcpToolCall(name));
    assert.equal(await result.text(), body, "Keep raw outcomes, captured sources and large numeric IDs byte-for-byte");
    assert.equal(result.headers.get("Access-Control-Allow-Origin"), "http://localhost:3002");
    assert.equal(result.headers.get("Cache-Control"), "no-store");
  }
});

test("canonical score failure is actionable, redacted and preserves request ID/CORS", async () => {
  const route = await loadSource("../src/app/mcp/route.ts", {}, {
    "@/lib/shopkeeper-proxy": { proxyShopkeeperRequest: async () => new Response('{"jsonrpc":"2.0","id":9007199254740993,"result":{"structuredContent":{"scan":{"id":"fixture-scan"},"score_summary":null}}}', { headers: { "Access-Control-Allow-Origin": "http://localhost:3002" } }) },
    "@/lib/scan-score-data": { getScanScoreSummaries: async () => { throw new Error("private SQL internals"); } },
  });
  const result = await route.POST(mcpToolCall("get_scan"));
  const text = await result.text();
  assert.ok(text.includes('"id":9007199254740993'));
  assert.ok(!text.includes("private SQL internals"));
  assert.equal(JSON.parse(text).result.isError, true);
  assert.equal(result.headers.get("Access-Control-Allow-Origin"), "http://localhost:3002");
});

test("canonical scoring passes one trusted bounded context and stages cache publication for that scan", async () => {
  const context = { controlledBoundedRead: true };
  let started = 0;
  let finished = 0;
  const route = await loadSource("../src/app/mcp/route.ts", {}, {
    "@/lib/shopkeeper-proxy": { proxyShopkeeperRequest: async () => new Response('{"jsonrpc":"2.0","id":9007199254740993,"result":{"structuredContent":{"scan":{"id":"fixture-scan","status":"paused"},"score_summary":null}}}') },
    "@/lib/mcp-report-read": {
      McpReadPreparationBusyError: class extends Error {},
      withMcpReportRead: async (signal, work, options) => {
        assert.equal(signal.aborted, false);
        assert.deepEqual(JSON.parse(JSON.stringify(options)), { scoreCacheScanId: "fixture-scan" });
        started++;
        const value = await work(context);
        finished++;
        return value;
      },
    },
    "@/lib/scan-score-data": { getScanScoreSummaries: async (scans, actualContext) => {
      assert.equal(actualContext, context, "No unbounded global-pool fallback");
      assert.deepEqual(JSON.parse(JSON.stringify(scans)), [{ id: "fixture-scan", status: "paused" }]);
      return { "fixture-scan": { score: 81, hasScore: true } };
    } },
  });
  const result = await route.POST(mcpToolCall("get_scan"));
  assert.equal(started, 1);
  assert.equal(finished, 1);
  assert.ok((await result.text()).includes('"id":9007199254740993'));
});

test("busy score preparation returns a retryable tool error without running the scorer", async () => {
  class Busy extends Error {}
  const route = await loadSource("../src/app/mcp/route.ts", {}, {
    "@/lib/shopkeeper-proxy": { proxyShopkeeperRequest: async () => new Response('{"jsonrpc":"2.0","id":9007199254740993,"result":{"structuredContent":{"scan":{"id":"fixture-scan"},"score_summary":null}}}', { headers: { "Access-Control-Allow-Origin": "http://localhost:3002", "MCP-Protocol-Version": "2025-11-25" } }) },
    "@/lib/mcp-report-read": { McpReadPreparationBusyError: Busy, withMcpReportRead: async () => { throw new Busy("private details"); } },
    "@/lib/scan-score-data": { getScanScoreSummaries: () => assert.fail("No scoring while busy") },
  });
  const response = await route.POST(mcpToolCall("get_scan"));
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.ok(text.includes('"id":9007199254740993'));
  assert.doesNotMatch(text, /private details/);
  const result = JSON.parse(text).result;
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.http_status, 503);
  assert.equal(result.structuredContent.retry_after_seconds, 1);
  assert.equal(response.headers.get("MCP-Protocol-Version"), "2025-11-25");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "http://localhost:3002");
});

test("canonical large issue detail stays an untouched lazy upstream stream", async () => {
  const body = `{"jsonrpc":"2.0","id":9007199254740993,"result":{"structuredContent":{"detail":"${"x".repeat(5 * 1024 * 1024)}"}}}`;
  let pulls = 0;
  const stream = new ReadableStream({
    pull(controller) {
      pulls++;
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  }, { highWaterMark: 0 });
  const upstream = new Response(stream, { headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Lime-MCP-Transform": "none" } });
  const route = await loadSource("../src/app/mcp/route.ts", {}, {
    "@/lib/shopkeeper-proxy": { proxyShopkeeperRequest: async () => upstream },
    "@/lib/scan-score-data": { getScanScoreSummaries: () => assert.fail("Issue detail must not invoke scoring") },
  });
  const result = await route.POST(mcpToolCall("get_issue_detail"));
  assert.equal(result, upstream, "No clone, parse, or replacement response for an ordinary read");
  assert.equal(pulls, 0, "Do not pull the large result before the caller reads it");
  assert.equal(await result.text(), body, "Preserve the full response and large numeric ID byte-for-byte");
  assert.equal(pulls, 1);
});

test("canonical inspection rejects oversized marked and legacy bodies before parsing", async () => {
  for (const transform of ["dashboard", null]) {
    let cancelled = false;
    let pulls = 0;
    let clones = 0;
    const body = new ReadableStream({
      pull(controller) {
        pulls++;
        if (pulls <= 33) controller.enqueue(Buffer.alloc(1024 * 1024, 32));
        else controller.close();
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const upstream = new Response(body, { headers: {
      "Content-Length": "1", "Content-Encoding": "gzip",
      "Access-Control-Allow-Origin": "http://localhost:3002",
      ...(transform ? { "X-Lime-MCP-Transform": transform } : {}),
    } });
    const clone = upstream.clone.bind(upstream);
    upstream.clone = () => { clones++; return clone(); };
    const route = await loadSource("../src/app/mcp/route.ts", {}, {
      "@/lib/shopkeeper-proxy": { proxyShopkeeperRequest: async () => upstream },
      "@/lib/scan-score-data": { getScanScoreSummaries: () => assert.fail("No scoring oversized responses") },
    });
    const response = await route.POST(mcpToolCall("get_scan"));
    assert.equal(response.status, 413);
    assert.equal(clones, 0, "No tee can retain an unconsumed second copy");
    assert.equal(cancelled, true);
    assert.equal(pulls, 33, "Stop at the first decoded chunk over 32 MiB");
    assert.equal(response.headers.get("Content-Length"), null);
    assert.equal(response.headers.get("Content-Encoding"), null);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "http://localhost:3002");
    assert.match((await response.json()).error, /request_id/i);
  }
});

test("canonical inspection measures actual gzip-decoded bytes and rejects a single oversized chunk", async () => {
  const compressed = gzipSync(Buffer.alloc(33 * 1024 * 1024, 32));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Encoding": "gzip", "Content-Length": compressed.byteLength, "X-Lime-MCP-Transform": "dashboard" });
    response.end(compressed);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const proxy = await loadProxy({ process: { env: { SHOPKEEPER_URL: `http://127.0.0.1:${server.address().port}` } } });
    const route = await loadSource("../src/app/mcp/route.ts", {}, {
      "@/lib/shopkeeper-proxy": proxy,
      "@/lib/scan-score-data": { getScanScoreSummaries: () => assert.fail("No scoring decoded overage") },
    });
    const response = await route.POST(proxyRequest("{}"));
    assert.equal(response.status, 413);
    assert.equal(response.headers.get("Content-Encoding"), null);
    assert.equal(response.headers.get("Content-Length"), null);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  let cancelled = false;
  const route = await loadSource("../src/app/mcp/route.ts", {}, {
    "@/lib/shopkeeper-proxy": { proxyShopkeeperRequest: async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(Buffer.alloc(32 * 1024 * 1024 + 1)); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 })) },
    "@/lib/scan-score-data": { getScanScoreSummaries: () => assert.fail("No scoring oversized chunks") },
  });
  assert.equal((await route.POST(mcpToolCall("get_scan"))).status, 413);
  assert.equal(cancelled, true);
});

test("canonical inspection preserves exact-limit, malformed and completed-action legacy bytes", async () => {
  const prefix = Buffer.from('{"id":9007199254740993,"result":{},"padding":"');
  const suffix = Buffer.from('"}');
  for (const body of [
    Buffer.concat([prefix, Buffer.alloc(32 * 1024 * 1024 - prefix.byteLength - suffix.byteLength, 120), suffix]),
    Buffer.from('\uFEFF { "jsonrpc": "2.0", "id": 9007199254740993, "result": {"saved_action":true} }\n'),
    Buffer.from('{"invalid":"\xff\x00"}', "latin1"),
  ]) {
    assert.ok(body.byteLength <= 32 * 1024 * 1024);
    const upstream = new Response(body);
    upstream.clone = () => assert.fail("Inspection must not tee responses");
    const route = await loadSource("../src/app/mcp/route.ts", {}, {
      "@/lib/shopkeeper-proxy": { proxyShopkeeperRequest: async () => upstream },
      "@/lib/scan-score-data": { getScanScoreSummaries: () => assert.fail("No score or action for a completed legacy result") },
    });
    const response = await route.POST(mcpToolCall("create_scan"));
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), body);
  }
});

test("canonical get_scan accepts admitted HTML-escaped metadata plus an independently long string ID", async () => {
  const tag = "<".repeat(1024 * 1024 - 1024);
  const id = "<".repeat(1024 * 1024 - 1024);
  const data = { scan: { id: "fixture-scan", status: "completed", tag }, score_summary: null };
  const goJSON = (value, indent) => JSON.stringify(value, null, indent).replaceAll("<", "\\u003c");
  const body = goJSON({ jsonrpc: "2.0", id, result: { structuredContent: data, content: [{ type: "text", text: goJSON(data, 2) }] } });
  assert.ok(Buffer.byteLength(body) > 16 * 1024 * 1024 && Buffer.byteLength(body) < 32 * 1024 * 1024);
  const route = await loadSource("../src/app/mcp/route.ts", {}, {
    "@/lib/shopkeeper-proxy": { proxyShopkeeperRequest: async () => new Response(body, { headers: { "X-Lime-MCP-Transform": "dashboard" } }) },
    "@/lib/scan-score-data": { getScanScoreSummaries: async () => ({ "fixture-scan": { score: 81, hasScore: true } }) },
  });
  const response = await route.POST(mcpToolCall("get_scan"));
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.id, id);
  assert.equal(result.result.structuredContent.scan.tag, tag);
  assert.equal(result.result.structuredContent.score_summary.score, 81);
  assert.deepEqual(JSON.parse(result.result.content[0].text), result.result.structuredContent);
});

test("two buffered legacy responses retain inspection admission until delivery or cancellation", async () => {
  const body = '{"jsonrpc":"2.0","id":9007199254740993,"result":{"value":"' + "x".repeat(512 * 1024) + '"}}';
  let pulls = 0;
  let cancelled = 0;
  const route = await loadSource("../src/app/mcp/route.ts", {}, {
    "@/lib/shopkeeper-proxy": { proxyShopkeeperRequest: async () => new Response(new ReadableStream({
      pull(controller) { pulls++; controller.enqueue(Buffer.from(body)); controller.close(); },
      cancel() { cancelled++; },
    }, { highWaterMark: 0 }), { headers: { "Access-Control-Allow-Origin": "http://localhost:3002" } }) },
    "@/lib/scan-score-data": { getScanScoreSummaries: () => assert.fail("No scoring legacy data") },
  });
  const first = await route.POST(mcpToolCall("get_link_check"));
  const second = await route.POST(mcpToolCall("get_link_check"));
  try {
    const overflow = await route.POST(mcpToolCall("get_link_check"));
    assert.equal(overflow.status, 503);
    assert.equal(overflow.headers.get("Retry-After"), "1");
    assert.equal(overflow.headers.get("Access-Control-Allow-Origin"), "http://localhost:3002");
    assert.equal(pulls, 2, "Overflow is cancelled before reading its upstream body");
    assert.equal(cancelled, 1);
    assert.match((await overflow.json()).error, /may have completed.*request_id/i);
    assert.equal(await first.text(), body);
    const replacement = await route.POST(mcpToolCall("get_link_check"));
    assert.equal(replacement.status, 200);
    await replacement.body.cancel();
  } finally {
    await first.body.cancel().catch(() => {});
    await second.body.cancel();
  }
});

test("stalled inspection cancellation, deadline and failed reads release their slots", async () => {
  for (const mode of ["abort", "timeout", "error", "empty_flood"]) {
    let cancelled = false;
    let count = 0;
    const controller = new AbortController();
    const boundedBody = await loadSource("../src/lib/bounded-json-body.ts", {
      AbortSignal: { any: AbortSignal.any, timeout: () => AbortSignal.timeout(mode === "timeout" ? 20 : 10_000) },
    });
    const route = await loadSource("../src/app/mcp/route.ts", {}, {
      "@/lib/bounded-json-body": boundedBody,
      "@/lib/shopkeeper-proxy": { proxyShopkeeperRequest: async () => {
        if (count++) return new Response('{"result":{}}');
        return new Response(new ReadableStream({
          start(value) { if (mode === "error") value.error(new Error("private upstream details")); },
          pull(value) { if (mode === "empty_flood") value.enqueue(new Uint8Array(0)); },
          cancel() { cancelled = true; },
        }, { highWaterMark: 0 }));
      } },
      "@/lib/scan-score-data": { getScanScoreSummaries: () => assert.fail("No scoring failed reads") },
    });
    const work = route.POST(new Request("http://dashboard.invalid/mcp", { method: "POST", body: "{}", signal: controller.signal }));
    if (mode === "abort") controller.abort();
    const response = await work;
    assert.equal(response.status, mode === "error" ? 502 : mode === "empty_flood" ? 413 : 504);
    assert.doesNotMatch(await response.text(), /private upstream details/);
    if (mode !== "error") assert.equal(cancelled, true);
    const first = await route.POST(mcpToolCall("get_scan"));
    const second = await route.POST(mcpToolCall("get_scan"));
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    await first.body.cancel(); await second.body.cancel();
  }
});

test("backend tool classification defeats duplicate and case-varied request keys", async () => {
  const largeBody = `{"jsonrpc":"2.0","id":9007199254740993,"result":{"structuredContent":{"detail":"${"x".repeat(5 * 1024 * 1024)}"}}}`;
  let pulls = 0;
  const upstream = new Response(new ReadableStream({
    pull(controller) {
      pulls++;
      controller.enqueue(new TextEncoder().encode(largeBody));
      controller.close();
    },
  }, { highWaterMark: 0 }), { headers: { "X-Lime-MCP-Transform": "none" } });
  const route = await loadSource("../src/app/mcp/route.ts", {}, {
    "@/lib/shopkeeper-proxy": { proxyShopkeeperRequest: async () => upstream },
    "@/lib/scan-score-data": { getScanScoreSummaries: () => assert.fail("Ordinary detail must not invoke scoring") },
  });
  const request = new Request("http://dashboard.invalid:3000/mcp", {
    method: "POST",
    body: '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_report","Name":"get_issue_detail","arguments":{}}}',
  });
  const result = await route.POST(request);
  assert.equal(result, upstream);
  assert.equal(pulls, 0, "A spoofed dashboard name must not materialize a detail result");
  assert.equal(await result.text(), largeBody);

  const marker = { jsonrpc: "2.0", id: 1, result: {
    isError: true,
    structuredContent: { requires_dashboard: true, operation: "get_report", arguments: { scan_id: "fixture-scan", format: "pdf" } },
  } };
  const calls = [];
  const reverseRoute = await loadSource("../src/app/mcp/route.ts", {}, {
    "@/lib/shopkeeper-proxy": { proxyShopkeeperRequest: async () => new Response(JSON.stringify(marker), { headers: { "X-Lime-MCP-Transform": "dashboard" } }) },
    "@/lib/scan-score-data": { getScanScoreSummaries: () => assert.fail("Report must not invoke scoring") },
    "@/lib/mcp-dashboard-tools": { runDashboardMcpTool: async (_request, name, args) => {
      calls.push([name, args]);
      return { structuredContent: { operation: name }, content: [{ type: "text", text: "fixture report" }] };
    } },
  });
  const reverseRequest = new Request("http://dashboard.invalid:3000/mcp", {
    method: "POST",
    body: '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_issue_detail","Name":"get_report","arguments":{}}}',
  });
  const transformed = await reverseRoute.POST(reverseRequest);
  assert.deepEqual(calls.map(([name, args]) => [name, JSON.parse(JSON.stringify(args))]), [["get_report", { scan_id: "fixture-scan", format: "pdf" }]]);
  assert.equal((await transformed.json()).result.structuredContent.operation, "get_report");
});

function deliveryTimers() {
  const deadlines = [];
  return {
    deadlines,
    setTimeout(callback, milliseconds) {
      assert.equal(milliseconds, 30_000);
      const timer = { callback, cleared: false };
      deadlines.push(timer);
      return timer;
    },
    clearTimeout(timer) { if (timer) timer.cleared = true; },
  };
}

async function loadArtifactRoute({ runTool, id = "9007199254740993", timers, transform = "dashboard", registered = true } = {}) {
  const delivery = await loadSource("../src/lib/mcp-artifact-delivery.ts", {
    ...timers, ...(registered ? { __limeMcpArtifactTransportBinding: () => {} } : {}),
  });
  const calls = [];
  const route = await loadSource("../src/app/mcp/route.ts", {}, {
    "@/lib/mcp-artifact-delivery": delivery,
    "@/lib/shopkeeper-proxy": { proxyShopkeeperRequest: async (request) => {
      const operation = (await request.json()).params.name;
      const marker = { isError: true, structuredContent: { requires_dashboard: true, operation, arguments: {} } };
      return new Response(`{"jsonrpc":"2.0","id":${id},"result":${JSON.stringify(marker)}}`, {
        headers: {
          "Content-Type": "application/json", "Content-Length": "1", "Content-Encoding": "identity",
          "Access-Control-Allow-Origin": "http://localhost:3002", "MCP-Protocol-Version": "2025-11-25",
          ...(transform ? { "X-Lime-MCP-Transform": transform } : {}),
        },
      });
    } },
    "@/lib/scan-score-data": { getScanScoreSummaries: () => assert.fail("Artifacts do not invoke scoring") },
    "@/lib/mcp-dashboard-tools": { runDashboardMcpTool: async (request, operation, args) => {
      calls.push(operation);
      return runTool ? runTool(request, operation, args) : { content: [{ type: "text", text: operation }] };
    } },
  });
  return { route, calls, delivery };
}

const loadTransportBinding = (delivery) => loadSource("../src/lib/mcp-artifact-transport.ts", {}, {
  "node:http": { ServerResponse },
  "./mcp-artifact-delivery": delivery,
});

async function loadBufferedRoute({ timers } = {}) {
  const delivery = await loadSource("../src/lib/mcp-artifact-delivery.ts", {
    ...timers, __limeMcpArtifactTransportBinding: () => {},
  });
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: "buffered", result: { text: "x".repeat(6 * 1024 * 1024) } }));
  const calls = [];
  const route = await loadSource("../src/app/mcp/route.ts", {}, {
    "@/lib/mcp-artifact-delivery": delivery,
    "@/lib/shopkeeper-proxy": { proxyShopkeeperRequest: async () => new Response(new ReadableStream({
      pull(controller) { calls.push("inspected"); controller.enqueue(body); controller.close(); },
    }, { highWaterMark: 0 })) },
    "@/lib/scan-score-data": { getScanScoreSummaries: () => assert.fail("No scoring opaque legacy data") },
  });
  return { route, calls, delivery };
}

test("lost legacy action delivery keeps outcome-unknown and original-request-ID guidance", async () => {
  const timers = deliveryTimers();
  const { route, calls } = await loadBufferedRoute({ timers });
  const response = await route.POST(mcpToolCall("create_scan"));
  assert.equal(calls.length, 1, "The backend has already returned its legacy action result");
  const reading = response.text();
  timers.deadlines[0].callback();
  await assert.rejects(reading, (error) => {
    assert.match(error.message, /check saved state.*original request_id/i);
    assert.doesNotMatch(error.message, /retry the tool/i);
    return true;
  });
});

test("missing transport registration rejects buffered tools before dashboard work starts", async () => {
  const { route, calls } = await loadArtifactRoute({ registered: false });
  for (const operation of ["get_report", "get_screenshot", "get_link_check_export", "update_settings"]) {
    const response = await route.POST(mcpToolCall(operation));
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /restart.*request_id/i);
  }
  assert.deepEqual(calls, []);
});

test("instrumentation registers transport binding only in the Node runtime", async () => {
  let registrations = 0;
  for (const runtime of ["nodejs", "edge", undefined]) {
    const instrumentation = await loadSource("../src/instrumentation.ts", { process: { env: { NEXT_RUNTIME: runtime } } }, {
      "./lib/mcp-artifact-transport": { registerMcpArtifactTransportBinding() { registrations++; } },
    });
    await instrumentation.register();
    assert.equal(registrations, 1);
  }
});

test("two unread full artifacts hold admission; overflow preserves raw ID and protocol/CORS headers", async () => {
  const image = Buffer.alloc(4 * 1024 * 1024, 1).toString("base64");
  const artifact = { content: [{ type: "image", mimeType: "image/png", data: image }] };
  const { route, calls } = await loadArtifactRoute({ runTool: async () => artifact });
  const first = await route.POST(mcpToolCall("get_screenshot"));
  const second = await route.POST(mcpToolCall("get_screenshot"));
  try {
    const rejected = await route.POST(mcpToolCall("get_screenshot"));
    assert.deepEqual(calls, ["get_screenshot", "get_screenshot"], "Reject before artifact generation or buffering");
    assert.equal(rejected.status, 200, "A busy tool stays a JSON-RPC tool result");
    const text = await rejected.text();
    assert.ok(text.includes('"id":9007199254740993'));
    const failure = JSON.parse(text).result;
    assert.equal(failure.isError, true);
    assert.equal(failure.structuredContent.http_status, 503);
    assert.equal(failure.structuredContent.retry_after_seconds, 1);
    assert.match(failure.content[0].text, /retry/i);
    for (const response of [first, rejected]) {
      assert.equal(response.headers.get("Access-Control-Allow-Origin"), "http://localhost:3002");
      assert.equal(response.headers.get("MCP-Protocol-Version"), "2025-11-25");
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.equal(response.headers.get("Content-Length"), null);
      assert.equal(response.headers.get("Content-Encoding"), null);
    }
    assert.equal(rejected.headers.get("Retry-After"), "1");
    assert.equal(await first.text(), `{"jsonrpc":"2.0","id":9007199254740993,"result":${JSON.stringify(artifact)}}`, "Chunking preserves every serialized byte");
    const replacement = await route.POST(mcpToolCall("get_screenshot"));
    assert.equal(calls.length, 3, "Reading to EOF releases the first permit");
    await replacement.body.cancel();
  } finally {
    await first.body.cancel().catch(() => {});
    await second.body.cancel();
  }
});

test("all three artifact operations share admission while update_settings bypasses it", async () => {
  let finish;
  let started;
  const pending = new Promise((resolve) => { finish = resolve; });
  const bothStarted = new Promise((resolve) => { started = resolve; });
  let count = 0;
  const { route, calls } = await loadArtifactRoute({ runTool: async (_request, operation) => {
    if (operation === "update_settings") return { content: [{ type: "text", text: "settings saved" }] };
    if (++count === 2) started();
    return pending;
  } });
  const first = route.POST(mcpToolCall("get_report"));
  const second = route.POST(mcpToolCall("get_screenshot"));
  await bothStarted;
  const rejected = await route.POST(mcpToolCall("get_link_check_export"));
  assert.equal((await rejected.json()).result.structuredContent.http_status, 503);
  const settings = await route.POST(mcpToolCall("update_settings"));
  assert.equal((await settings.json()).result.content[0].text, "settings saved");
  assert.deepEqual(calls, ["get_report", "get_screenshot", "update_settings"]);
  finish({ content: [{ type: "text", text: "artifact finished" }] });
  await Promise.all((await Promise.all([first, second])).map((response) => response.body.cancel()));
  const linkExport = await route.POST(mcpToolCall("get_link_check_export"));
  assert.equal((await linkExport.json()).result.content[0].text, "artifact finished");
});

test("artifact delivery preserves raw numeric, string and null JSON-RPC IDs", async () => {
  for (const id of ["0", "-0", "9007199254740993", "-9007199254740993", "1.234567890123456789e+40", '"client-id"', "null"]) {
    const { route } = await loadArtifactRoute({ id });
    assert.ok((await (await route.POST(mcpToolCall("get_report"))).text()).includes(`"id":${id}`));
  }
});

test("canonical method aliases and older-backend artifact markers retain their behavior", async () => {
  const { route } = await loadArtifactRoute({ transform: null });
  for (const method of ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "PUT"]) {
    assert.equal(route[method], route.POST);
    const request = new Request("http://dashboard.invalid:3000/mcp", {
      method,
      ...(method === "GET" || method === "HEAD" ? {} : { body: JSON.stringify({ params: { name: "get_report" } }) }),
    });
    // The fake dispatcher only needs the method here; a real non-POST result is
    // passed through before the canonical route parses or dispatches its body.
    request.json = async () => ({ params: { name: "get_report" } });
    const response = await route[method](request);
    assert.equal((await response.json()).result.structuredContent.requires_dashboard, true);
  }
  const response = await route.POST(mcpToolCall("get_report"));
  assert.equal((await response.json()).result.content[0].text, "get_report");
});

test("generation/serialization errors release admission, and caller abort cannot produce late success", async () => {
  let fail = true;
  const { route, delivery } = await loadArtifactRoute({ runTool: async () => {
    if (fail) throw new Error("fixture artifact failure");
    return { toJSON() { throw new Error("fixture serialization failure"); } };
  } });
  for (const failure of [/artifact failure/, /serialization failure/]) {
    await assert.rejects(route.POST(mcpToolCall("get_report")), failure);
    const first = delivery.mcpArtifactDeliveryLimiter.tryAcquire();
    const second = delivery.mcpArtifactDeliveryLimiter.tryAcquire();
    assert.equal(typeof first, "function");
    assert.equal(typeof second, "function");
    first(); second();
    fail = false;
  }

  let complete;
  let started;
  const pending = new Promise((resolve) => { complete = resolve; });
  const didStart = new Promise((resolve) => { started = resolve; });
  const abortedRoute = await loadArtifactRoute({ runTool: () => { started(); return pending; } });
  const controller = new AbortController();
  const request = new Request("http://dashboard.invalid:3000/mcp", {
    method: "POST", signal: controller.signal,
    body: JSON.stringify({ params: { name: "get_report" } }),
  });
  const work = abortedRoute.route.POST(request);
  await didStart;
  controller.abort();
  complete({ content: [{ type: "text", text: "late artifact success" }] });
  await assert.rejects(work, { name: "AbortError" });
  const release = abortedRoute.delivery.mcpArtifactDeliveryLimiter.tryAcquire();
  const other = abortedRoute.delivery.mcpArtifactDeliveryLimiter.tryAcquire();
  assert.equal(typeof release, "function");
  assert.equal(typeof other, "function");
  release(); other();
});

for (const ending of ["eof", "cancel", "abort", "error", "timeout"]) {
  test(`artifact delivery ${ending} cancels/releases ownership once and clears its deadline/listener`, async () => {
    const timers = deliveryTimers();
    const { McpArtifactDeliveryLimiter, retainMcpArtifactDelivery } = await loadSource("../src/lib/mcp-artifact-delivery.ts", timers);
    const limiter = new McpArtifactDeliveryLimiter();
    const other = limiter.tryAcquire();
    const release = limiter.tryAcquire();
    let releases = 0;
    let cancelled = 0;
    let source;
    const payload = new Uint8Array(130 * 1024).fill(3);
    const body = new ReadableStream({
      start(controller) {
        source = controller;
        if (ending === "eof" || ending === "timeout") controller.enqueue(payload);
        if (ending === "eof") controller.close();
      },
      cancel() { cancelled += 1; },
    }, { highWaterMark: 0 });
    const caller = new AbortController();
    const listeners = new Set();
    const signal = {
      get aborted() { return caller.signal.aborted; },
      addEventListener(...args) { listeners.add(args[1]); caller.signal.addEventListener(...args); },
      removeEventListener(...args) { listeners.delete(args[1]); caller.signal.removeEventListener(...args); },
    };
    const response = retainMcpArtifactDelivery(new Response(body), () => { releases++; release(); }, signal);
    assert.equal(limiter.tryAcquire(), undefined);
    if (ending === "eof") {
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()), payload);
    } else if (ending === "cancel") {
      await response.body.cancel();
    } else if (ending === "abort" || ending === "error") {
      const reading = response.text();
      await Promise.resolve();
      if (ending === "abort") caller.abort(new Error("private disconnect reason"));
      else source.error(new Error("private stream internals"));
      await assert.rejects(reading, /MCP response|deliver MCP response/);
    } else {
      const reader = response.body.getReader();
      const first = await reader.read();
      assert.equal(first.value.byteLength, 64 * 1024);
      assert.equal(first.value.buffer.byteLength, 64 * 1024, "Socket chunks must not share the full serialized backing buffer");
      timers.deadlines[0].callback();
      await assert.rejects(reader.read(), /timed out/);
      reader.releaseLock();
    }
    assert.equal(body.locked, false);
    assert.equal(cancelled, ["eof", "error"].includes(ending) ? 0 : 1);
    assert.equal(releases, 1);
    assert.equal(listeners.size, 0);
    assert.equal(timers.deadlines[0].cleared, true);
    timers.deadlines[0].callback();
    caller.abort();
    assert.equal(releases, 1);
    const replacement = limiter.tryAcquire();
    assert.equal(typeof replacement, "function");
    assert.equal(limiter.tryAcquire(), undefined, "Repeated cleanup must not release another request's slot");
    replacement(); other();
  });
}

test("already-aborted artifact delivery is unreadable and immediately frees its slot", async () => {
  const timers = deliveryTimers();
  const { McpArtifactDeliveryLimiter, retainMcpArtifactDelivery } = await loadSource("../src/lib/mcp-artifact-delivery.ts", timers);
  const limiter = new McpArtifactDeliveryLimiter();
  const caller = new AbortController();
  caller.abort();
  const response = retainMcpArtifactDelivery(new Response("late success"), limiter.tryAcquire(), caller.signal);
  await assert.rejects(response.text(), /disconnected/);
  const first = limiter.tryAcquire();
  const second = limiter.tryAcquire();
  assert.equal(typeof first, "function");
  assert.equal(typeof second, "function");
  first(); second();
  assert.equal(timers.deadlines[0].cleared, true);
});

for (const inspection of [false, true]) test(`Next socket delivery destroys paused ${inspection ? "inspection" : "artifact"} output before freeing admission`, async () => {
  const { NextRequestAdapter, signalFromNodeResponse } = require("next/dist/server/web/spec-extension/adapters/next-request");
  const { NodeNextRequest, NodeNextResponse } = require("next/dist/server/base-http/node");
  const { sendResponse } = require("next/dist/server/send-response");
  const timers = deliveryTimers();
  const image = Buffer.alloc(4 * 1024 * 1024, 2).toString("base64");
  const { route, calls, delivery } = inspection ? await loadBufferedRoute({ timers })
    : await loadArtifactRoute({ timers, runTool: async () => ({ content: [{ type: "image", mimeType: "image/png", data: image }] }) });
  const binding = await loadTransportBinding(delivery);
  const unregister = binding.registerMcpArtifactTransportBinding();
  assert.equal(binding.registerMcpArtifactTransportBinding(), unregister, "Startup registration is idempotent");
  const sends = [];
  let outgoingResponse;
  let writeStarted;
  const writing = new Promise((resolve) => { writeStarted = resolve; });
  const server = createServer((incoming, outgoing) => {
    outgoingResponse = outgoing;
    const write = outgoing.write;
    outgoing.write = function (...args) {
      const ready = write.apply(this, args);
      writeStarted();
      return ready;
    };
    sends.push((async () => {
      const nextRequest = new NodeNextRequest(incoming);
      const request = NextRequestAdapter.fromNodeNextRequest(nextRequest, signalFromNodeResponse(outgoing));
      const response = await route.POST(request);
      await sendResponse(nextRequest, new NodeNextResponse(outgoing), response);
    })().catch((error) => outgoing.destroy(error)));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const socket = connect({ port: server.address().port, host: "127.0.0.1", highWaterMark: 1 });
  socket.on("error", () => {});
  socket.pause();
  let second;
  let replacement;
  let timeout;
  try {
    await once(socket, "connect");
    const body = JSON.stringify({ params: { name: "get_screenshot" } });
    socket.write(`POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    await Promise.race([
      writing,
      new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("Artifact socket send did not start")), 2_000); }),
    ]);
    clearTimeout(timeout);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(outgoingResponse.writableFinished, false, "The full encoded artifact exceeds the paused socket's buffers");
    assert.equal(timers.deadlines[0].cleared, false, "Next must not read ahead through EOF while its write is blocked");
    second = await route.POST(mcpToolCall("get_report"));
    const rejected = await route.POST(mcpToolCall("get_link_check_export"));
    if (inspection) assert.equal(rejected.status, 503);
    else assert.equal((await rejected.json()).result.structuredContent.http_status, 503);
    assert.equal(calls.length, 2);
    assert.ok(!outgoingResponse.getHeader(delivery.MCP_ARTIFACT_LEASE_HEADER));
    assert.ok(!outgoingResponse._header.includes(delivery.MCP_ARTIFACT_LEASE_HEADER), "The private binding token never reaches the wire");
    const serverSocket = outgoingResponse.socket;
    const closed = once(serverSocket, "close");
    timers.deadlines[0].callback();
    assert.equal(serverSocket.destroyed, true);
    assert.equal(outgoingResponse.destroyed, true);
    const limiter = inspection ? delivery.mcpResponseInspectionLimiter : delivery.mcpArtifactDeliveryLimiter;
    assert.equal(limiter.tryAcquire(), undefined, "Keep admission until the bound socket actually closes");
    await closed;
    assert.equal(timers.deadlines[0].cleared, true);
    assert.equal(serverSocket.writableLength, 0, "The blocked writable is disposed on the deadline");
    replacement = await route.POST(mcpToolCall("get_screenshot"));
    assert.equal(calls.length, 3, "The delivery deadline frees admission even while the peer remains paused");
  } finally {
    clearTimeout(timeout);
    await second?.body.cancel();
    await replacement?.body.cancel();
    socket.destroy();
    server.closeAllConnections();
    await Promise.allSettled(sends);
    await new Promise((resolve) => server.close(resolve));
    unregister();
  }
});

test("repeated Next blocked-drain deadlines close every bound ServerResponse before replacement", async () => {
  const { NodeNextRequest, NodeNextResponse } = require("next/dist/server/base-http/node");
  const { sendResponse } = require("next/dist/server/send-response");
  const timers = deliveryTimers();
  const image = Buffer.alloc(4 * 1024 * 1024, 4).toString("base64");
  const { route, delivery } = await loadArtifactRoute({ timers, runTool: async () => ({ content: [{ type: "image", mimeType: "image/png", data: image }] }) });
  const { registerMcpArtifactTransportBinding } = await loadTransportBinding(delivery);
  const unregister = registerMcpArtifactTransportBinding();
  const sockets = [];
  try {
    for (let epoch = 0; epoch < 4; epoch++) {
      const sends = [];
      for (let slot = 0; slot < 2; slot++) {
        let pendingWrite;
        const socket = new Duplex({
          read() {},
          write(_chunk, _encoding, callback) { pendingWrite = callback; },
          destroy(error, callback) { pendingWrite?.(error ?? new Error("fixture socket destroyed")); callback(error); },
        });
        socket.on("error", () => {});
        sockets.push(socket);
        const request = new IncomingMessage(socket);
        request.method = "POST";
        request.url = epoch % 2 ? "/mcp/" : "/%6dcp";
        const response = new ServerResponse(request);
        response.assignSocket(socket);
        const result = await route.POST(mcpToolCall("get_screenshot"));
        assert.equal(delivery.mcpArtifactTransportLeases.size, slot + 1, "The canonical route creates its private transport lease before piping");
        sends.push(sendResponse(new NodeNextRequest(request), new NodeNextResponse(response), result).catch((error) => {
          assert.match(error.cause?.message ?? error.message, /MCP response/);
        }));
      }
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(delivery.mcpArtifactTransportLeases.size, 2, JSON.stringify(sockets.map((socket) => ({ destroyed: socket.destroyed, closed: socket.closed, errored: socket.errored?.message, writable: socket.writableLength }))));
      assert.equal(delivery.mcpArtifactDeliveryLimiter.tryAcquire(), undefined);
      const current = sockets.slice(-2);
      assert.ok(current.every((socket) => socket.writableLength > 0));
      const closed = current.map((socket) => once(socket, "close"));
      for (const timer of timers.deadlines.slice(-2)) timer.callback();
      assert.ok(current.every((socket) => socket.destroyed));
      assert.equal(delivery.mcpArtifactDeliveryLimiter.tryAcquire(), undefined, "A destroy call alone cannot release admission");
      await Promise.all(closed);
      await Promise.all(sends);
      assert.equal(delivery.mcpArtifactTransportLeases.size, 0);
      assert.ok(sockets.every((socket) => socket.closed && socket.writableLength === 0), "No stale socket writable survives an earlier timeout epoch");
      assert.ok(timers.deadlines.every((timer) => timer.cleared));
    }
  } finally {
    for (const socket of sockets) socket.destroy();
    unregister();
  }
});

test("a queued pipelined response destroys its request socket even without response.socket", async () => {
  const { NodeNextRequest, NodeNextResponse } = require("next/dist/server/base-http/node");
  const { sendResponse } = require("next/dist/server/send-response");
  const timers = deliveryTimers();
  const image = Buffer.alloc(4 * 1024 * 1024, 5).toString("base64");
  const { route, delivery } = await loadArtifactRoute({ timers, runTool: async () => ({ content: [{ type: "image", mimeType: "image/png", data: image }] }) });
  const { registerMcpArtifactTransportBinding } = await loadTransportBinding(delivery);
  const unregister = registerMcpArtifactTransportBinding();
  let pendingWrite;
  const socket = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) { pendingWrite = callback; },
    destroy(error, callback) { pendingWrite?.(error ?? new Error("fixture socket destroyed")); callback(error); },
  });
  socket.on("error", () => {});
  const sends = [];
  try {
    const responses = [];
    for (let index = 0; index < 2; index++) {
      const request = new IncomingMessage(socket);
      request.method = "POST";
      request.url = "/mcp";
      const response = new ServerResponse(request);
      if (index === 0) response.assignSocket(socket);
      responses.push(response);
      const result = await route.POST(mcpToolCall("get_report"));
      sends.push(sendResponse(new NodeNextRequest(request), new NodeNextResponse(response), result).catch((error) => {
        assert.match(error.cause?.message ?? error.message, /MCP response/);
      }));
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(responses[1].socket, null);
    assert.equal(delivery.mcpArtifactTransportLeases.size, 2);
    assert.ok(responses[1].writableLength > 0, "The pipelined response is queued behind the first response");
    const closed = once(socket, "close");
    timers.deadlines[1].callback();
    assert.equal(socket.destroyed, true, "Destroy the exact underlying socket retained by the incoming request");
    assert.equal(delivery.mcpArtifactDeliveryLimiter.tryAcquire(), undefined);
    await closed;
    await Promise.all(sends);
    assert.equal(delivery.mcpArtifactTransportLeases.size, 0);
    assert.ok(responses.every((response) => response.destroyed));
    assert.equal(socket.writableLength, 0);
    assert.ok(timers.deadlines.every((timer) => timer.cleared));
  } finally {
    socket.destroy();
    await Promise.allSettled(sends);
    unregister();
  }
});

test("transport registration also binds Node responses constructed before startup completed", async () => {
  const { NodeNextRequest, NodeNextResponse } = require("next/dist/server/base-http/node");
  const { sendResponse } = require("next/dist/server/send-response");
  const timers = deliveryTimers();
  const { route, delivery } = await loadArtifactRoute({ timers, runTool: async () => ({ content: [{ type: "text", text: "x".repeat(1024 * 1024) }] }) });
  let pendingWrite;
  const socket = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) { pendingWrite = callback; },
    destroy(error, callback) { pendingWrite?.(error ?? new Error("fixture socket destroyed")); callback(error); },
  });
  socket.on("error", () => {});
  const request = new IncomingMessage(socket);
  request.method = "POST";
  request.url = "/mcp";
  const response = new ServerResponse(request);
  response.assignSocket(socket);
  const { registerMcpArtifactTransportBinding } = await loadTransportBinding(delivery);
  const unregister = registerMcpArtifactTransportBinding();
  let sending;
  try {
    const result = await route.POST(mcpToolCall("get_report"));
    sending = sendResponse(new NodeNextRequest(request), new NodeNextResponse(response), result).catch((error) => {
      assert.match(error.cause?.message ?? error.message, /MCP response/);
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(delivery.mcpArtifactTransportLeases.size, 1);
    assert.ok(socket.writableLength > 0);
    const closed = once(socket, "close");
    timers.deadlines[0].callback();
    assert.equal(socket.destroyed, true);
    await closed;
    await sending;
    assert.equal(delivery.mcpArtifactTransportLeases.size, 0);
    assert.equal(socket.writableLength, 0);
  } finally {
    socket.destroy();
    await sending;
    unregister();
  }
});

test("a normally drained Next artifact holds admission through Node response finish", async () => {
  const { NodeNextRequest, NodeNextResponse } = require("next/dist/server/base-http/node");
  const { sendResponse } = require("next/dist/server/send-response");
  const timers = deliveryTimers();
  const { route, delivery } = await loadArtifactRoute({ timers });
  const { registerMcpArtifactTransportBinding } = await loadTransportBinding(delivery);
  const unregister = registerMcpArtifactTransportBinding();
  const socket = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } });
  const request = new IncomingMessage(socket);
  request.method = "POST";
  request.url = "/mcp";
  const response = new ServerResponse(request);
  response.assignSocket(socket);
  const other = delivery.mcpArtifactDeliveryLimiter.tryAcquire();
  let finished = false;
  response.prependOnceListener("finish", () => {
    finished = true;
    assert.equal(delivery.mcpArtifactDeliveryLimiter.tryAcquire(), undefined, "Web body EOF must not free a bound transport before Node finishes");
  });
  try {
    const result = await route.POST(mcpToolCall("get_report"));
    await sendResponse(new NodeNextRequest(request), new NodeNextResponse(response), result);
    assert.equal(finished, true);
    assert.equal(delivery.mcpArtifactTransportLeases.size, 0);
    assert.equal(timers.deadlines[0].cleared, true);
    const replacement = delivery.mcpArtifactDeliveryLimiter.tryAcquire();
    assert.equal(typeof replacement, "function");
    replacement();
  } finally {
    other();
    socket.destroy();
    unregister();
  }
});

test("transport binding preserves ordinary writeHead calls and ignores spoofed request headers", async () => {
  const delivery = await loadSource("../src/lib/mcp-artifact-delivery.ts");
  const { registerMcpArtifactTransportBinding } = await loadTransportBinding(delivery);
  const original = ServerResponse.prototype.writeHead;
  const unregister = registerMcpArtifactTransportBinding();
  const socket = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } });
  const request = new IncomingMessage(socket);
  request.headers[delivery.MCP_ARTIFACT_LEASE_HEADER] = "attacker-supplied";
  const response = new ServerResponse(request);
  try {
    response.writeHead(202, "Fixture Accepted", { "X-Ordinary": "kept" });
    assert.equal(response.destroyed, false);
    assert.equal(socket.destroyed, false);
    assert.equal(response.statusCode, 202);
    assert.equal(response.statusMessage, "Fixture Accepted");
    assert.match(response._header, /X-Ordinary: kept/);
    assert.ok(!response._header.includes(delivery.MCP_ARTIFACT_LEASE_HEADER));
    assert.equal(delivery.mcpArtifactTransportLeases.size, 0);
  } finally {
    socket.destroy();
    response.destroy();
    unregister();
    assert.equal(ServerResponse.prototype.writeHead, original);
  }
});

test("private lease headers supplied directly to writeHead are stripped and expired tokens close the socket", async () => {
  const timers = deliveryTimers();
  const delivery = await loadSource("../src/lib/mcp-artifact-delivery.ts", timers);
  const { registerMcpArtifactTransportBinding } = await loadTransportBinding(delivery);
  const unregister = registerMcpArtifactTransportBinding();
  try {
    for (const form of ["object", "status-message", "array", "expired"]) {
      const socket = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } });
      const request = new IncomingMessage(socket);
      const response = new ServerResponse(request);
      const release = delivery.mcpArtifactDeliveryLimiter.tryAcquire();
      const result = delivery.retainMcpArtifactDelivery(new Response("artifact"), release, new AbortController().signal);
      const token = result.headers.get(delivery.MCP_ARTIFACT_LEASE_HEADER);
      const closed = once(socket, "close");
      if (form === "expired") {
        await result.body.cancel();
        response.setHeader(delivery.MCP_ARTIFACT_LEASE_HEADER, token);
        response.flushHeaders();
        assert.equal(socket.destroyed, true, "An expired lease cannot start a late artifact transport");
      } else {
        const headers = { "X-Lime-MCP-Artifact-Lease": token, "X-Ordinary": "kept" };
        if (form === "object") response.writeHead(200, headers);
        else if (form === "status-message") response.writeHead(200, "OK", headers);
        else response.writeHead(200, Object.entries(headers).flat());
        assert.equal(delivery.mcpArtifactTransportLeases.size, 1);
        assert.ok(!response._header.toLowerCase().includes(delivery.MCP_ARTIFACT_LEASE_HEADER));
        assert.match(response._header, /X-Ordinary: kept/);
        timers.deadlines.at(-1).callback();
      }
      await closed;
      assert.equal(delivery.mcpArtifactTransportLeases.size, 0);
      assert.equal(response.destroyed, true);
    }
  } finally {
    unregister();
  }
});
