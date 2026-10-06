import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(new URL("../package.json", import.meta.url));
const ts = require("typescript");
const scanId = "00000000-0000-4000-8000-000000000001";
const issueId = "00000000-0000-4000-8000-000000000002";
const checkId = "00000000-0000-4000-8000-000000000003";

class ArtifactRequest extends Request {
  constructor(input, options) {
    super(input, options);
    this.nextUrl = new URL(input);
  }
}

// Run the actual implementation, mocking only service boundaries. No app
// instance, real credentials, local config, browser or database is modified.
async function loadTool(overrides = {}, globals = {}) {
  const calls = [];
  const handlers = {
    auth: async (authorization) => { calls.push(["auth", authorization]); },
    save: async (patch, authorization) => { calls.push(["save", patch, authorization]); return { reporting: patch.reporting, performance: patch.performance }; },
    pdf: async (request, context) => { calls.push(["pdf", request.nextUrl.href, await context.params]); return new Response("%PDF-1.4 fixture", { headers: { "Content-Type": "application/pdf" } }); },
    csv: async (request, context) => { calls.push(["csv", request.nextUrl.href, await context.params]); return new Response("item_type,rule_id\nfailed,label\n", { headers: { "Content-Type": "text/csv; charset=utf-8" } }); },
    llm: async (request, context) => { calls.push(["llm", request.nextUrl.href, await context.params]); return new Response("label: input needs a name", { headers: { "Content-Type": "text/plain" } }); },
    proxy: async (request, options) => { calls.push(["proxy", request.nextUrl.href, options]); return new Response("fixture image bytes", { headers: { "Content-Type": "image/png" } }); },
    issueRows: [{ id: issueId }],
    ...overrides,
  };
  const selected = {
    from: (table) => { calls.push(["from", table]); return selected; },
    where: (filter) => { calls.push(["where", filter]); return selected; },
    limit: async (limit) => { calls.push(["limit", limit]); return handlers.issueRows; },
  };
  const dependencies = {
    "node:crypto": { createHash },
    "drizzle-orm": { and: (...filters) => filters, eq: (field, value) => [field, value] },
    "next/server": { NextRequest: ArtifactRequest },
    "@/db": { db: { select: (projection) => { calls.push(["select", projection]); return selected; } } },
    "@/db/schema": { issues: { id: "issue.id", scanId: "issue.scanId", violationType: "issue.violationType" } },
    "@/app/api/scans/[id]/issues/report.pdf/route": { GET: handlers.pdf },
    "@/app/api/scans/[id]/issues/report.csv/route": { GET: handlers.csv },
    "@/app/api/scans/[id]/issues/report.llm.txt/route": { GET: handlers.llm },
    "@/lib/report-settings": { requireMcpAccess: handlers.auth, saveSystemSettings: handlers.save },
    "@/lib/shopkeeper-proxy": { proxyShopkeeperRequest: handlers.proxy },
  };
  const source = await readFile(new URL("../src/lib/mcp-dashboard-tools.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports, URL, URLSearchParams, Headers, Response, Request, AbortSignal, AbortController, Buffer, JSON, Uint8Array,
    require: (name) => { assert.ok(name in dependencies, `Unexpected dependency: ${name}`); return dependencies[name]; },
    ...globals,
  });
  const request = (signal) => new ArtifactRequest("http://dashboard.test:14000/mcp", { headers: { Authorization: "Bearer controlled-test-key" }, signal });
  return { ...exports, calls, request };
}

function metadata(result) {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  assert.deepEqual(JSON.parse(result.content[0].text), JSON.parse(JSON.stringify(result.structuredContent)), "Text metadata and structured results match");
  assert.equal(result.structuredContent.untrusted_content, true);
  return result.structuredContent;
}

test("full PDF returns real embedded content, bounded metadata and an evidence warning", async () => {
  const tool = await loadTool();
  const result = await tool.runDashboardMcpTool(tool.request(), "get_report", { scan_id: scanId, format: "pdf" });
  const data = metadata(result);
  const artifact = result.content.find((item) => item.type === "resource").resource;
  assert.equal(artifact.mimeType, "application/pdf");
  assert.equal(Buffer.from(artifact.blob, "base64").toString(), "%PDF-1.4 fixture");
  assert.equal(data.byte_count, Buffer.byteLength("%PDF-1.4 fixture"));
  assert.equal(data.sha256, createHash("sha256").update("%PDF-1.4 fixture").digest("hex"));
  assert.equal(data.download_path, `/api/scans/${scanId}/issues/report.pdf`);
  assert.ok(tool.calls.some(([name]) => name === "auth"));
});

