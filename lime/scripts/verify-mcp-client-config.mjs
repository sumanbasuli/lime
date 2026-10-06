import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(new URL("../package.json", import.meta.url));
const ts = require("typescript");
const source = await readFile(new URL("../src/lib/mcp-client-config.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const exports = {};
vm.runInNewContext(compiled, { exports });
const { getMcpClientConfiguration, MCP_CLIENT_OPTIONS, MCP_KEY_PLACEHOLDER } = exports;
const endpoint = "http://localhost:3000/mcp";
const testKey = "lime-test-only-client-config-key";

test("client choices distinguish latest OpenCode and legacy formats", () => {
  assert.equal(MCP_CLIENT_OPTIONS.length, 4);
  assert.deepEqual(Array.from(MCP_CLIENT_OPTIONS, (option) => option.id), ["codex", "claude-code", "opencode", "opencode-legacy"]);
  for (const option of MCP_CLIENT_OPTIONS) {
    const output = getMcpClientConfiguration(option.id, endpoint);
    assert.match(output.docsUrl, /^https:\/\/(learn\.chatgpt\.com|code\.claude\.com|opencode\.ai)\//);
    assert.ok(output.instructions);
  }
});

test("Codex TOML keeps bearer secret in its environment variable", () => {
  const output = getMcpClientConfiguration("codex", endpoint, testKey);
  assert.equal(output.config, `[mcp_servers.lime]\nurl = "${endpoint}"\nbearer_token_env_var = "LIME_MCP_KEY"`);
  assert.doesNotMatch(output.config, new RegExp(testKey));
  assert.equal(output.environmentCommand, `export LIME_MCP_KEY='${testKey}'`);
  const escapedEndpoint = 'https://example.test/mcp?quote="&slash=\\&control=\n&unicode=λ';
  const escaped = getMcpClientConfiguration("codex", escapedEndpoint);
  assert.equal(escaped.config.split("\n")[1], `url = ${JSON.stringify(escapedEndpoint)}`);
  assert.equal(escaped.config.split("\n").length, 3, "dynamic values cannot add TOML lines");
});

test("Claude Code command uses remote HTTP with one bearer header", () => {
  const output = getMcpClientConfiguration("claude-code", endpoint, testKey);
  assert.match(output.config, /^claude mcp add --transport http lime /);
  assert.equal(output.environmentCommand, null);
  // A local shell function records arguments only; no Claude executable,
  // client configuration, authentication, network call or provider is invoked.
  const command = `claude() { printf '%s\\0' "$@"; };\n${output.config}`;
  const args = execFileSync("/bin/sh", ["-c", command], { encoding: "utf8" }).split("\0").slice(0, -1);
  assert.deepEqual(args, ["mcp", "add", "--transport", "http", "lime", endpoint, "--header", `Authorization: Bearer ${testKey}`]);
});

test("shell examples escape quotes, substitutions, backticks and newlines as data", () => {
  const trickyEndpoint = "https://example.test/mcp?quoted='&amount=$20&value=`printf bad`";
  const trickyKey = "key'\" $(printf unsafe) `printf unsafe`\nsecond line\\end";
  const output = getMcpClientConfiguration("claude-code", trickyEndpoint, trickyKey);
  const args = execFileSync("/bin/sh", ["-c", `claude() { printf '%s\\0' "$@"; };\n${output.config}`], { encoding: "utf8" }).split("\0").slice(0, -1);
  assert.deepEqual(args, ["mcp", "add", "--transport", "http", "lime", trickyEndpoint, "--header", `Authorization: Bearer ${trickyKey}`]);
  const codex = getMcpClientConfiguration("codex", endpoint, trickyKey);
  const restored = execFileSync("/bin/sh", ["-c", `${codex.environmentCommand}\nprintf '%s' "$LIME_MCP_KEY"`], { encoding: "utf8" });
  assert.equal(restored, trickyKey);
});

test("OpenCode 2.x JSON uses mcp.servers, bearer headers and disabled=false", () => {
  const output = getMcpClientConfiguration("opencode", endpoint, testKey);
  const parsed = JSON.parse(output.config);
  assert.deepEqual(parsed, {
    mcp: { servers: { lime: { type: "remote", url: endpoint, headers: { Authorization: `Bearer ${testKey}` }, oauth: false, disabled: false } } },
  });
  assert.equal(parsed.$schema, undefined, "do not attach a legacy-only editor schema to the V2 format");
  assert.equal(output.environmentCommand, null);
});

test("OpenCode 1.x JSON preserves mcp.lime and enabled=true", () => {
  const output = getMcpClientConfiguration("opencode-legacy", endpoint, testKey);
  const parsed = JSON.parse(output.config);
  assert.deepEqual(parsed, {
    $schema: "https://opencode.ai/config.json",
    mcp: { lime: { type: "remote", url: endpoint, headers: { Authorization: `Bearer ${testKey}` }, oauth: false, enabled: true } },
  });
});

test("JSON examples preserve dynamic URL/key values without injecting fields", () => {
  const trickyEndpoint = 'https://example.test/mcp?quote="&line=\n&slash=\\';
  const trickyKey = 'key\",\n"injected":true,\n"value":"<tag>\\';
  for (const client of ["opencode", "opencode-legacy"]) {
    const parsed = JSON.parse(getMcpClientConfiguration(client, trickyEndpoint, trickyKey).config);
    const server = client === "opencode" ? parsed.mcp.servers.lime : parsed.mcp.lime;
    assert.equal(server.url, trickyEndpoint);
    assert.deepEqual(server.headers, { Authorization: `Bearer ${trickyKey}` });
    assert.equal(server.injected, undefined);
  }
});

test("saved keys are not reconstructed and placeholders never require rotation", () => {
  for (const client of ["claude-code", "opencode", "opencode-legacy"]) {
    const output = getMcpClientConfiguration(client, "", null);
    assert.ok(output.config.includes("https://your-lime-host/mcp"));
    assert.ok(output.config.includes(MCP_KEY_PLACEHOLDER));
    assert.doesNotMatch(output.config, /mcp_key_hash|mcpKeyHash|generate_mcp_key/);
  }
});
