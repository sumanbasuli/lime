import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(new URL("../package.json", import.meta.url));
const ts = require("typescript");
async function loadTypeScript(relativePath) {
  const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports });
  return exports;
}
const { formatApiCode, tokenizeApiCodeLine } = await loadTypeScript("../lib/api-code.ts");
const { apiGroups } = await loadTypeScript("../content/api.ts");

test("valid JSON uses two-space indentation without changing its documented fields", () => {
  const input = '{"url":"https://example.com/","options":{"enabled":true},"count":20,"items":[null,"line\\nvalue"]}';
  assert.equal(formatApiCode(input, "json"), JSON.stringify(JSON.parse(input), null, 2));
  assert.deepEqual(JSON.parse(formatApiCode(input, "json")), JSON.parse(input));
  for (const input of ["null", "false", "0", '"text"', "[]"]) assert.equal(formatApiCode(input, "json"), input);
});

test("all existing request bodies retain their actual JSON content", () => {
  let count = 0;
  for (const group of apiGroups) {
    for (const endpoint of group.endpoints) {
      if (!endpoint.body) continue;
      assert.deepEqual(JSON.parse(formatApiCode(endpoint.body, "json")), JSON.parse(endpoint.body), endpoint.path);
      count += 1;
    }
  }
  assert.ok(count > 0, "test the existing documented request bodies, not fabricated responses");
});

test("invalid JSON, response field contracts and shell commands remain unchanged", () => {
  const inputs = ['  { items, total, has_more }\n', '{"url":', "HTTP 201 with a created scan record.", ""];
  for (const input of inputs) assert.equal(formatApiCode(input, "json"), input);
  assert.equal(formatApiCode('{"id":1}', "fields"), '{"id":1}');
  const command = `curl -fSs -X POST "http://localhost:3000/api/scans" \\\n  --data '{"include_link_check":true}'\n`;
  assert.equal(formatApiCode(command, "bash"), command);
});

test("highlighted tokens reconstruct every input exactly, including HTML and escapes", () => {
  const lines = [
    '  "source_text": "<script>alert(1)</script> & \\"quoted\\"",',
    "curl -fSs --header 'Authorization: Bearer $KEY' https://example.com/#fragment",
    "id: UUID | null, include_link_check: boolean",
    "  ", "", "# comment with <tag>", '"number": -1.25e+3, "healthy": true',
  ];
  for (const language of ["bash", "json", "fields"]) {
    for (const line of lines) {
      const tokens = tokenizeApiCodeLine(line, language);
      assert.equal(tokens.map((token) => token.text).join(""), line);
      assert.ok(tokens.every((token) => typeof token.text === "string" && typeof token.kind === "string"));
    }
  }
});

test("JSON keys, literals and shell flags receive distinct display-only token kinds", () => {
  const json = tokenizeApiCodeLine('  "count": 20, "enabled": true, "label": "lime"', "json");
  assert.equal(json.find((token) => token.text === '"count"').kind, "key");
  assert.equal(json.find((token) => token.text === "20").kind, "number");
  assert.equal(json.find((token) => token.text === "true").kind, "literal");
  assert.equal(json.find((token) => token.text === '"lime"').kind, "string");
  const bash = tokenizeApiCodeLine("curl --data $BODY", "bash");
  assert.equal(bash.find((token) => token.text === "curl").kind, "command");
  assert.equal(bash.find((token) => token.text === "--data").kind, "flag");
  assert.equal(bash.find((token) => token.text === "$BODY").kind, "variable");
});
