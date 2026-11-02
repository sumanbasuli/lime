import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(new URL("../package.json", import.meta.url));
const ts = require("typescript");
const source = await readFile(new URL("../src/lib/html-report-read.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture(measurements) {
  const calls = [];
  let released = 0;
  let materialized = 0;
  const client = {
    async query(text, params) {
      calls.push({ text, params });
      if (text.startsWith("WITH html_report_rows")) return { rows: [measurements.shift()] };
      return { rows: [] };
    },
    release() { released += 1; },
  };
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    require: (name) => {
      if (name === "server-only") return {};
      if (name === "drizzle-orm/node-postgres") return { drizzle: () => ({}) };
      if (name === "@/db") return { pool: { connect: async () => client } };
      if (name === "@/db/schema") return {};
      throw new Error(`Unexpected dependency ${name}`);
    },
    BigInt,
    Number,
  });
  const rowQuery = (id) => ({
    toSQL: () => ({ sql: "SELECT id, url FROM affected_pages WHERE id = $1", params: [id] }),
    then(resolve) { materialized += 1; resolve([{ id, pageUrl: `https://example.test/${id}` }]); },
  });
  return { exports, calls, rowQuery, get released() { return released; }, get materialized() { return materialized; } };
}

test("exact aggregate row and byte limits return every row, with serialized shared accounting", async () => {
  const f = fixture([
    { row_count: "2048", byte_count: String(4 * 1024 * 1024) },
    { row_count: "2048", byte_count: String(4 * 1024 * 1024) },
  ]);
  const result = await f.exports.withHtmlReportRead(async (context) => Promise.all([
    context.read(f.rowQuery("first"), 2),
    context.read(f.rowQuery("last"), 2),
  ]));
  assert.equal(result.length, 2);
  assert.equal(f.materialized, 2);
  assert.equal(f.released, 1);
  assert.deepEqual(f.calls.map((call) => call.text.split(" ")[0]), ["BEGIN", "SET", "WITH", "WITH", "COMMIT"]);
  assert.ok(f.calls[2].text.includes("octet_length"));
  assert.deepEqual(f.calls[2].params, ["first"]);
});

test("over-limit rows fail before fetch and never yield a partial report", async () => {
  const f = fixture([{ row_count: "4097", byte_count: "4097" }]);
  await assert.rejects(f.exports.withHtmlReportRead((context) => context.read(f.rowQuery("many"), 2)),
    (error) => error instanceof f.exports.HtmlReportTooLargeError);
  assert.equal(f.materialized, 0);
  assert.equal(f.released, 1);
  assert.equal(f.calls.at(-1).text, "ROLLBACK");
});

test("one huge URL or snippet is rejected by bytes before row materialization", async () => {
  for (const field of ["url", "html snippet"]) {
    const f = fixture([{ row_count: "1", byte_count: String(8 * 1024 * 1024 + 1) }]);
    await assert.rejects(f.exports.withHtmlReportRead((context) => context.read(f.rowQuery(field), 2)),
      (error) => error instanceof f.exports.HtmlReportTooLargeError);
    assert.equal(f.materialized, 0, field);
  }
});

test("combined group reads cannot each spend the full budget", async () => {
  const f = fixture([
    { row_count: "3000", byte_count: "1000" },
    { row_count: "1097", byte_count: "1000" },
  ]);
  await assert.rejects(f.exports.withHtmlReportRead(async (context) => {
    await context.read(f.rowQuery("first group"), 2);
    await context.read(f.rowQuery("second group"), 2);
  }), (error) => error instanceof f.exports.HtmlReportTooLargeError);
  assert.equal(f.materialized, 1);
});