test("small/full CSV and LLM use canonical existing handlers and actual text", async () => {
  const tool = await loadTool();
  for (const [format, args, expected] of [["csv", {}, "mode=small"], ["csv", { csv_mode: "full" }, "mode=full"], ["llm", {}, "report.llm"]]) {
    const result = await tool.runDashboardMcpTool(tool.request(), "get_report", { scan_id: scanId, format, ...args });
    assert.ok(metadata(result).download_path.includes(expected));
    assert.match(result.content[1].text, /label/);
    assert.ok(tool.calls.some(([name]) => name === format));
  }
});

test("scoped issue report verifies ownership using both issue UUID and scan UUID", async () => {
  const tool = await loadTool();
  for (const format of ["pdf", "csv", "llm"]) {
    const result = await tool.runDashboardMcpTool(tool.request(), "get_report", { scan_id: scanId, format, issue_id: issueId });
    assert.ok(metadata(result).download_path.includes(`kind=failed&key=${issueId}`));
  }
  const filters = tool.calls.find(([name]) => name === "where")[1];
  assert.deepEqual(JSON.parse(JSON.stringify(filters)), [["issue.id", issueId], ["issue.scanId", scanId]]);
});

test("unknown/cross-scan issue never invokes a report handler", async () => {
  const tool = await loadTool({ issueRows: [] });
  const result = await tool.runDashboardMcpTool(tool.request(), "get_report", { scan_id: scanId, format: "pdf", issue_id: issueId });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Issue not found/);
  assert.ok(!tool.calls.some(([name]) => name === "pdf"));
});

test("needs-review scope preserves native kind/key query and quoting", async () => {
  const tool = await loadTool();
  const result = await tool.runDashboardMcpTool(tool.request(), "get_report", { scan_id: scanId, format: "csv", kind: "needs_review", key: "color-contrast" });
  assert.ok(metadata(result).download_path.endsWith("?kind=needs_review&key=color-contrast&mode=small"));
  assert.ok(!tool.calls.some(([name]) => name === "select"));
});

test("screenshot returns exactly the saved image bytes and never fetches an arbitrary URL", async () => {
  const tool = await loadTool();
  const result = await tool.runDashboardMcpTool(tool.request(), "get_screenshot", { scan_id: scanId, filename: "element_1.png" });
  assert.equal(metadata(result).download_path, `/api/screenshots/${scanId}/element_1.png`);
  const image = result.content.find((item) => item.type === "image");
  assert.equal(image.mimeType, "image/png");
  assert.equal(Buffer.from(image.data, "base64").toString(), "fixture image bytes");
  assert.equal(tool.calls.find(([name]) => name === "proxy")[1], `http://dashboard.test:14000/api/screenshots/${scanId}/element_1.png`);
});

test("unsupported screenshot MIME is rejected without returning fake image data", async () => {
  const tool = await loadTool({ proxy: async () => new Response("not an image", { headers: { "Content-Type": "text/html" } }) });
  const result = await tool.runDashboardMcpTool(tool.request(), "get_screenshot", { scan_id: scanId, filename: "element_1.png" });
  assert.equal(result.isError, true);
  assert.ok(!result.content.some((item) => item.type === "image"));
});

test("wrong report/export MIME, empty artifacts and invalid PDF magic never report success", async () => {
  for (const [operation, args, overrides] of [
    ["get_report", { scan_id: scanId, format: "pdf" }, { pdf: async () => new Response("%PDF-1.4 text", { headers: { "Content-Type": "text/html" } }) }],
    ["get_report", { scan_id: scanId, format: "pdf" }, { pdf: async () => new Response("invalid magic", { headers: { "Content-Type": "application/pdf" } }) }],
    ["get_report", { scan_id: scanId, format: "csv" }, { csv: async () => new Response("", { headers: { "Content-Type": "text/csv" } }) }],
    ["get_report", { scan_id: scanId, format: "llm" }, { llm: async () => new Response("<html>not evidence</html>", { headers: { "Content-Type": "text/html" } }) }],
    ["get_link_check_export", { check_id: checkId }, { proxy: async () => new Response("not CSV", { headers: { "Content-Type": "application/json" } }) }],
    ["get_screenshot", { scan_id: scanId, filename: "empty.png" }, { proxy: async () => new Response("", { headers: { "Content-Type": "image/png" } }) }],
  ]) {
    const tool = await loadTool(overrides);
    const result = await tool.runDashboardMcpTool(tool.request(), operation, args);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /empty|unexpected format/i);
    assert.ok(result.structuredContent.download_path);
  }
});

