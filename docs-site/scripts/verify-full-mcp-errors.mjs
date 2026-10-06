import assert from "node:assert/strict";
import test from "node:test";
import { assertInstalledClientWorkflows, assertNoPrivateToolError } from "./verify-full-mcp.mjs";

const key = "lime_mcp_controlled_dummy_key_for_test";
const hash = "a".repeat(64);

test("truthful unknown-field rejection is not mistaken for disclosure", () => {
  assert.doesNotThrow(() => assertNoPrivateToolError("Unknown argument: mcp_key_hash", [key, hash]));
});

test("actual private key and stored hash disclosures are rejected without echoing them", () => {
  for (const value of [key, hash]) {
    assert.throws(() => assertNoPrivateToolError(`private value: ${value}`, [key, hash]), (error) => {
      assert.ok(!error.message.includes(value));
      return error.code === "ERR_ASSERTION";
    });
  }
});

test("SQL, panic and credential URL details remain prohibited", () => {
  for (const text of ["SQLSTATE XX000", "panic: private detail", "postgres://user:password@internal.invalid/db", "postgresql://user:password@internal.invalid/db"]) {
    assert.throws(() => assertNoPrivateToolError(text), { code: "ERR_ASSERTION" });
  }
});

const installedResult = () => ({
  userConfigsUnchanged: true,
  evidence: [
    { client: "codex", status: "passed" },
    { client: "opencode", status: "handshake_passed" },
    { client: "opencode", status: "workflow_passed" },
    ...["codex-scan", "codex-links", "opencode-links"].map((id) => ({ name: "installed_client_job_cleanup", id, status: "deleted_and_verified" })),
  ],
  trace: [
    { client: "codex", tool: "create_scan", succeeded: true, createdId: "codex-scan" },
    { client: "codex", tool: "create_link_check", succeeded: true, createdId: "codex-links" },
    { client: "opencode", tool: "create_link_check", succeeded: true, createdId: "opencode-links" },
  ],
});

test("both real installed workflows and all owned cleanup must pass", () => {
  assert.doesNotThrow(() => assertInstalledClientWorkflows(installedResult()));
  const replayed = installedResult();
  replayed.trace.push({ ...replayed.trace[0] });
  assert.doesNotThrow(() => assertInstalledClientWorkflows(replayed));
});

test("installed discovery cannot substitute for a real client workflow", () => {
  for (const [client, status] of [["codex", "passed"], ["opencode", "workflow_passed"]]) {
    const result = installedResult();
    result.evidence = result.evidence.filter((item) => item.client !== client || item.status !== status);
    assert.throws(() => assertInstalledClientWorkflows(result), { code: "ERR_ASSERTION" });
  }
});

test("missing, failed or unverified owned cleanup cannot report success", () => {
  for (const status of [null, "failed", "deleted"]) {
    const result = installedResult();
    result.evidence = result.evidence.filter((item) => item.id !== "opencode-links");
    if (status) result.evidence.push({ name: "installed_client_job_cleanup", id: "opencode-links", status });
    assert.throws(() => assertInstalledClientWorkflows(result), { code: "ERR_ASSERTION" });
  }
});

test("nested client failures and changed user configuration reject the installed run", () => {
  for (const status of ["failed", "workflow_failed", "incomplete"]) {
    const result = installedResult();
    result.evidence.push({ name: "additional_phase", status });
    assert.throws(() => assertInstalledClientWorkflows(result), { code: "ERR_ASSERTION" });
  }
  const changed = installedResult();
  changed.userConfigsUnchanged = false;
  assert.throws(() => assertInstalledClientWorkflows(changed), { code: "ERR_ASSERTION" });
  const missingTrace = installedResult();
  missingTrace.trace = [];
  assert.throws(() => assertInstalledClientWorkflows(missingTrace), { code: "ERR_ASSERTION" });
});
