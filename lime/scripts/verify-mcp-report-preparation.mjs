import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(new URL("../package.json", import.meta.url));
const pg = require("pg");
const ts = require("typescript");
const appRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = path.dirname(appRoot.replace(/\/$/, ""));
const fixtureUrl = process.env.LIME_TEST_DATABASE_URL;
const key = "lime_mcp_controlled_report_fixture_key";
const scanId = "10000000-0000-4000-8000-000000000001";
const pageId = "10000000-0000-4000-8000-000000000101";
const secondPageId = "10000000-0000-4000-8000-000000000102";
const failedPageId = "10000000-0000-4000-8000-000000000103";
const issueId = "10000000-0000-4000-8000-000000000201";
const falsePositiveId = "10000000-0000-4000-8000-000000000202";
const emptyIssueId = "10000000-0000-4000-8000-000000000203";
const occurrenceId = "10000000-0000-4000-8000-000000000301";
const sixMiB = 6 * 1024 * 1024;

function validateFixtureUrl(raw) {
  const url = new URL(raw);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.equal(url.hostname, "localhost", "Only the disposable Unix-socket fixture is allowed");
  assert.equal(url.pathname, "/lime_report");
  assert.equal(url.password, "", "The fixture must not contain real credentials");
  assert.equal(url.hash, "");
  assert.match(url.searchParams.get("host") ?? "", /^\/(?:private\/)?tmp\/lime-pg-report-[A-Za-z0-9]+\/pg\/socket$/);
  assert.match(url.searchParams.get("port") ?? "", /^\d{4,5}$/);
  assert.ok(Number(url.searchParams.get("port")) >= 1024 && Number(url.searchParams.get("port")) <= 65535);
  assert.equal(url.searchParams.get("sslmode"), "disable");
  const names = [...url.searchParams.keys()];
  assert.equal(names.length, new Set(names).size, "Duplicate connection options are not allowed");
  assert.ok(names.every((name) => ["host", "port", "sslmode"].includes(name)), "Unexpected connection option");
  return url;
}

test("SQL report fixtures refuse ordinary databases, TCP hosts, credentials, and connection overrides", () => {
  const safe = "postgresql://fixture@localhost/lime_report?host=%2Fprivate%2Ftmp%2Flime-pg-report-abc123%2Fpg%2Fsocket&port=55439&sslmode=disable";
  assert.equal(validateFixtureUrl(safe).pathname, "/lime_report");
  assert.equal(validateFixtureUrl(safe.replace("%2Fprivate%2Ftmp", "%2Ftmp")).pathname, "/lime_report");
  for (const changed of [
    safe.replace("localhost", "127.0.0.1"), safe.replace("lime_report?", "production?"),
    safe.replace("fixture@", "fixture:secret@"), safe + "&options=-csearch_path%3Dpublic",
    safe + "&host=other-server",
    safe.replace("lime-pg-report-abc123", "existing-postgres"),
  ]) assert.throws(() => validateFixtureUrl(changed));
});

const compiled = new Map();
function compile(filename) {
  const source = readFileSync(filename, "utf8");
  const previous = compiled.get(filename);
  if (previous?.source === source) return previous.output;
  const output = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  compiled.set(filename, { source, output });
  return output;
}

const ruleIds = ["label", "color-contrast", "empty-rule", "manual-occ", "manual-fallback"];
const catalog = Object.fromEntries(ruleIds.map((ruleId) => [ruleId, {
  ruleId, help: `${ruleId} guidance`, description: `${ruleId} description`,
  helpUrl: `https://rules.example.test/${ruleId}`, tags: [],
}]));
const actRules = {
  getAxeRuleCatalog: async () => catalog,
  resolveACTContext: async () => ({ actRules: [], suggestedFixes: [] }),
  resolveAxeRuleContext: async () => ({ accessibilityRequirements: [], successCriterion: null, ruleDescription: null }),
  enrichIssueWithACT: async (issue) => ({ ...issue, actRules: [], suggestedFixes: [], axeAccessibilityRequirements: [] }),
};