test("link CSV export is actual bounded saved text and origin-relative metadata", async () => {
  const tool = await loadTool({ proxy: async () => new Response("target_url,status\nhttps://fixture.test/,healthy\n", { headers: { "Content-Type": "text/csv" } }) });
  const result = await tool.runDashboardMcpTool(tool.request(), "get_link_check_export", { check_id: checkId });
  assert.equal(metadata(result).download_path, `/api/link-checks/${checkId}/export.csv`);
  assert.match(result.content[1].text, /fixture\.test/);
});

test("HTTP failure does not leak private upstream error body or pretend success", async () => {
  const tool = await loadTool({ pdf: async () => new Response("SQLSTATE private-database-path", { status: 403 }) });
  const result = await tool.runDashboardMcpTool(tool.request(), "get_report", { scan_id: scanId, format: "pdf" });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.http_status, 403);
  assert.doesNotMatch(JSON.stringify(result), /SQLSTATE|private-database-path/);
});

test("over-4-MiB streamed artifact is cancelled and gives a safe complete-download fallback", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); },
    cancel() { cancelled = true; },
  });
  const tool = await loadTool({ pdf: async () => new Response(body, { headers: { "Content-Type": "application/pdf" } }) });
  const result = await tool.runDashboardMcpTool(tool.request(), "get_report", { scan_id: scanId, format: "pdf" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /4 MiB/);
  assert.equal(result.structuredContent.download_path, `/api/scans/${scanId}/issues/report.pdf`);
  assert.equal(cancelled, true);
});

test("artifact exactly at the bound succeeds without truncation", async () => {
  const bytes = new Uint8Array(4 * 1024 * 1024).fill(32);
  const tool = await loadTool({ csv: async () => new Response(bytes, { headers: { "Content-Type": "text/csv" } }) });
  const result = await tool.runDashboardMcpTool(tool.request(), "get_report", { scan_id: scanId, format: "csv" });
  assert.equal(metadata(result).byte_count, bytes.length);
  assert.equal(result.content[1].text.length, bytes.length);
});

