import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { createOpenClawDemo, makeOpenClawConfig, READ_TOOLS, WRITE_TOOLS, validateEndpoint } from "../scripts/openclaw-config.mjs";

test("demo exposes exactly known reads, not write wildcards or a coding profile", async () => {
  const config = await makeOpenClawConfig();
  assert.equal(READ_TOOLS.length, 17);
  assert.equal(WRITE_TOOLS.length, 12);
  assert.equal(config.tools.profile, "full");
  assert.deepEqual(config.tools.allow, ["read", "session_status", ...READ_TOOLS.map((name) => `lime__${name}`)]);
  assert.deepEqual(config.mcp.servers.lime.toolFilter.include, READ_TOOLS);
  assert.equal(config.tools.fs.workspaceOnly, true);
  assert.equal(config.tools.elevated.enabled, false);
  assert.equal(config.agents.defaults.heartbeat.every, "0m");
  assert.ok(config.tools.deny.includes("group:runtime"));
  assert.ok(config.tools.deny.includes("group:messaging"));
  assert.equal(config.mcp.servers.lime.transport, "streamable-http");
  assert.equal(config.mcp.servers.lime.headers.Authorization, "Bearer ${LIME_MCP_KEY}");
  assert.ok(!("auth" in config.mcp.servers.lime), "Static bearer, not OAuth");
  assert.equal(config.mcp.servers.lime.supportsParallelToolCalls, false);
  assert.deepEqual(config.plugins.allow, ["codex", "openai"]);
  assert.equal(config.plugins.entries.codex.config.appServer.mode, "guardian");
  assert.equal(config.plugins.entries.codex.config.appServer.sandbox, "read-only");
  assert.equal(config.plugins.entries.codex.config.appServer.homeScope, "agent");
  assert.equal(config.plugins.entries.codex.config.codexPlugins.enabled, false);
  assert.equal(config.agents.defaults.models["openai/gpt-5.6-sol"].agentRuntime.id, "openclaw");
  assert.deepEqual(config.auth, { profiles: { "openai:default": { provider: "openai", mode: "oauth" } }, order: { openai: ["openai:default"] } });
});

test("write opt-in adds only current action tools and never changes server permission", async () => {
  const config = await makeOpenClawConfig({ allowWrites: true });
  assert.deepEqual(config.mcp.servers.lime.toolFilter.include, [...READ_TOOLS, ...WRITE_TOOLS]);
  assert.deepEqual(config.tools.allow.slice(2), [...READ_TOOLS, ...WRITE_TOOLS].map((name) => `lime__${name}`));
  assert.equal(config.tools.allow.some((entry) => entry.includes("*")), false);
  assert.equal(JSON.stringify(config).includes("mcpAllowWrites"), false);
  await assert.rejects(makeOpenClawConfig({ allowWrites: "yes" }), /boolean/);
});

test("rejects insecure/credential-bearing/noncanonical endpoints", () => {
  for (const value of ["http://remote.example/mcp", "https://user:password@example.com/mcp", "https://example.com/mcp?key=secret", "https://example.com/mcp#secret", "https://example.com/", "file:///mcp"]) {
    assert.throws(() => validateEndpoint(value));
  }
  for (const value of ["https://lime.example.com/mcp", "http://localhost:3000/mcp", "http://127.0.0.1:14000/mcp", "http://[::1]:3000/mcp"]) assert.equal(validateEndpoint(value), value);
});

test("private profile copies workspace, stores no credentials, and refuses overwrite", async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "lime-agent-unit-")));
  try {
    const demo = await createOpenClawDemo({ directory, mcpUrl: "http://127.0.0.1:14000/mcp", model: "openai/gpt-5.6-sol" });
    assert.equal(demo.stateDir, path.join(directory, "state"));
    assert.equal(demo.env.LIME_AGENT_WORKSPACE, path.join(directory, "workspace"));
    assert.ok((await readFile(path.join(demo.workspace, "AGENTS.md"), "utf8")).includes("untrusted evidence"));
    const config = await readFile(demo.configPath, "utf8");
    assert.ok(config.includes("${LIME_MCP_KEY}"));
    assert.equal(JSON.parse(config).mcp.servers.lime.url, demo.env.LIME_MCP_URL);
    assert.equal(JSON.parse(config).agents.defaults.workspace, demo.workspace);
    assert.deepEqual(JSON.parse(config).agents.defaults.model, { primary: demo.env.LIME_AGENT_MODEL, fallbacks: [] });
    assert.ok(!config.includes("${LIME_AGENT_MODEL}") && !config.includes("${LIME_MCP_URL}") && !config.includes("${LIME_AGENT_WORKSPACE}"), "Later environment changes cannot silently change the validated origin/runtime/workspace");
    assert.ok(!config.includes("lime_mcp_"));
    assert.equal((await stat(demo.configPath)).mode & 0o777, 0o600);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal(await readFile(path.join(directory, ".gitignore"), "utf8"), "*\n");
    await assert.rejects(createOpenClawDemo({ directory, mcpUrl: demo.env.LIME_MCP_URL, model: demo.env.LIME_AGENT_MODEL }), /empty/);
    assert.equal(await readFile(demo.configPath, "utf8"), config);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("selected OpenAI model has an exact embedded runtime policy, not an interpolated object key", async () => {
  const config = await makeOpenClawConfig({ model: "openai/gpt-5.6" });
  assert.deepEqual(Object.keys(config.agents.defaults.models), ["openai/gpt-5.6"]);
  assert.equal(config.agents.defaults.models["openai/gpt-5.6"].agentRuntime.id, "openclaw");
});

test("rejects workspace links and malformed model before writing config", async () => {
  const source = await realpath(await mkdtemp(path.join(tmpdir(), "lime-agent-source-")));
  const target = await realpath(await mkdtemp(path.join(tmpdir(), "lime-agent-target-")));
  try {
    await writeFile(path.join(source, "instructions.md"), "test");
    await symlink(path.join(source, "instructions.md"), path.join(source, "alias.md"));
    await assert.rejects(createOpenClawDemo({ directory: target, workspace: source, mcpUrl: "https://lime.example.com/mcp", model: "openai/gpt-5.6-sol" }), /regular/);
    await assert.rejects(createOpenClawDemo({ directory: target, mcpUrl: "https://lime.example.com/mcp", model: "provider/model;echo bad" }), /model/);
    await assert.rejects(createOpenClawDemo({ directory: target, mcpUrl: "https://lime.example.com/mcp", model: "claude-cli/claude-opus-4-8" }), /CLI-backed/);
  } finally { await rm(source, { recursive: true, force: true }); await rm(target, { recursive: true, force: true }); }
});