// Evaluate the real report modules together. Only static guidance assets and
// unrelated PDF/backend operations are replaced; PostgreSQL and SQL stay real.
function sourceGraph(databaseUrl, { backendGetScan = false } = {}) {
  const trace = [];
  const clients = [];
  let afterPreflight;
  class ObservedClient extends pg.Client {
    constructor(options) { super(options); clients.push(this); }
    query(...args) {
      const text = typeof args[0] === "string" ? args[0] : args[0]?.text ?? "";
      const entry = { text, application: this.connectionParameters.application_name };
      trace.push(entry);
      const result = super.query(...args);
      if (!result?.then) return result;
      return result.then(async (value) => {
        entry.rowCount = value.rowCount;
        if (/^\s*WITH mcp_report_rows\b/i.test(text) && afterPreflight) await afterPreflight(text);
        return value;
      });
    }
  }
  class ObservedPool extends pg.Pool {
    constructor(options) { super({ ...options, Client: ObservedClient }); }
  }
  const modules = new Map();
  const context = vm.createContext({
    Buffer, URL, URLSearchParams, Headers, Request, Response, ReadableStream,
    AbortController, AbortSignal, Uint8Array, TextEncoder, TextDecoder,
    setTimeout, clearTimeout, setImmediate, clearImmediate, Date, JSON, performance,
    console, crypto: globalThis.crypto,
    __limeMcpArtifactTransportBinding: () => {},
    process: { ...process, env: { ...process.env, DATABASE_URL: databaseUrl, LIME_PERF_LOG: "false" } },
  });
  const overrides = {
    pg: { ...pg, Client: ObservedClient, Pool: ObservedPool },
    "@/lib/act-rules": actRules,
    "@/app/api/scans/[id]/issues/report.pdf/route": { GET: () => assert.fail("A CSV/LLM test must not invoke PDF rendering") },
    "@/lib/shopkeeper-proxy": { proxyShopkeeperRequest: async (request) => {
      assert.ok(backendGetScan, "A CSV/LLM test must not invoke the backend proxy");
      assert.equal(request.method, "POST");
      assert.equal(new URL(request.url).pathname, "/mcp");
      assert.equal(request.headers.get("authorization"), `Bearer ${key}`);
      assert.deepEqual(await request.clone().json(), {
        jsonrpc: "2.0", id: "score-fixture", method: "tools/call",
        params: { name: "get_scan", arguments: { scan_id: scanId } },
      });
      // Only the authenticated backend's fixed JSON envelope is simulated.
      // The canonical route, scorer, dedicated clients, and all SQL stay real.
      const data = { scan: { id: scanId, status: "completed", fixture: "trusted-backend" }, score_summary: null };
      return Response.json({
        jsonrpc: "2.0", id: "score-fixture",
        result: { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data },
      }, { headers: { "X-Lime-MCP-Transform": "dashboard" } });
    } },
  };
  function load(name, parent = path.join(appRoot, "src")) {
    if (name in overrides) return overrides[name];
    if (!name.startsWith("@/") && !name.startsWith(".")) return require(name);
    const base = name.startsWith("@/") ? path.join(appRoot, "src", name.slice(2)) : path.resolve(parent, name);
    const filename = base.endsWith(".ts") ? base : [base + ".ts", path.join(base, "index.ts")].find((candidate) => {
      try { return !!readFileSync(candidate); } catch { return false; }
    });
    assert.ok(filename, `Source module not found: ${name}`);
    if (modules.has(filename)) return modules.get(filename).exports;
    const sourceModule = { exports: {} };
    modules.set(filename, sourceModule);
    const wrapper = vm.runInContext(`(function (exports, require, module, __filename, __dirname) { ${compile(filename)}\n})`, context, { filename });
    wrapper(sourceModule.exports, (dependency) => load(dependency, path.dirname(filename)), sourceModule, filename, path.dirname(filename));
    return sourceModule.exports;
  }
  return {
    load, trace, clients,
    setAfterPreflight(callback) { afterPreflight = callback; },
    async close() {
      const database = modules.get(path.join(appRoot, "src/db/index.ts"))?.exports;
      await database?.pool.end();
      await Promise.all(clients.filter((client) => !client._ending).map((client) => client.end()));
    },
  };
}

function mcpRequest(signal) {
  const { NextRequest } = require("next/server");
  return new NextRequest("http://dashboard.test/mcp", { signal, headers: { Authorization: `Bearer ${key}` } });
}

async function getMcp(graph, args = {}, signal) {
  return graph.load("@/lib/mcp-dashboard-tools").runDashboardMcpTool(mcpRequest(signal), "get_report", {
    scan_id: scanId, format: "csv", ...args,
  });
}

async function getMcpScanResponse(graph, signal) {
  const { NextRequest } = require("next/server");
  return graph.load("@/app/mcp/route").POST(new NextRequest("http://dashboard.test/mcp", {
    method: "POST", signal,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: "score-fixture", method: "tools/call",
      params: { name: "get_scan", arguments: { scan_id: scanId } },
    }),
  }));
}

async function getMcpScan(graph, signal) {
  const response = await getMcpScanResponse(graph, signal);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.id, "score-fixture");
  return body.result;
}

