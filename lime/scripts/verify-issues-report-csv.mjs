import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(new URL("../package.json", import.meta.url));
const ts = require("typescript");

async function loadUrlPresentation() {
  const source = await readFile(new URL("../src/lib/url-presentation.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, URL });
  return exports;
}

async function loadCsv(rows = []) {
  const source = await readFile(new URL("../src/lib/issues-report-csv.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  const dependencies = {
    "@/lib/scan-scoring": { getLighthouseAccessibilityWeight: () => 0 },
    "@/db": { pool: { query: typeof rows === "function" ? rows : async () => ({ rows }) } },
    "@/lib/url-presentation": await loadUrlPresentation(),
  };

  vm.runInNewContext(compiled, {
    exports,
    require: (name) => {
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    ReadableStream,
    TextEncoder,
    URL,
  });
  return exports;
}

function report(overrides = {}) {
  const occurrence = {
    pageUrl: "=page",
    cssSelector: "\t+selector",
    htmlSnippet: "\n@snippet,\"quoted\"",
  };
  const group = {
    kind: "failed",
    issue: {
      id: "fixture-issue",
      scanId: "fixture-scan",
      violationType: "=rule",
      description: " \t=title,\"quoted\"",
      severity: "critical",
      helpUrl: "@help",
      actRules: [{ ruleUrl: "+act" }],
    },
    occurrenceCount: 1,
    occurrences: [occurrence],
    complianceReferences: [{ title: "-requirement" }],
    occurrenceSource: "issue_occurrences",
    ...overrides,
  };
  return { data: { issuesWithOccurrences: [group] }, occurrence };
}

test("issue CSV neutralizes formula-like text in every untrusted column", async () => {
  const csv = await loadCsv();
  const { data } = report();
  const result = csv.buildIssueReportCsv(data);
  const row = [
    "failed",
    "'=rule",
    '"\' \t=title,""quoted"""',
    "critical",
    "not scored",
    "1",
    "'=page",
    "'\t+selector",
    '"\'\n@snippet,""quoted"""',
    "'@help",
    "'+act",
    "'-requirement",
  ].join(",");
  assert.equal(result, `item_type,rule_id,title,severity,weight,occurrence_count,page_url,css_selector,html_snippet,help_url,act_urls,accessibility_requirements\r\n${row}`);
});

test("streaming issue CSV uses the same protection as small CSV", async () => {
  const { data, occurrence } = report();
  const csv = await loadCsv([{ ...occurrence, cursorId: "fixture-cursor", cursorCreatedAt: "2026-01-01 00:00:00.000000" }]);
  const small = csv.buildIssueReportCsv(data);
  const full = await new Response(csv.buildIssueReportCsvStream(data)).text();
  assert.equal(full, small);
});

test("sample streaming keeps exact CSV bytes and empty-group rows without querying all occurrences", async () => {
  const csv = await loadCsv(() => assert.fail("Sample streaming must only use saved samples"));
  const { data } = report();
  data.issuesWithOccurrences.push({ ...data.issuesWithOccurrences[0], occurrences: [], occurrenceCount: 0 });
  assert.equal(await new Response(csv.buildIssueReportCsvSampleStream(data)).text(), csv.buildIssueReportCsv(data));
});

test("benign text and numeric columns remain unchanged", async () => {
  const csv = await loadCsv();
  const { data } = report({
    issue: {
      id: "fixture-issue",
      scanId: "fixture-scan",
      violationType: "color-contrast",
      description: "Readable title",
      severity: "moderate",
      helpUrl: "https://example.test/help",
      actRules: [],
    },
    occurrences: [{ pageUrl: "https://example.test/", cssSelector: "a[href]", htmlSnippet: "plain text" }],
    complianceReferences: [],
    occurrenceCount: 12,
  });
  assert.match(csv.buildIssueReportCsv(data), /\r\nfailed,color-contrast,Readable title,moderate,not scored,12,https:\/\/example\.test\/,a\[href\],plain text,https:\/\/example\.test\/help,,/);
});

test("small and full CSV hide URL secrets without changing raw SQL cursors", async () => {
  const rawUrl = "https://reader:p%40ss@example.test:8443/page?q=1#section";
  const safeUrl = "https://example.test:8443/page";
  const { data } = report({
    issue: {
      id: "fixture-issue", scanId: "fixture-scan", violationType: "label",
      description: "Label", severity: "serious", helpUrl: "https://doc:secret@docs.test/help",
      actRules: [{ ruleUrl: "https://act:secret@rules.test/rule" }],
    },
    occurrences: [{ pageUrl: rawUrl, cssSelector: "a", htmlSnippet: "plain" }],
    complianceReferences: [],
  });
  const cursor = [];
  let batches = 0;
  const csv = await loadCsv(async (_sql, params) => {
    cursor.push(params);
    batches += 1;
    return { rows: batches === 1 ? Array.from({ length: 5000 }, (_, index) => ({
      id: `occ-${index}`, urlId: "url-1", pageUrl: rawUrl,
      cursorCreatedAt: "2026-01-01 00:00:00.000000", cursorId: "00000000-0000-0000-0000-000000000001",
      cssSelector: "a", htmlSnippet: "plain",
    })) : [] };
  });
  const small = csv.buildIssueReportCsv(data);
  const full = await new Response(csv.buildIssueReportCsvStream(data)).text();
  for (const output of [small, full]) {
    assert.ok(output.includes(safeUrl));
    assert.ok(output.includes("https://docs.test/help"));
    assert.ok(output.includes("https://rules.test/rule"));
    assert.ok(!output.includes("reader") && !output.includes("secret") && !output.includes("p%40ss") && !output.includes("q=1") && !output.includes("#section"));
  }
  assert.equal(cursor[1][1], rawUrl, "pagination uses the raw persisted URL");
});
