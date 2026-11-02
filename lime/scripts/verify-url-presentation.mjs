import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(new URL("../package.json", import.meta.url));
const ts = require("typescript");

async function loadTs(path, dependencies = {}) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    URL,
    Response,
    ReadableStream,
    TextEncoder,
    require: (name) => dependencies[name] ?? {},
  });
  return exports;
}

const urlPresentation = await loadTs("../src/lib/url-presentation.ts");
const reportFilename = await loadTs("../src/lib/report-filename.ts");

test("report names use only a parsed host, with a fixed hostless fallback", () => {
  const sanitize = reportFilename.sanitizeReportHost;
  for (const raw of [
    "https:/?token=QUERY_TOKEN_CANARY",
    "https:?token=QUERY_TOKEN_CANARY",
    "foo:opaque?token=QUERY_TOKEN_CANARY",
    "/path?token=QUERY_TOKEN_CANARY",
    "https://[fe80::1%25en0]/?token=QUERY_TOKEN_CANARY",
  ]) {
    assert.equal(sanitize(raw), "scan");
  }
  assert.equal(sanitize("https://user:secret@Example.COM:8443/path?token=QUERY_TOKEN_CANARY#fragment"), "example-com8443");
  assert.equal(sanitize("https://example.com:443/path"), "example-com");
  assert.equal(sanitize("https://[2001:db8::1]:8443/path"), "2001db818443");
});

test("CSV and LLM download headers omit hostless URL queries and preserve scoped names", async () => {
  const scope = await loadTs("../src/lib/issue-report-scope.ts");
  for (const [format, path] of [
    ["small.csv", "../src/app/api/scans/[id]/issues/report.csv/route.ts"],
    ["full.csv", "../src/app/api/scans/[id]/issues/report.csv/route.ts"],
    ["llm.txt", "../src/app/api/scans/[id]/issues/report.llm.txt/route.ts"],
  ]) {
    for (const [rawUrl, host] of [
      ["https:/?token=QUERY_TOKEN_CANARY", "scan"],
      ["foo:opaque?token=QUERY_TOKEN_CANARY", "scan"],
      ["https://user:secret@Example.COM:8443/path?token=QUERY_TOKEN_CANARY", "example-com8443"],
    ]) {
      const data = { scan: { sitemapUrl: rawUrl, createdAt: new Date("2026-10-23T00:00:00Z") } };
      const route = await loadTs(path, {
        "@/lib/report-filename": reportFilename,
        "@/lib/issue-report-scope": scope,
        "@/lib/report-settings": { getReportSettings: async () => ({ csvReportsEnabled: true, llmReportsEnabled: true, smallCsvOccurrenceLimit: 5, llmOccurrenceLimit: 5 }) },
        "@/lib/performance-logging": { measureServerAction: (_label, work) => work() },
        "@/lib/issues-report-data": { loadIssueReportData: async () => data, loadScopedIssueReportData: async () => data },
        "@/lib/issues-report-csv": { buildIssueReportCsvSampleStream: () => "csv", buildIssueReportCsvStream: () => "csv" },
        "@/lib/issues-report-llm": { buildIssueReportLlmStream: () => "text" },
      });
      for (const scoped of [false, true]) {
        const query = new URLSearchParams({ mode: format.startsWith("full") ? "full" : "small" });
        if (scoped) { query.set("kind", "needs_review"); query.set("key", "color_contrast"); }
        const response = await route.GET(new Request(`http://localhost/api/scans/scan-1/issues/report?${query}`), { params: Promise.resolve({ id: "scan-1" }) });
        const suffix = scoped ? "-needs-review-color-contrast" : "";
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-disposition"), `attachment; filename="lime-issue-report-${host}-2026-10-23${suffix}-${format}"`);
        assert.ok(!response.headers.get("content-disposition").toLowerCase().includes("canary"));
      }
    }
  }
});

function reportFixture() {
  return {
    scan: { id: "scan-1", sitemapUrl: "https://scan:password@example.test/site?token=QUERY_TOKEN_CANARY", status: "completed" },
    scoreSummary: {
      hasScore: false, score: null, completedUrlCount: 1, totalUrlCount: 1,
      failedUrlCount: 0, isPartialScan: false, hasFullCoverage: true,
      passedCount: 0, failedCount: 1, needsReviewCount: 0,
      excludedCount: 0, notApplicableCount: 0,
    },
    issuesWithOccurrences: [{
      kind: "failed",
      issue: {
        id: "issue-1", scanId: "scan-1", violationType: "label",
        description: "Form element missing label", severity: "serious",
        helpUrl: "https://help:password@docs.test/rule?token=QUERY_TOKEN_CANARY",
        actRules: [{ ruleUrl: "https://act:password@rules.test/rule?token=QUERY_TOKEN_CANARY" }],
      },
      occurrences: [{ pageUrl: "https://page:password@example.test/form?token=QUERY_TOKEN_CANARY", cssSelector: "input", htmlSnippet: "<input>" }],
      affectedPages: [{ pageUrl: "https://page:password@example.test/form?token=QUERY_TOKEN_CANARY", occurrenceCount: 1 }],
      occurrenceCount: 1, occurrenceSource: "issue_occurrences",
      complianceReferences: [], axeRuleDescription: null, axeSuggestedChange: null,
    }],
    totalIssueCardCount: 1, failedIssueCount: 1, needsReviewIssueCount: 0,
    severityBreakdown: { critical: 0, serious: 1, moderate: 0, minor: 0 },
  };
}