test("client cancellation stops a stalled body and hides internal abort details", async () => {
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const controller = new AbortController();
  const tool = await loadTool({ pdf: async () => new Response(body, { headers: { "Content-Type": "application/pdf" } }) });
  const work = tool.runDashboardMcpTool(tool.request(controller.signal), "get_report", { scan_id: scanId, format: "pdf" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort(new Error("private cancellation reason"));
  const result = await work;
  assert.equal(result.isError, true);
  assert.equal(cancelled, true);
  assert.doesNotMatch(JSON.stringify(result), /private cancellation reason/);
});

test("30-second artifact deadline also bounds stalled body reads", async () => {
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const tool = await loadTool({ pdf: async () => new Response(body, { headers: { "Content-Type": "application/pdf" } }) }, {
    AbortSignal: { any: AbortSignal.any, timeout: (timeout) => { assert.equal(timeout, 30_000); return AbortSignal.timeout(20); } },
  });
  const keepAlive = setTimeout(() => {}, 500);
  try {
    const result = await tool.runDashboardMcpTool(tool.request(), "get_report", { scan_id: scanId, format: "pdf" });
    assert.equal(result.isError, true);
    assert.equal(cancelled, true);
  } finally { clearTimeout(keepAlive); }
});

test("the same artifact deadline bounds stalled authorization, report queues and scoped DB reads", async () => {
  for (const [overrides, args] of [
    [{ auth: () => new Promise(() => {}) }, { scan_id: scanId, format: "pdf" }],
    [{ pdf: () => new Promise(() => {}) }, { scan_id: scanId, format: "pdf" }],
    [{ issueRows: new Promise(() => {}) }, { scan_id: scanId, format: "pdf", issue_id: issueId }],
  ]) {
    const tool = await loadTool(overrides, { AbortSignal: { any: AbortSignal.any, timeout: () => AbortSignal.timeout(20) } });
    const keepAlive = setTimeout(() => {}, 500);
    try {
      const result = await tool.runDashboardMcpTool(tool.request(), "get_report", args);
      assert.equal(result.isError, true);
      assert.ok(!result.content.some((item) => item.type === "resource"));
    } finally { clearTimeout(keepAlive); }
  }
});

test("a queued handler response arriving after the deadline has its late body cancelled", async () => {
  let cancelled = false;
  let release;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const lateResponse = new Promise((resolve) => { release = resolve; });
  const tool = await loadTool({ pdf: () => lateResponse }, { AbortSignal: { any: AbortSignal.any, timeout: () => AbortSignal.timeout(20) } });
  const keepAlive = setTimeout(() => {}, 500);
  try {
    const result = await tool.runDashboardMcpTool(tool.request(), "get_report", { scan_id: scanId, format: "pdf" });
    assert.equal(result.isError, true);
    release(new Response(body, { headers: { "Content-Type": "application/pdf" } }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(cancelled, true);
  } finally { clearTimeout(keepAlive); }
});

test("revoked auth prevents all report, proxy, database and setting work", async () => {
  const tool = await loadTool({ auth: async () => { throw new Error("private key-hash details"); } });
  for (const [operation, args] of [["get_report", { scan_id: scanId, format: "pdf" }], ["get_screenshot", { scan_id: scanId, filename: "element.png" }], ["get_link_check_export", { check_id: checkId }], ["update_settings", { confirm: true, small_csv_occurrence_limit: 2 }]]) {
    const result = await tool.runDashboardMcpTool(tool.request(), operation, args);
    assert.equal(result.isError, true);
    assert.doesNotMatch(JSON.stringify(result), /private key-hash details/);
  }
  assert.deepEqual(tool.calls, []);
});

test("setting update allowlists reporting/performance fields and forwards auth for locked recheck", async () => {
  const tool = await loadTool();
  const result = await tool.runDashboardMcpTool(tool.request(), "update_settings", {
    confirm: true, full_pdf_occurrence_limit: 100, small_csv_occurrence_limit: 2,
    pdf_reports_enabled: false, summary_cache_ttl_seconds: 45, report_generation_concurrency: 2,
    mcp_enabled: false, mcp_allow_writes: false, mcp_key_hash: "forbidden-field",
  });
  assert.notEqual(result.isError, true);
  const save = tool.calls.find(([name]) => name === "save");
  assert.deepEqual(JSON.parse(JSON.stringify(save[1])), { reporting: { fullPdfOccurrenceLimit: 100, smallCsvOccurrenceLimit: 2, pdfReportsEnabled: false }, performance: { summaryCacheTtlSeconds: 45, reportGenerationConcurrency: 2 } });
  assert.equal(save[2], "Bearer controlled-test-key");
  assert.ok(!JSON.stringify(save[1]).includes("integrations") && !JSON.stringify(save[1]).includes("forbidden-field"));
  assert.deepEqual(JSON.parse(result.content[0].text), JSON.parse(JSON.stringify(result.structuredContent)));
});

test("write revocation under settings row lock prevents a setting success response", async () => {
  const tool = await loadTool({ save: async () => { throw new Error("write access revoked under lock"); } });
  const result = await tool.runDashboardMcpTool(tool.request(), "update_settings", { confirm: true, small_csv_occurrence_limit: 2 });
  assert.equal(result.isError, true);
  assert.doesNotMatch(JSON.stringify(result), /write access revoked under lock/);
});

async function loadCanonicalRoute(upstream, { status = 200, scorer, globals = {} } = {}) {
  const calls = [];
  const source = await readFile(new URL("../src/app/mcp/route.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  const dependencies = {
    "@/lib/shopkeeper-proxy": { proxyShopkeeperRequest: async () => new Response(JSON.stringify(upstream), { status, headers: { "Access-Control-Allow-Origin": "http://localhost:3002", "Content-Length": "1", "Content-Encoding": "identity" } }) },
    "@/lib/scan-score-data": { getScanScoreSummaries: scorer ?? (async () => assert.fail("Marker dispatch must not invoke scoring")) },
    "@/lib/mcp-dashboard-tools": { runDashboardMcpTool: async (_request, operation, args) => { calls.push([operation, args]); return { content: [{ type: "text", text: "verified artifact" }], structuredContent: { operation } }; } },
  };
  vm.runInNewContext(compiled, { exports, JSON, Response, Headers, Date, AbortSignal, AbortController, require: (name) => { assert.ok(name in dependencies); return dependencies[name]; }, ...globals });
  // Existing marker tests use lightweight request objects. Supply a genuine
  // signal by default, matching NextRequest, while preserving explicit aborts.
  const handlers = Object.fromEntries(Object.entries(exports).map(([method, handler]) => [method, (request) => handler({ signal: new AbortController().signal, ...request })]));
  return { ...handlers, calls };
}

const trustedMarker = (argumentsValue = { scan_id: scanId, format: "pdf" }) => ({
  jsonrpc: "2.0", id: "canonical-test", result: {
    isError: true, content: [{ type: "text", text: "dashboard required" }],
    structuredContent: { requires_dashboard: true, operation: "get_report", arguments: argumentsValue },
  },
});

test("canonical route handles only an authenticated validated backend marker and preserves response headers", async () => {
  const route = await loadCanonicalRoute(trustedMarker());
  const response = await route.POST({ method: "POST" });
  assert.deepEqual(JSON.parse(JSON.stringify(route.calls)), [["get_report", { scan_id: scanId, format: "pdf" }]]);
  assert.equal((await response.json()).result.structuredContent.operation, "get_report");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "http://localhost:3002");
  assert.equal(response.headers.get("Content-Length"), null);
  assert.equal(response.headers.get("Content-Encoding"), null);
});

test("request-supplied markers, unauthorized HTTP and malformed markers cannot dispatch artifacts", async () => {
  for (const [upstream, options, method] of [
    [{ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "unknown tool" } }, {}, "POST"],
    [trustedMarker(), { status: 401 }, "POST"],
    [trustedMarker(), {}, "GET"],
    [trustedMarker(null), {}, "POST"],
    [trustedMarker([]), {}, "POST"],
    [{ ...trustedMarker(), result: { ...trustedMarker().result, isError: false } }, {}, "POST"],
  ]) {
    const route = await loadCanonicalRoute(upstream, options);
    const result = await route[method]({ method, body: JSON.stringify(trustedMarker()) });
    assert.deepEqual(route.calls, []);
    assert.deepEqual(await result.json(), upstream);
  }
});

const scanReadResponse = () => ({
  jsonrpc: "2.0", id: "scorer-deadline-test", result: {
    content: [{ type: "text", text: "upstream saved scan" }],
    structuredContent: { scan: { id: scanId, status: "completed" }, score_summary: null },
  },
});

test("canonical get_scan bounds a stalled dashboard scorer with the same MCP deadline", async () => {
  let scoreCalls = 0;
  const route = await loadCanonicalRoute(scanReadResponse(), {
    scorer: () => { scoreCalls += 1; return new Promise(() => {}); },
    globals: { AbortSignal: { any: AbortSignal.any, timeout: (timeout) => { assert.equal(timeout, 30_000); return AbortSignal.timeout(20); } } },
  });
  const keepAlive = setTimeout(() => {}, 500);
  try {
    const response = await route.POST({ method: "POST" });
    const payload = await response.json();
    assert.equal(scoreCalls, 1, "The real canonical enrichment reached the mocked score service");
    assert.equal(payload.id, "scorer-deadline-test");
    assert.equal(payload.result.isError, true, "A timed-out score cannot produce a successful scan result");
    assert.match(payload.result.content[0].text, /score|retry|timeout/i);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.ok(!payload.result.structuredContent);
  } finally { clearTimeout(keepAlive); }
});

test("canonical get_scan rejects caller-aborted enrichment and never sends late score success", async () => {
  let release;
  let started;
  const scoreStarted = new Promise((resolve) => { started = resolve; });
  const lateScore = new Promise((resolve) => { release = resolve; });
  const route = await loadCanonicalRoute(scanReadResponse(), {
    scorer: () => { started(); return lateScore; },
  });
  const controller = new AbortController();
  const work = route.POST({ method: "POST", signal: controller.signal });
  await scoreStarted;
  controller.abort(new Error("private scorer cancellation details"));
  const response = await work;
  const payload = await response.json();
  assert.equal(payload.result.isError, true);
  assert.doesNotMatch(JSON.stringify(payload), /private scorer cancellation details/);
  release({ [scanId]: { score: 100, hasScore: true } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(payload.result.isError, true, "A delayed score result cannot replace the earlier error");
  assert.ok(!payload.result.structuredContent);
});
