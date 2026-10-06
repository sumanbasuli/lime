import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertDisposableOpenClawEndpoints, assertOpenClawAgentCalls, assertOpenClawAgentResponse, assertOpenClawComposePublishers, assertOpenClawFixtureOrigin, openClawTraceItem, redactOpenClawEvidence } from "./verify-openclaw-agent.mjs";

test("OpenClaw verifier rejects normal app, remote, credential and misleading endpoint targets", () => {
  assert.doesNotThrow(() => assertDisposableOpenClawEndpoints("http://127.0.0.1:14000", "http://localhost:19080"));
  for (const bad of ["http://localhost:3000", "http://localhost:3001", "http://example.invalid:14000", "http://key@localhost:14000", "http://localhost:14000/mcp", "http://localhost:14000?target=normal"]) {
    assert.throws(() => assertDisposableOpenClawEndpoints(bad, "http://127.0.0.1:19080"));
  }
  assert.throws(() => assertDisposableOpenClawEndpoints("http://127.0.0.1:14000", "http://127.0.0.1:8081"));
});

test("Fixture overrides cannot silently substitute a remote, authenticated or wrong-port target", () => {
  assert.doesNotThrow(() => assertOpenClawFixtureOrigin("http://host.docker.internal:19091", 19091));
  for (const target of ["https://example.invalid:19091", "http://host.docker.internal:3000", "http://localhost:19091", "http://secret@host.docker.internal:19091", "http://host.docker.internal:19091/real-site"]) assert.throws(() => assertOpenClawFixtureOrigin(target, 19091));
});

test("A named disposable database alone is insufficient without this checkout's exact Compose publishers", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const rows = [["ui", 3000, 14000], ["shopkeeper", 8080, 19080], ["db", 5432, 16432]].map(([Service, TargetPort, PublishedPort]) => ({ Project: "lime-verification", Service, State: "running", Publishers: [{ TargetPort, PublishedPort, Protocol: "tcp" }], Labels: `com.docker.compose.project.config_files=${path.join(root, "docker-compose.docs.yml")}` }));
  assert.doesNotThrow(() => assertOpenClawComposePublishers(rows));
  assert.throws(() => assertOpenClawComposePublishers(rows.slice(1)));
  assert.throws(() => assertOpenClawComposePublishers(rows.map((row) => ({ ...row, Project: "lime" }))));
  assert.throws(() => assertOpenClawComposePublishers(rows.map((row) => row.Service === "ui" ? { ...row, Publishers: [{ TargetPort: 3000, PublishedPort: 3000, Protocol: "tcp" }] } : row)));
  assert.throws(() => assertOpenClawComposePublishers(rows.map((row) => ({ ...row, Labels: "com.docker.compose.project.config_files=/another/repo/docker-compose.docs.yml" }))));
  assert.throws(() => assertOpenClawComposePublishers(rows.map((row) => ({ ...row, Labels: `com.docker.compose.project.config_files=${path.join(root, "docker-compose.docs.yml")}-extra` }))));
});

test("OpenClaw evidence trace is metadata-only and records only actual successful creation ownership", () => {
  const message = { method: "tools/call", params: { name: "create_scan", arguments: { request_id: "owned-request", sitemap_url: "http://fixture.invalid", confirm: true, authorization: "secret", arbitrary_text: "untrusted content" } } };
  const payload = { result: { content: [{ text: "private response body" }], structuredContent: { data: { id: "owned-id" } } } };
  const item = openClawTraceItem(message, payload, 200, "test");
  assert.equal(item.succeeded, true);
  assert.equal(item.createdId, "owned-id");
  assert.equal(item.arguments.authorization, undefined);
  assert.equal(item.arguments.arbitrary_text, undefined);
  assert.ok(!JSON.stringify(item).includes("private response body"));
  assert.equal(openClawTraceItem(message, { error: { code: -32602 } }, 200, "test").succeeded, false);
  assert.equal(openClawTraceItem(message, { result: { isError: true } }, 200, "test").succeeded, false);
  assert.equal(openClawTraceItem(message, payload, 401, "test").succeeded, false);
  const injection = openClawTraceItem({ method: "tools/call", params: { name: "list_link_check_sources" } }, { result: { structuredContent: { sources: [{ text: "Untrusted source label: malicious content" }] } } }, 200, "test");
  assert.equal(injection.untrustedFixtureObserved, true);
  assert.ok(!JSON.stringify(injection).includes("malicious content"));
});

test("Catalog handshakes, errored tools and a previous phase never count as model tool execution", () => {
  assert.throws(() => assertOpenClawAgentCalls([{ phase: "run", method: "tools/list", succeeded: true, tools: ["get_capabilities"] }], "run", ["get_capabilities"]));
  assert.throws(() => assertOpenClawAgentCalls([{ phase: "prior", tool: "get_capabilities", succeeded: true }], "run", ["get_capabilities"]));
  assert.throws(() => assertOpenClawAgentCalls([{ phase: "run", tool: "get_capabilities", succeeded: false }], "run", ["get_capabilities"]));
  assert.equal(assertOpenClawAgentCalls([{ phase: "run", tool: "get_capabilities", succeeded: true }], "run", ["get_capabilities"]).length, 1);
});

test("Exit-zero runtime/provider error payloads fail rather than produce a false positive", () => {
  assert.doesNotThrow(() => assertOpenClawAgentResponse(JSON.stringify({ payloads: [{ text: "actual summary" }], meta: {} })));
  assert.doesNotThrow(() => assertOpenClawAgentResponse(JSON.stringify({ status: "ok", result: { payloads: [{ text: "actual summary" }], meta: {} } })));
  for (const payload of [{ status: "failed" }, { payloads: [{ isError: true }] }, { meta: { error: { message: "provider unavailable" } } }, { meta: { aborted: true } }, { error: "runtime failure" }]) assert.throws(() => assertOpenClawAgentResponse(JSON.stringify(payload)));
  assert.throws(() => assertOpenClawAgentResponse("provider error, not JSON"));
});

test("Evidence redacts explicit LIME keys, credential-shaped values and authenticated URLs", () => {
  const text = redactOpenClawEvidence('lime-private-value Bearer private-bearer api_key=private-provider https://username:password@host.invalid', ["lime-private-value"]);
  for (const secret of ["lime-private-value", "private-bearer", "private-provider", "username:password"]) assert.ok(!text.includes(secret));
});