test("URL presentation removes encoded/plain userinfo, query, and fragment", () => {
  const redact = urlPresentation.redactUrlUserinfo;
  assert.equal(redact("https://reader:p%40ss@example.test:8443/a?x=1#section"), "https://example.test:8443/a");
  assert.equal(redact("http://name@example.test/path"), "http://example.test/path");
  assert.equal(redact("//name:password@example.test/path"), "//example.test/path");
  assert.equal(redact("https://name:password@%"), "https://%");
  assert.equal(redact("https://example.test/a?email=name@example.test"), "https://example.test/a");
  assert.equal(redact("HTTPS://example.test/a"), "HTTPS://example.test/a");
});

test("printable report data redacts every URL field without mutating stored values", async () => {
  const reportData = await loadTs("../src/lib/issues-report-data.ts", {
    "@/lib/url-presentation": urlPresentation,
  });
  const raw = reportFixture();
  const safe = reportData.redactIssueReportData(raw);
  const group = safe.issuesWithOccurrences[0];
  assert.equal(safe.scan.sitemapUrl, "https://example.test/site");
  assert.equal(group.issue.helpUrl, "https://docs.test/rule");
  assert.equal(group.issue.actRules[0].ruleUrl, "https://rules.test/rule");
  assert.equal(group.occurrences[0].pageUrl, "https://example.test/form");
  assert.equal(group.affectedPages[0].pageUrl, "https://example.test/form");
  assert.equal(raw.scan.sitemapUrl, "https://scan:password@example.test/site?token=QUERY_TOKEN_CANARY");
  assert.equal(raw.issuesWithOccurrences[0].occurrences[0].pageUrl, "https://page:password@example.test/form?token=QUERY_TOKEN_CANARY");
  assert.equal(safe.issuesWithOccurrences[0].occurrenceCount, 1);
});

test("issue-detail JSON presentation redacts links and occurrence URLs", async () => {
  const scanIssues = await loadTs("../src/lib/scan-issues.ts", {
    "@/lib/url-presentation": urlPresentation,
  });
  const detail = {
    kind: "failed", helpUrl: "https://help:password@docs.test/rule?token=QUERY_TOKEN_CANARY",
    actRules: [{ ruleUrl: "https://act:password@rules.test/rule?token=QUERY_TOKEN_CANARY" }],
    occurrences: [{ pageUrl: "https://page:password@example.test/form?token=QUERY_TOKEN_CANARY" }],
    occurrenceCount: 1,
  };
  const safe = scanIssues.redactIssueDetailForPresentation(detail);
  assert.equal(safe.helpUrl, "https://docs.test/rule");
  assert.equal(safe.actRules[0].ruleUrl, "https://rules.test/rule");
  assert.equal(safe.occurrences[0].pageUrl, "https://example.test/form");
  assert.equal(detail.occurrences[0].pageUrl, "https://page:password@example.test/form?token=QUERY_TOKEN_CANARY");
});

test("LLM report serializer does not expose userinfo even for a raw report object", async () => {
  const llm = await loadTs("../src/lib/issues-report-llm.ts", {
    "@/lib/url-presentation": urlPresentation,
    "@/lib/scan-scoring": { getLighthouseAccessibilityWeight: () => 0 },
  });
  const text = llm.buildIssueReportLlmText(reportFixture(), 5);
  assert.ok(text.includes("sitemap_url: https://example.test/site"));
  assert.ok(text.includes("sample_1_page_url: https://example.test/form"));
  assert.ok(text.includes("help_url: https://docs.test/rule"));
  assert.ok(text.includes("act_urls: https://rules.test/rule"));
  assert.ok(!text.includes("password") && !text.includes("QUERY_TOKEN_CANARY"));
});

test("streamed LLM reports preserve headers, blank lines, samples, and empty-group bytes", async () => {
  const llm = await loadTs("../src/lib/issues-report-llm.ts", {
    "@/lib/url-presentation": urlPresentation,
    "@/lib/scan-scoring": { getLighthouseAccessibilityWeight: () => 0 },
  });
  const data = reportFixture();
  data.issuesWithOccurrences.push({ ...data.issuesWithOccurrences[0], occurrences: [], occurrenceCount: 0 });
  const normalizeTime = (text) => text.replace(/^generated_at: .*$/m, "generated_at: <time>");
  const expected = llm.buildIssueReportLlmText(data, 5);
  const actual = await new Response(llm.buildIssueReportLlmStream(data, 5)).text();
  assert.equal(normalizeTime(actual), normalizeTime(expected));
});
