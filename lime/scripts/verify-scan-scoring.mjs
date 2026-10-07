import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(new URL("../package.json", import.meta.url));
const ts = require("typescript");

async function loadScoring() {
  const source = await readFile(new URL("../src/lib/scan-scoring.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports });
  return exports;
}

test("inherited object keys never become Lighthouse weights", async () => {
  const scoring = await loadScoring();
  for (const ruleId of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    assert.equal(scoring.getLighthouseAccessibilityWeight(ruleId), 0, ruleId);
  }
  assert.equal(scoring.getLighthouseAccessibilityWeight("image-alt"), 10);
});

test("forged rule IDs cannot turn aggregate score weights into non-numbers", async () => {
  const scoring = await loadScoring();
  const report = scoring.buildScanAuditReport({
    auditRecords: [
      { ruleId: "constructor", outcome: "passed" },
      { ruleId: "toString", outcome: "failed" },
      { ruleId: "image-alt", outcome: "passed" },
    ],
    scanStatus: "completed",
    coverage: { completedUrlCount: 1, failedUrlCount: 0, totalUrlCount: 1 },
  });
  assert.equal(report.summary.weightedPassed, 10);
  assert.equal(report.summary.weightedFailed, 0);
  assert.equal(report.summary.weightedTotal, 10);
  assert.equal(report.summary.score, 100);
  assert.equal(report.audits.find((audit) => audit.ruleId === "constructor")?.scored, false);
});