async function reportDataFixture(kind, evidence) {
  const reportSource = await readFile(new URL("../src/lib/issues-report-data.ts", import.meta.url), "utf8");
  const reportCompiled = ts.transpileModule(reportSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const names = ["scans", "issues", "issueOccurrences", "urlAudits", "urlAuditOccurrences", "urls"];
  const schema = Object.fromEntries(names.map((name) => [name, new Proxy({ name }, {
    get(target, key) { return key === "name" ? target.name : `${name}.${String(key)}`; },
  })]));
  const scan = { id: "scan", status: "completed", sitemapUrl: "https://example.test/" };
  const issue = { id: "issue", scanId: "scan", violationType: "rule-a", description: "Issue", severity: "serious", isFalsePositive: false };
  const pages = [
    { pageUrl: "https://example.test/first", occurrenceCount: 2 },
    { pageUrl: "https://example.test/last", occurrenceCount: 1 },
  ];
  const occurrences = [{ id: "occ", urlId: "url", pageUrl: pages[0].pageUrl, htmlSnippet: "full evidence" }];
  const select = (projection) => {
    const query = {
      projection,
      table: null,
      from(table) { this.table = table.name; return this; },
      innerJoin() { return this; },
      where() { return this; },
      groupBy() { return this; },
      orderBy() { return this; },
      limit() { return this; },
    };
    return query;
  };
  const database = { select };
  const loaded = [];
  const context = {
    db: database,
    read: async (query) => {
      loaded.push(query.table);
      const keys = Object.keys(query.projection ?? {});
      switch (query.table) {
        case "scans": return [scan];
        case "issues": return keys.includes("value") ? [{ value: 0 }] : kind === "failed" ? [issue] : [];
        case "issueOccurrences":
          return keys.includes("value") ? [{ value: 3 }] : keys.includes("pageUrl") && keys.includes("occurrenceCount") ? pages : occurrences;
        case "urlAudits":
          if (keys.includes("auditCount")) return [{ ruleId: "rule-a", auditCount: 1 }];
          if (keys.includes("value")) return [{ value: 1 }];
          if (keys.includes("occurrenceCount")) return pages;
          return [{ urlId: "url", pageUrl: pages[0].pageUrl }];
        case "urlAuditOccurrences":
          if (keys.includes("ruleId") && keys.includes("occurrenceCount")) return evidence === "occurrence" ? [{ ruleId: "rule-a", occurrenceCount: 3 }] : [];
          if (keys.includes("value")) return [{ value: evidence === "occurrence" ? 3 : 0 }];
          if (keys.includes("occurrenceCount")) return pages;
          return occurrences;
        default: throw new Error(`unexpected table ${query.table}`);
      }
    },
  };
  const dependencies = {
    "drizzle-orm": { and: (...parts) => parts, asc: (value) => value, count: () => "count", eq: (...parts) => parts, getTableColumns: () => ({ id: true }) },
    "@/db": { db: database },
    "@/db/schema": schema,
    "@/lib/act-rules": {
      enrichIssueWithACT: async (value) => ({ ...value, actRules: [], suggestedFixes: [], axeAccessibilityRequirements: [] }),
      getAxeRuleCatalog: async () => ({ "rule-a": { help: "Review issue", helpUrl: null } }),
      resolveACTContext: async () => ({ actRules: [], suggestedFixes: [] }),
      resolveAxeRuleContext: async () => ({ accessibilityRequirements: [], successCriterion: null, ruleDescription: null }),
    },
    "@/lib/scan-score-data": { getScanScoreSummaries: async () => ({ scan: {} }) },
    "@/lib/scan-scoring": { getLighthouseAccessibilityWeight: () => 0 },
    "@/lib/report-group-batches": {
      createReportGroupScheduler: () => ({ abort() {} }),
      mapReportGroups: async (items, load) => Promise.all(items.map(load)),
    },
    "@/lib/url-presentation": { redactOptionalUrlUserinfo: (value) => value, redactUrlUserinfo: (value) => value },
    "@/lib/mcp-report-read": { readReportQuery: (query, selectedContext) => selectedContext.read(query) },
  };
  const exports = {};
  vm.runInNewContext(reportCompiled, {
    exports,
    require: (name) => {
      if (!(name in dependencies)) throw new Error(`Unexpected dependency ${name}`);
      return dependencies[name];
    },
  });
  return { exports, context, loaded, pages };
}

test("full and scoped failed reports retain every affected page and occurrence sample", async () => {
  const f = await reportDataFixture("failed", "occurrence");
  for (const scoped of [false, true]) {
    const options = { context: f.context, occurrenceLimit: 30, includeAffectedPages: true };
    const data = scoped
      ? await f.exports.loadScopedIssueReportData("scan", { kind: "failed", key: "issue" }, options)
      : await f.exports.loadIssueReportData("scan", options);
    assert.equal(data.issuesWithOccurrences.length, 1);
    assert.deepEqual(Array.from(data.issuesWithOccurrences[0].affectedPages, (page) => page.pageUrl), f.pages.map((page) => page.pageUrl));
    assert.equal(data.issuesWithOccurrences[0].occurrences[0].htmlSnippet, "full evidence");
    assert.equal(data.issuesWithOccurrences[0].occurrenceSource, "issue_occurrences");
  }
  assert.ok(f.loaded.includes("issueOccurrences"));
});

test("full and scoped needs-review reports retain both evidence forms without truncation", async () => {
  for (const evidence of ["occurrence", "audit"]) {
    const f = await reportDataFixture("needs_review", evidence);
    for (const scoped of [false, true]) {
      const options = { context: f.context, occurrenceLimit: 30, includeAffectedPages: true };
      const data = scoped
        ? await f.exports.loadScopedIssueReportData("scan", { kind: "needs_review", key: "rule-a" }, options)
        : await f.exports.loadIssueReportData("scan", options);
      assert.equal(data.issuesWithOccurrences.length, 1);
      const group = data.issuesWithOccurrences[0];
      assert.deepEqual(Array.from(group.affectedPages, (page) => page.pageUrl), f.pages.map((page) => page.pageUrl));
      assert.equal(group.occurrenceSource, evidence === "occurrence" ? "url_audit_occurrences" : "url_audits");
      assert.equal(group.occurrences[0].htmlSnippet, evidence === "occurrence" ? "full evidence" : null);
    }
  }
});