async function waitFor(predicate, message, timeout = 5000) {
  const until = Date.now() + timeout;
  for (;;) {
    if (await predicate()) return;
    assert.ok(Date.now() < until, message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function scoreData(result) {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  const data = result.structuredContent;
  assert.deepEqual(data.scan, { id: scanId, status: "completed", fixture: "trusted-backend" });
  assert.deepEqual(JSON.parse(result.content[0].text), data);
  assert.equal(typeof data.score_summary.updated_at, "string");
  assert.ok(Number.isFinite(Date.parse(data.score_summary.updated_at)));
  const summary = { ...data.score_summary };
  delete summary.updated_at;
  return summary;
}

function assertReadBusy(result) {
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.http_status, 503);
  assert.equal(result.structuredContent.retry_after_seconds, 1);
  assert.match(result.content[0].text, /capacity is busy/);
}

function artifactText(result) {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  assert.equal(result.structuredContent.untrusted_content, true);
  const text = result.content[1].text;
  assert.equal(result.structuredContent.byte_count, Buffer.byteLength(text));
  assert.equal(result.structuredContent.sha256, createHash("sha256").update(text).digest("hex"));
  return text;
}

async function ordinaryReport(graph, format, search = "") {
  const suffix = format === "llm" ? "llm.txt" : "csv";
  const url = `http://dashboard.test/api/scans/${scanId}/issues/report.${suffix}${search ? `?${search}` : ""}`;
  const route = graph.load(`@/app/api/scans/[id]/issues/report.${suffix}/route`);
  return route.GET(new Request(url), { params: Promise.resolve({ id: scanId }) });
}

const normaliseLlmTime = (text) => text.replace(/^generated_at: .*$/m, "generated_at: <time>");
const rawMcpQueries = (graph) => graph.trace.filter((entry) => entry.application === "lime-mcp-report" && /^\s*select\b/i.test(entry.text));

test("MCP score and CSV/LLM preparation use bounded real PostgreSQL snapshots without changing ordinary exports", {
  skip: !fixtureUrl && "Set LIME_TEST_DATABASE_URL to the isolated private-socket fixture",
  timeout: 150_000,
}, async (t) => {
  const url = validateFixtureUrl(fixtureUrl);
  const socket = realpathSync(url.searchParams.get("host"));
  assert.ok(
    /\/codex-security-artifacts-[a-f0-9]+\/pg-report-[A-Za-z0-9]+\/socket$/.test(socket)
      || /^\/(?:private\/)?tmp\/lime-pg-report-[A-Za-z0-9]+\/pg\/socket$/.test(socket),
    "The socket must resolve into the managed or standard disposable fixture directory",
  );
  const admin = new pg.Client({ connectionString: url.href, connectionTimeoutMillis: 5000 });
  await admin.connect();
  const schema = `lime_report_test_${randomUUID().replaceAll("-", "")}`;
  let created = false;
  const graphs = [];
  const closeGraphs = async () => {
    for (const graph of graphs.splice(0)) await graph.close();
  };
  t.afterEach(closeGraphs);
  try {
    const { rows: [server] } = await admin.query("SELECT current_database() AS db, inet_server_addr() AS address, current_setting('data_directory') AS directory");
    assert.equal(server.db, "lime_report");
    assert.equal(server.address, null);
    assert.equal(realpathSync(server.directory), path.join(path.dirname(socket), "data"));
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await admin.query(`SET search_path TO "${schema}"`);
    const migrationRoot = path.join(repositoryRoot, "shopkeeper/migrations");
    const migrations = readdirSync(migrationRoot).filter((name) => /^\d{6}_[a-z_]+\.up\.sql$/.test(name)).sort();
    assert.ok(migrations.length >= 18, "The report fixture requires the complete base schema through migration 18");
    assert.deepEqual(
      migrations.map((name) => Number(name.slice(0, 6))),
      Array.from({ length: migrations.length }, (_, index) => index + 1),
      "The fixture must apply every migration in order without gaps or duplicate versions",
    );
    for (const migration of migrations) await admin.query(readFileSync(path.join(migrationRoot, migration), "utf8"));
    const scopedUrl = new URL(url);
    scopedUrl.searchParams.set("options", `-csearch_path=${schema}`);
    const graph = (options) => { const result = sourceGraph(scopedUrl.href, options); graphs.push(result); return result; };
    async function seed() {
      await admin.query("TRUNCATE scans CASCADE");
      await admin.query(`UPDATE app_settings SET small_csv_occurrence_limit=5, llm_occurrence_limit=3,
        csv_reports_enabled=true, llm_reports_enabled=true, mcp_enabled=true, mcp_allow_writes=false,
        mcp_key_hash=$1, summary_cache_ttl_seconds=60 WHERE key='global'`, [createHash("sha256").update(key).digest("hex")]);
      await admin.query(`INSERT INTO scans(id,sitemap_url,status,total_urls,scanned_urls)
        VALUES($1,'https://reader:secret@example.test/sitemap.xml?view=1','completed',3,2)`, [scanId]);
      await admin.query(`INSERT INTO urls(id,scan_id,url,status) VALUES
        ($1,$4,'https://reader:secret@example.test/page?view=1','completed'),
        ($2,$4,'https://example.test/second','completed'),
        ($3,$4,'https://example.test/failed','failed')`, [pageId, secondPageId, failedPageId, scanId]);
      await admin.query(`INSERT INTO issues(id,scan_id,violation_type,description,severity,is_false_positive) VALUES
        ($1,$4,'label','Input needs a label','critical',false),
        ($2,$4,'color-contrast','False-positive title','serious',true),
        ($3,$4,'empty-rule','No saved occurrence','minor',false)`, [issueId, falsePositiveId, emptyIssueId, scanId]);
      await admin.query(`INSERT INTO issue_occurrences(id,issue_id,url_id,html_snippet,css_selector,created_at) VALUES
        ($1,$2,$3,'<input id="first">','#first','2026-01-01'),
        ('10000000-0000-4000-8000-000000000302',$2,$3,'<input id="second">','#second','2026-01-01'),
        ('10000000-0000-4000-8000-000000000303',$4,$3,'<span>FP evidence</span>','.fp','2026-01-01')`, [occurrenceId, issueId, pageId, falsePositiveId]);
      await admin.query(`INSERT INTO url_audits(url_id,rule_id,outcome) VALUES
        ($1,'label','failed'),($1,'color-contrast','incomplete'),
        ($1,'manual-occ','incomplete'),($2,'manual-fallback','incomplete'),
        ($3,'ignored-failed-page','incomplete')`, [pageId, secondPageId, failedPageId]);
      await admin.query(`INSERT INTO url_audit_occurrences(url_id,rule_id,outcome,html_snippet,css_selector) VALUES
        ($1,'manual-occ','incomplete','<div>review evidence</div>','.review'),
        ($2,'manual-occ','incomplete','SHOULD_NOT_APPEAR','.failed'),
        ($1,'color-contrast','incomplete','SUPPRESSED_FP_RULE','.suppressed'),
        ($1,'ignored-passed','passed','SHOULD_NOT_APPEAR','.passed')`, [pageId, failedPageId]);
    }

    await t.test("small/full CSV and LLM preserve real SQL data, sampling, redaction, and scope semantics", async () => {
      await seed();
      const app = graph();
      for (const [format, args, search] of [
        ["csv", {}, "mode=small"], ["csv", { csv_mode: "full" }, "mode=full"], ["llm", {}, ""],
        ["csv", { kind: "failed", key: falsePositiveId }, `mode=small&kind=failed&key=${falsePositiveId}`],
        ["csv", { issue_id: issueId }, `mode=small&kind=failed&key=${issueId}`],
        ["llm", { kind: "needs_review", key: "manual-fallback" }, "kind=needs_review&key=manual-fallback"],
      ]) {
        const ordinary = await ordinaryReport(app, format, search);
        assert.equal(ordinary.status, 200);
        const expected = await ordinary.text();
        const text = artifactText(await getMcp(app, { format, ...args }));
        assert.equal(normaliseLlmTime(text), normaliseLlmTime(expected));
        assert.ok(!text.includes("reader:secret@"));
        assert.ok(!text.includes("SHOULD_NOT_APPEAR"));
        if (!args.kind && !args.issue_id) {
          assert.ok(text.includes("manual-occ"));
          assert.ok(text.includes("manual-fallback"));
          assert.ok(text.includes("empty-rule"));
          assert.ok(!text.includes("False-positive title"));
          assert.ok(!text.includes("SUPPRESSED_FP_RULE"));
        }
      }
      const rejected = await getMcp(app, { kind: "needs_review", key: "color-contrast" });
      assert.equal(rejected.isError, true);
      assert.equal(rejected.structuredContent.http_status, 404);
      const cache = await admin.query("SELECT count(*)::int AS count FROM scan_score_summary_cache");
      assert.equal(cache.rows[0].count, 1, "Ordinary reports may refresh their existing score cache");
    });

    await t.test("stale MCP scoring is equivalent but does not write its read-only snapshot", async () => {
      await seed();
      const app = graph();
      const tools = app.load("@/lib/scan-score-data");
      const summaries = await tools.getScanScoreSummaries([{ id: scanId, status: "completed" }]);
      await admin.query("UPDATE scan_score_summary_cache SET updated_at='2000-01-01', score=99");
      const before = (await admin.query("SELECT * FROM scan_score_summary_cache")).rows[0];
      const { withMcpReportRead } = app.load("@/lib/mcp-report-read");
      const bounded = await withMcpReportRead(new AbortController().signal, (context) => tools.getScanScoreSummaries([{ id: scanId, status: "completed" }], context));
      assert.deepEqual(JSON.parse(JSON.stringify(bounded)), JSON.parse(JSON.stringify(summaries)));
      assert.deepEqual((await admin.query("SELECT * FROM scan_score_summary_cache")).rows[0], before);
      assert.ok(!app.trace.filter((entry) => entry.application === "lime-mcp-report").some((entry) => /^\s*(?:insert|update)\b/i.test(entry.text)));
    });

    for (const state of ["cold", "expired", "changed scan"]) await t.test(`canonical MCP ${state} scores preserve values and durably warm the existing cache`, async () => {
      await seed();
      const ordinary = graph();
      const expected = (await ordinary.load("@/lib/scan-score-data").getScanScoreSummaries([{ id: scanId, status: "completed" }]))[scanId];
      const snakeSummary = Object.fromEntries(Object.entries(expected).map(([name, value]) => [name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`), value]));
      const baseline = (await admin.query("SELECT * FROM scan_score_summary_cache WHERE scan_id=$1", [scanId])).rows[0];
      if (state === "cold") await admin.query("DELETE FROM scan_score_summary_cache WHERE scan_id=$1", [scanId]);
      else if (state === "expired") await admin.query("UPDATE scan_score_summary_cache SET updated_at='2000-01-01', score=99 WHERE scan_id=$1", [scanId]);
      else await admin.query("UPDATE scan_score_summary_cache SET scan_updated_at='2000-01-01', score=99 WHERE scan_id=$1", [scanId]);
      const app = graph({ backendGetScan: true });
      const started = Date.now();
      const result = await getMcpScan(app);
      assert.deepEqual(scoreData(result), snakeSummary);
      assert.ok(Date.parse(result.structuredContent.score_summary.updated_at) >= started);
      const rows = (await admin.query("SELECT * FROM scan_score_summary_cache WHERE scan_id=$1", [scanId])).rows;
      assert.equal(rows.length, 1, "A separate connection must see the committed cache before MCP reports success");
      const persisted = { ...rows[0] };
      delete persisted.created_at;
      delete persisted.updated_at;
      const originalValues = { ...baseline };
      delete originalValues.created_at;
      delete originalValues.updated_at;
      assert.deepEqual(persisted, originalValues, "Publication retains every score field, scan timestamp, and scan status");
      // Drizzle writes ISO UTC text into the timestamp-without-time-zone
      // updated_at column and reads it as UTC. Raw pg instead assumes the
      // process's local zone. Interpret this assertion explicitly in SQL;
      // created_at retains its existing server-local NOW() default.
      const timestamps = (await admin.query(`SELECT updated_at AT TIME ZONE 'UTC' AS updated_instant,
        created_at AT TIME ZONE current_setting('TimeZone') AS created_instant
        FROM scan_score_summary_cache WHERE scan_id=$1`, [scanId])).rows[0];
      assert.ok(timestamps.updated_instant.getTime() >= started);
      if (state === "cold") assert.ok(timestamps.created_instant.getTime() >= started - 1000);
      else assert.deepEqual(rows[0].created_at, baseline.created_at, "An upsert must preserve the existing creation timestamp");
      const sql = app.trace.filter((entry) => entry.application === "lime-mcp-report");
      assert.equal(sql.filter((entry) => /^insert into "scan_score_summary_cache" /i.test(entry.text)).length, 1);
      const readCommit = sql.findIndex((entry) => entry.text === "COMMIT");
      const publishBegin = sql.findIndex((entry) => entry.text === "BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE");
      const publish = sql.findIndex((entry) => /^insert into "scan_score_summary_cache" /i.test(entry.text));
      assert.ok(readCommit >= 0 && publishBegin > readCommit && publish > publishBegin, "Only a fresh transaction may publish after the read-only snapshot");
      app.trace.length = 0;
      assert.deepEqual(scoreData(await getMcpScan(app)), snakeSummary);
      assert.deepEqual((await admin.query("SELECT * FROM scan_score_summary_cache WHERE scan_id=$1", [scanId])).rows[0], rows[0], "A fresh cache hit preserves all timestamps");
      assert.ok(!app.trace.some((entry) => /\b(?:insert into "scan_score_summary_cache"|join "url_audits")/i.test(entry.text)), "A durably warmed cache avoids recomputation and republication");
    });

    await t.test("simultaneous canonical cold scores publish once per client without repeatable-read serialization errors", async () => {
      await seed();
      const app = graph({ backendGetScan: true });
      let arrived = 0;
      let release;
      let reject;
      const barrier = new Promise((resolve, fail) => { release = resolve; reject = fail; });
      const timer = setTimeout(() => reject(new Error("Both cold score snapshots must reach audit preparation")), 5000);
      app.setAfterPreflight(async (sql) => {
        if (/group by "urls"\."scan_id", "url_audits"\."rule_id"/i.test(sql) && arrived < 2) {
          if (++arrived === 2) release();
          await barrier;
        }
      });
      let results;
      try { results = await Promise.all([getMcpScan(app), getMcpScan(app)]); }
      finally { clearTimeout(timer); release(); }
      assert.equal(arrived, 2);
      assert.deepEqual(scoreData(results[0]), scoreData(results[1]));
      const cache = (await admin.query("SELECT * FROM scan_score_summary_cache WHERE scan_id=$1", [scanId])).rows;
      assert.equal(cache.length, 1);
      const persisted = { ...cache[0] };
      for (const name of ["scan_id", "scan_updated_at", "scan_status", "created_at", "updated_at"]) delete persisted[name];
      assert.deepEqual(persisted, scoreData(results[0]));
      const sql = app.trace.filter((entry) => entry.application === "lime-mcp-report");
      assert.equal(sql.filter((entry) => entry.text === "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY").length, 2);
      assert.equal(sql.filter((entry) => entry.text === "BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE").length, 2);
      assert.equal(sql.filter((entry) => /^insert into "scan_score_summary_cache" /i.test(entry.text)).length, 2);
    });

    for (const [name, insert, values, projection] of [
      ["legacy false-positive rule TEXT", `INSERT INTO issues(scan_id,violation_type,description,severity,is_false_positive)
        SELECT $1,repeat('x',65536)||g,'Legacy rule','minor',true FROM generate_series(1,100) g`, [scanId], /"violation_type".*from "issues"/is],
      ["legacy audit rule TEXT", `INSERT INTO url_audits(url_id,rule_id,outcome)
        SELECT $1,repeat('x',65536)||g,'failed' FROM generate_series(1,100) g`, [pageId], /group by "urls"\."scan_id", "url_audits"\."rule_id"/i],
      ["distinct audit group count", `INSERT INTO url_audits(url_id,rule_id,outcome)
        SELECT $1,'legacy-group-'||g,'failed' FROM generate_series(1,17000) g`, [pageId], /group by "urls"\."scan_id", "url_audits"\."rule_id"/i],
    ]) await t.test(`canonical scoring rejects oversized ${name} before raw materialization or cache publication`, async () => {
      await seed();
      await admin.query(insert, values);
      if (name.includes("TEXT")) {
        const [table, column] = name.includes("false-positive") ? ["issues", "violation_type"] : ["url_audits", "rule_id"];
        const measured = (await admin.query(`SELECT sum(octet_length(${column}))::float8 AS logical,
          max(pg_column_size(${column})) AS stored, max(octet_length(${column})) AS largest FROM ${table}`)).rows[0];
        assert.ok(measured.logical * 6 > 32 * 1024 * 1024, "The saved legacy rule text must exceed the logical preparation budget");
        assert.ok(measured.stored < measured.largest / 10, "Compressed/index-compatible legacy values must retain their full logical byte size");
      }
      const app = graph({ backendGetScan: true });
      const result = await getMcpScan(app);
      assert.equal(result.isError, true);
      assert.equal(result.content[0].text, "Unable to read the scan score. Retry get_scan.");
      assert.ok(!JSON.stringify(result).includes("SELECT"));
      assert.ok(app.trace.some((entry) => /^\s*WITH mcp_report_rows\b/i.test(entry.text) && projection.test(entry.text)), "The rejected score projection must be measured in PostgreSQL");
      assert.ok(!rawMcpQueries(app).some((entry) => projection.test(entry.text)), "No rejected raw rule projection may reach Node");
      assert.ok(!app.trace.some((entry) => /^insert into "scan_score_summary_cache" /i.test(entry.text)));
      assert.equal((await admin.query("SELECT count(*)::int AS count FROM scan_score_summary_cache")).rows[0].count, 0);
    });

    await t.test("two canonical score preparations reject a third score and CSV/LLM before creating a third client", async () => {
      await seed();
      const app = graph({ backendGetScan: true });
      let held = 0;
      let release;
      const barrier = new Promise((resolve) => { release = resolve; });
      app.setAfterPreflight(async (sql) => {
        if (/from "scans"/i.test(sql) && held < 2) { held++; await barrier; }
      });
      const scores = [getMcpScan(app), getMcpScan(app)];
      try {
        await waitFor(() => held === 2, "Both canonical scores must hold preparation permits");
        assert.equal(app.clients.filter((client) => client.connectionParameters.application_name === "lime-mcp-report").length, 2);
        const inspectionBusy = await getMcpScanResponse(app);
        assert.equal(inspectionBusy.status, 503, "A third response is rejected before inspection or score preparation");
        assert.equal(inspectionBusy.headers.get("retry-after"), "1");
        assert.match((await inspectionBusy.json()).error, /inspection is busy.*request_id/i);
        for (const format of ["csv", "llm"]) assertReadBusy(await getMcp(app, { format }));
        assert.equal(app.clients.filter((client) => client.connectionParameters.application_name === "lime-mcp-report").length, 2, "Rejected tools must not construct another PostgreSQL client");
      } finally { release(); await Promise.all(scores); }
      for (const result of await Promise.all(scores)) scoreData(result);
      scoreData(await getMcpScan(app));
    });

    await t.test("missing and disabled reports keep actionable statuses without leaking SQL", async () => {
      await seed();
      for (const args of [
        { scan_id: randomUUID() }, { kind: "failed", key: randomUUID() },
        { kind: "needs_review", key: "missing-rule" },
      ]) {
        const result = await getMcp(graph(), args);
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent.http_status, 404);
        assert.ok(!JSON.stringify(result).includes("SELECT"));
      }
      await admin.query("UPDATE app_settings SET csv_reports_enabled=false, llm_reports_enabled=false");
      for (const format of ["csv", "llm"]) {
        const result = await getMcp(graph(), { format });
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent.http_status, 403);
      }
    });

    for (const [name, update, values, forbidden] of [
      ["unused viewport preset", "UPDATE scans SET viewport_preset=repeat('x',$1)", [sixMiB], /from "scans"/i],
      ["issue description", "UPDATE issues SET description=repeat('x',$1) WHERE id=$2", [sixMiB, issueId], /"description".*from "issues"/is],
      ["sample HTML", "UPDATE issue_occurrences SET html_snippet=repeat('x',$1) WHERE id=$2", [sixMiB, occurrenceId], /"html_snippet".*from "issue_occurrences"/is],
      ["unused screenshot path", "UPDATE issue_occurrences SET screenshot_path=repeat('x',$1) WHERE id=$2", [sixMiB, occurrenceId], /"html_snippet".*from "issue_occurrences"/is],
      ["unused element screenshot path", "UPDATE issue_occurrences SET element_screenshot_path=repeat('x',$1) WHERE id=$2", [sixMiB, occurrenceId], /"html_snippet".*from "issue_occurrences"/is],
    ]) await t.test(`compressed oversized ${name} is rejected before raw rows reach Node`, async () => {
      await seed();
      await admin.query(update, values);
      const [, table, column] = /^UPDATE (\w+) SET (\w+)=/.exec(update);
      const stored = (await admin.query(`SELECT max(pg_column_size(${column})) AS stored, max(octet_length(${column})) AS logical FROM ${table}`)).rows[0];
      assert.equal(stored.logical, sixMiB);
      assert.ok(stored.stored < stored.logical / 10, "The fixture must exercise logical bytes rather than compressed storage size");
      const app = graph();
      const format = name === "sample HTML" ? "llm" : "csv";
      const ordinary = await ordinaryReport(app, format, format === "csv" ? "mode=small" : "");
      assert.equal(ordinary.status, 200);
      const complete = await ordinary.text();
      if (name === "issue description") assert.ok(Buffer.byteLength(complete) > 4 * 1024 * 1024);
      else assert.ok(Buffer.byteLength(complete) < 4 * 1024 * 1024, "Omitted/truncated fields do not enlarge the ordinary file");
      const result = await getMcp(app, { format });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Artifact exceeds.*preparation limit/);
      assert.match(result.structuredContent.download_path, /\/issues\/report\./);
      assert.ok(!rawMcpQueries(app).some((entry) => forbidden.test(entry.text)), "A rejected projection must never fetch its raw TEXT");
    });

    await t.test("excluded false-positive evidence is not loaded, while its scoped export remains budgeted", async () => {
      await seed();
      await admin.query("UPDATE issue_occurrences SET html_snippet=repeat('x',$1) WHERE issue_id=$2", [sixMiB, falsePositiveId]);
      artifactText(await getMcp(graph()));
      const scoped = await getMcp(graph(), { kind: "failed", key: falsePositiveId });
      assert.equal(scoped.isError, true);
      assert.match(scoped.content[0].text, /preparation limit/);
    });

    await t.test("UTF-8 preparation bytes and CSV quoting expansion retain separate exact output limits", async () => {
      await seed();
      await admin.query("UPDATE issue_occurrences SET html_snippet=repeat('🍋',$1) WHERE id=$2", [sixMiB / 4, occurrenceId]);
      const unicode = await getMcp(graph(), { format: "llm" });
      assert.equal(unicode.isError, true);
      assert.match(unicode.content[0].text, /preparation limit/);
      await admin.query("UPDATE issue_occurrences SET html_snippet=repeat(chr(34),$1) WHERE id=$2", [2 * 1024 * 1024, occurrenceId]);
      const app = graph();
      const expanded = await getMcp(app);
      assert.equal(expanded.isError, true);
      assert.match(expanded.content[0].text, /4 MiB MCP limit/);
      assert.ok(rawMcpQueries(app).some((entry) => /"html_snippet".*from "issue_occurrences"/is.test(entry.text)), "Under-budget raw evidence may still exceed the encoded file limit");
      const ordinary = await ordinaryReport(app, "csv", "mode=small");
      assert.ok(Buffer.byteLength(await ordinary.text()) > 4 * 1024 * 1024);
      await admin.query("UPDATE issue_occurrences SET html_snippet=repeat('🍋',100000) WHERE id=$1", [occurrenceId]);
      assert.ok(artifactText(await getMcp(graph())).includes("🍋"));
    });

    await t.test("repeated CSV metadata is formatted only until the bounded MCP file fills", async () => {
      await seed();
      await admin.query("UPDATE issues SET description=repeat('x',131072) WHERE id=$1", [issueId]);
      await admin.query("UPDATE app_settings SET small_csv_occurrence_limit=1000");
      await admin.query(`INSERT INTO issue_occurrences(issue_id,url_id,html_snippet)
        SELECT $1,$2,'tiny' FROM generate_series(1,1000)`, [issueId, pageId]);
      for (const csv_mode of ["small", "full"]) {
        const app = graph();
        const scoring = app.load("@/lib/scan-scoring");
        const weight = scoring.getLighthouseAccessibilityWeight;
        let formatted = 0;
        scoring.getLighthouseAccessibilityWeight = (...args) => { formatted++; return weight(...args); };
        const result = await getMcp(app, { csv_mode });
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /4 MiB MCP limit/);
        assert.ok(formatted > 1 && formatted < 100, `MCP ${csv_mode} formatted ${formatted} rows before rejecting; do not build all 1,000 expanded rows`);
      }
      await admin.query("UPDATE app_settings SET small_csv_occurrence_limit=40");
      const ordinary = await ordinaryReport(graph(), "csv", "mode=small");
      assert.equal(ordinary.status, 200);
      const complete = await ordinary.text();
      assert.ok(Buffer.byteLength(complete) > 4 * 1024 * 1024);
      assert.equal(complete.match(/x{131072}/g)?.length, 40, "The ordinary sampled report still contains all configured rows");
    });

    await t.test("cumulative samples and a 20,000-per-group setting cannot bypass the preparation budget", async () => {
      await seed();
      await admin.query("UPDATE app_settings SET small_csv_occurrence_limit=20000");
      await admin.query(`INSERT INTO issue_occurrences(issue_id,url_id,html_snippet)
        SELECT $1,$2,repeat('x',2048) FROM generate_series(1,3500)`, [issueId, pageId]);
      const app = graph();
      const result = await getMcp(app);
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /preparation limit/);
      assert.ok(!rawMcpQueries(app).some((entry) => /"html_snippet".*from "issue_occurrences"/is.test(entry.text)));
    });

    await t.test("full CSV budgets each 5,000-row batch, while ordinary downloads remain complete above 4 MiB", async () => {
      await seed();
      await admin.query(`INSERT INTO issue_occurrences(issue_id,url_id,html_snippet,created_at)
        SELECT $1,$2,'bulk-'||g||repeat('x',1100),timestamp '2026-02-01' + g*interval '1 microsecond'
        FROM generate_series(1,5001) g`, [issueId, pageId]);
      const app = graph();
      const ordinary = await ordinaryReport(app, "csv", "mode=full");
      assert.equal(ordinary.status, 200);
      const text = await ordinary.text();
      assert.ok(Buffer.byteLength(text) > 4 * 1024 * 1024);
      assert.equal(text.match(/bulk-5001x/g)?.length, 1);
      assert.equal(text.match(/bulk-1x/g)?.length, 1);
      assert.ok(!text.includes("reader:secret@"));
      app.trace.length = 0;
      const result = await getMcp(app, { csv_mode: "full" });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /preparation limit/);
      assert.ok(!rawMcpQueries(app).some((entry) => /FROM issue_occurrences io/i.test(entry.text)), "The oversized raw CSV batch is not materialized");
    });

    await t.test("a repeatable-read snapshot prevents growth between scalar preflight and sample loading", async () => {
      await seed();
      const app = graph();
      let changed = false;
      app.setAfterPreflight(async (sql) => {
        if (!changed && /"html_snippet".*from "issue_occurrences"/is.test(sql)) {
          changed = true;
          await admin.query("UPDATE issue_occurrences SET html_snippet=repeat('x',$1) WHERE id=$2", [sixMiB, occurrenceId]);
        }
      });
      const text = artifactText(await getMcp(app));
      assert.equal(changed, true);
      assert.ok(text.includes('<input id=""first"">'));
      assert.ok(!text.includes("x".repeat(1024)));
      assert.ok(text.indexOf("first") < text.indexOf("second"), "Equal URL/time samples use their UUID tie-breaker");
    });

    await t.test("row and cumulative budgets stop later raw projections and projection mismatches fail closed", async () => {
      const app = graph();
      const { withMcpReportRead } = app.load("@/lib/mcp-report-read");
      await assert.rejects(withMcpReportRead(new AbortController().signal, async (context) => {
        await context.query("SELECT g FROM generate_series(1,9000) g", [], 1);
        return context.query("SELECT g FROM generate_series(1,9000) g", [], 1);
      }), /preparation limit/);
      assert.equal(rawMcpQueries(app).filter((entry) => entry.text === "SELECT g FROM generate_series(1,9000) g").length, 1);
      await assert.rejects(withMcpReportRead(new AbortController().signal, (context) => context.query("SELECT 1 AS first, 2 AS second", [], 1)));
      assert.ok(!rawMcpQueries(app).some((entry) => entry.text === "SELECT 1 AS first, 2 AS second"));
    });

    for (const phase of ["audit read", "score cache publication"]) await t.test(`an aborted canonical ${phase} keeps its shared permit until PostgreSQL's actual statement deadline`, { timeout: 45_000 }, async () => {
      await seed();
      if (phase === "score cache publication") {
        await graph().load("@/lib/scan-score-data").getScanScoreSummaries([{ id: scanId, status: "completed" }]);
        await admin.query("UPDATE scan_score_summary_cache SET updated_at='2000-01-01', score=99 WHERE scan_id=$1", [scanId]);
      }
      const before = (await admin.query("SELECT * FROM scan_score_summary_cache WHERE scan_id=$1", [scanId])).rows;
      const app = graph({ backendGetScan: true });
      const caller = new AbortController();
      let backend;
      let secondHeld = false;
      let releaseSecond;
      const secondBarrier = new Promise((resolve) => { releaseSecond = resolve; });
      let first;
      let second;
      const locker = new pg.Client({ connectionString: scopedUrl.href, connectionTimeoutMillis: 5000 });
      await locker.connect();
      await locker.query("BEGIN");
      try {
        if (phase === "audit read") await locker.query("LOCK TABLE url_audits IN ACCESS EXCLUSIVE MODE");
        else await locker.query("SELECT scan_id FROM scan_score_summary_cache WHERE scan_id=$1 FOR UPDATE", [scanId]);
        first = getMcpScan(app, caller.signal);
        await waitFor(async () => {
          backend = app.clients.find((client) => client.connectionParameters.application_name === "lime-mcp-report")?.processID;
          const query = phase === "audit read" ? "%url_audits%" : '%insert into "scan_score_summary_cache"%';
          return backend && (await admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE pid=$1 AND state='active' AND wait_event_type='Lock' AND query LIKE $2", [backend, query])).rows[0].count === 1;
        }, `The canonical score must reach a real PostgreSQL lock wait during ${phase}`);
        // Leave the second request enough deadline to finish after the first
        // statement expires; neither request's 30-second budget is extended.
        await new Promise((resolve) => setTimeout(resolve, 2000));
        app.setAfterPreflight(async (sql) => {
          if (/from "scans"/i.test(sql) && !secondHeld) { secondHeld = true; await secondBarrier; }
        });
        second = getMcpScan(app);
        await waitFor(() => secondHeld, "A second canonical score must occupy the remaining preparation permit");
        const started = Date.now();
        caller.abort();
        await assert.rejects(first, /MCP response.*disconnected.*original request_id/);
        assert.ok(Date.now() - started < 5000, "The aborted canonical response must return while its SQL cleanup still owns admission");
        assertReadBusy(await getMcpScan(app));
        for (const format of ["csv", "llm"]) assertReadBusy(await getMcp(app, { format }));
        assert.equal(app.clients.filter((client) => client.connectionParameters.application_name === "lime-mcp-report").length, 2, "An early route response must not recycle a disconnected SQL permit");
        assert.equal((await admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE pid=$1 AND state='active' AND wait_event_type='Lock'", [backend])).rows[0].count, 1);
        assert.deepEqual((await admin.query("SELECT * FROM scan_score_summary_cache WHERE scan_id=$1", [scanId])).rows, before, "Aborted work must not publish a cache value while its SQL is blocked");
        await waitFor(async () => (await admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE pid=$1", [backend])).rows[0].count === 0,
          "Disconnected PostgreSQL work must end at its enforced statement deadline", 35_000);
        assert.ok(Date.now() - started >= 25_000, "A socket-close error alone must not immediately recycle an active SQL lease");
        assert.deepEqual((await admin.query("SELECT * FROM scan_score_summary_cache WHERE scan_id=$1", [scanId])).rows, before, "Deadline cleanup must leave the prior committed cache intact");
        const { withMcpReportRead, McpReadPreparationBusyError } = app.load("@/lib/mcp-report-read");
        await waitFor(async () => {
          try {
            const recovered = await withMcpReportRead(new AbortController().signal, (context) => context.query("SELECT 1 AS recovered", [], 1));
            assert.equal(recovered.rows[0].recovered, 1);
            return true;
          } catch (error) {
            if (!(error instanceof McpReadPreparationBusyError)) throw error;
            return false;
          }
        }, "Admission must recover once the old SQL deadline and cleanup finish");
      } finally {
        await locker.query("ROLLBACK");
        await locker.end();
        app.setAfterPreflight(undefined);
        releaseSecond();
        await Promise.allSettled([first, second].filter(Boolean));
      }
      scoreData(await second);
      assert.ok(app.clients.filter((client) => client.connectionParameters.application_name === "lime-mcp-report").every((client) => client._ending));
    });
  } finally {
    await closeGraphs();
    if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
