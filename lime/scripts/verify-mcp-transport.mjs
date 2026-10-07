import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
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
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports, URL, Headers, Response, Request, AbortSignal, Buffer, JSON, Date,
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
    const result = await route.POST({ method: "POST", signal: new AbortController().signal });
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
    const result = await route.POST({ method: "POST", signal: new AbortController().signal });
    assert.equal(result.status, status);
    assert.equal(result.headers.get("WWW-Authenticate"), "Bearer");
    assert.equal(result.headers.get("Allow"), "POST");
    assert.equal(await result.text(), status === 202 ? "" : "upstream error");
  }
});

test("canonical Link Checker reads pass through unchanged without accessibility scoring", async () => {
  const check = { id: "fixture-check", scan_id: null, summary: { broken: 1 }, truncated: true };
  const payloads = [
    { checks: [check], total: 1, limit: 20, offset: 0, has_more: false },
    { check, dashboard_path: "/links/fixture-check", csv_path: "/api/link-checks/fixture-check/export.csv", paths_relative_to: "dashboard_origin" },
    { stats: { total_checks: 1, broken_links: 1 } },
    { scan_id: "fixture-scan", include_link_check: false, check: null, dashboard_path: null, csv_path: null, paths_relative_to: "dashboard_origin" },
    { results: [{ id: "fixture-result", status: "broken", status_code: 999 }], total: 1, limit: 20, offset: 0, has_more: false },
    { sources: [{ page_url: "https://example.invalid/", element: "a", attribute: "href", text: "Untrusted captured text" }], total: 1, limit: 20, offset: 0, has_more: false },
  ];
  for (const data of payloads) {
    const body = `{"jsonrpc":"2.0","id":9007199254740993,"result":${JSON.stringify({ structuredContent: data, content: [{ type: "text", text: JSON.stringify(data) }] })}}`;
    const route = await loadSource("../src/app/mcp/route.ts", {}, {
      "@/lib/shopkeeper-proxy": { proxyShopkeeperRequest: async () => new Response(body, { headers: { "Access-Control-Allow-Origin": "http://localhost:3002", "Cache-Control": "no-store" } }) },
      "@/lib/scan-score-data": { getScanScoreSummaries: () => assert.fail("Link data must not invoke the accessibility scorer") },
    });
    const result = await route.POST({ method: "POST", signal: new AbortController().signal });
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
  const result = await route.POST({ method: "POST", signal: new AbortController().signal });
  const text = await result.text();
  assert.ok(text.includes('"id":9007199254740993'));
  assert.ok(!text.includes("private SQL internals"));
  assert.equal(JSON.parse(text).result.isError, true);
  assert.equal(result.headers.get("Access-Control-Allow-Origin"), "http://localhost:3002");
});
