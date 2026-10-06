import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { assertNoPrivateToolError } from "./verify-full-mcp.mjs";
import { connectMcp } from "./verify-mcp.mjs";

const require = createRequire(new URL("../../lime/package.json", import.meta.url));
const { Client } = require("pg");

// Called only by the guarded focused runner after it enables a disposable key.
// These dedicated test connections never change the application's pool config.
export async function verifyMcpSettingsLock({ baseUrl, key, dbPort = 16432 }) {
  const endpoint = new URL(baseUrl);
  assert.ok(["127.0.0.1", "localhost"].includes(endpoint.hostname));
  assert.equal(endpoint.port, "14000", "Settings contention verification uses only the disposable dashboard");
  assert.ok(!endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash && endpoint.pathname === "/");
  assert.equal(dbPort, 16432, "Settings contention verification cannot target the normal PostgreSQL port");
  assert.ok(key, "A disposable MCP key is required");
  const connectionOptions = {
    host: "127.0.0.1", port: dbPort, user: "lime", password: "lime_docs_password", database: "lime_docs_db",
    connectionTimeoutMillis: 5000, query_timeout: 5000,
  };
  const blocker = new Client({ ...connectionOptions, application_name: "lime-settings-lock-blocker" });
  const monitor = new Client({ ...connectionOptions, application_name: "lime-settings-lock-monitor" });
  // A lost test connection must fail a query, not crash the process before finally.
  blocker.on("error", () => {});
  monitor.on("error", () => {});
  let blockerConnected = false;
  let monitorConnected = false;
  let locked = false;
  let connection;
  let pending;
  let originalValue;
  let restored = false;
  let phase = "isolated database guards";
  try {
    await blocker.connect(); blockerConnected = true;
    await monitor.connect(); monitorConnected = true;
    for (const client of [blocker, monitor]) {
      const { rows: [database] } = await client.query("SELECT current_database() AS name, current_user AS username");
      assert.equal(database.name, "lime_docs_db");
      assert.equal(database.username, "lime");
    }
    // Self-heal an abandoned test lock without changing any pooled UI session.
    await blocker.query("SET idle_in_transaction_session_timeout = '30s'");
    connection = await connectMcp(`${baseUrl}/mcp`, key);
    const capabilities = await connection.client.callTool({ name: "get_capabilities", arguments: {} });
    assert.equal(capabilities.structuredContent?.allow_writes, true);
    const snapshot = async () => (await monitor.query("SELECT to_jsonb(a)-'mcp_key_hash' AS settings, mcp_key_hash FROM app_settings a WHERE key='global'")).rows[0];
    const before = await snapshot();
    assert.ok(before?.settings, "The disposable global settings row exists");
    originalValue = before.settings.small_csv_occurrence_limit;
    const requestedValue = originalValue === 3 ? 4 : 3;
    const payload = { confirm: true, small_csv_occurrence_limit: requestedValue };
    const update = (args) => connection.client.callTool({ name: "update_settings", arguments: args }, undefined, { timeout: 15_000 });

    phase = "real PostgreSQL row contention";
    await blocker.query("BEGIN");
    locked = true;
    const { rows: [owner] } = await blocker.query("SELECT pg_backend_pid() AS pid");
    await blocker.query("SELECT key FROM app_settings WHERE key='global' FOR UPDATE");
    const started = Date.now();
    // Capture rejections while the monitor proves the actual save is waiting.
    pending = update(payload).then((value) => ({ value }), (error) => ({ error }));
    let waiter;
    const observationDeadline = Date.now() + 4500;
    while (!waiter && Date.now() < observationDeadline) {
      const result = await monitor.query("SELECT pid, query FROM pg_stat_activity WHERE datname='lime_docs_db' AND $1 = ANY(pg_blocking_pids(pid))", [owner.pid]);
      waiter = result.rows.find((row) => /app_settings/i.test(row.query));
      if (!waiter) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(waiter, "The canonical MCP settings save actually waits behind the test's PostgreSQL row lock");
    const outcome = await pending;
    assert.ok(!outcome.error, "The server returns a controlled tool error, not a client transport timeout");
    assert.equal(outcome.value.isError, true);
    const errorText = outcome.value.content?.filter((item) => item.type === "text").map((item) => item.text).join("\n") ?? "";
    assert.match(errorText, /Unable to complete dashboard MCP operation/i);
    assertNoPrivateToolError(JSON.stringify(outcome.value), [key, before.mcp_key_hash]);
    const elapsedMs = Date.now() - started;
    assert.ok(elapsedMs < 12_000, "A five-second SQL lock timeout returns promptly without claiming a universal RPC deadline");
    assert.deepEqual((await snapshot()).settings, before.settings, "A timed-out statement cannot partially update settings");
    const { rows: [activity] } = await monitor.query("SELECT state, xact_start FROM pg_stat_activity WHERE pid=$1", [waiter.pid]);
    assert.ok(!activity || activity.xact_start === null, "The timed-out UI transaction has rolled back before MCP reports failure");
    const { rows: blocked } = await monitor.query("SELECT pid FROM pg_stat_activity WHERE datname='lime_docs_db' AND $1 = ANY(pg_blocking_pids(pid))", [owner.pid]);
    assert.equal(blocked.length, 0, "No original settings write remains queued behind the held row lock");

    phase = "release and verify no late commit";
    await blocker.query("ROLLBACK");
    locked = false;
    assert.deepEqual((await snapshot()).settings, before.settings, "Releasing the blocker cannot revive or commit the failed settings write");
    phase = "canonical retry and original-value restoration";
    const recovered = await update(payload);
    assert.notEqual(recovered.isError, true, "The same canonical settings action succeeds after releasing contention");
    assert.equal(recovered.structuredContent?.settings.reporting.smallCsvOccurrenceLimit, requestedValue);
    assert.equal((await snapshot()).settings.small_csv_occurrence_limit, requestedValue);
    const restore = await update({ confirm: true, small_csv_occurrence_limit: originalValue });
    assert.notEqual(restore.isError, true, "Restore the verifier-owned settings change through canonical MCP");
    const after = (await snapshot()).settings;
    const withoutTimestamp = (settings) => Object.fromEntries(Object.entries(settings).filter(([name]) => name !== "updated_at"));
    assert.deepEqual(withoutTimestamp(after), withoutTimestamp(before.settings), "Recovery and restoration preserve all other settings");
    restored = true;
    return {
      completedAt: new Date().toISOString(), status: "passed", name: "canonical MCP settings row-lock timeout",
      endpoint: `${baseUrl}/mcp`, database: "lime_docs_db", elapsedMs,
      observedActualBlocking: true, rollbackBeforeFailure: true, unchangedAfterRelease: true,
      retrySucceeded: true, originalValueRestored: true, trace: connection.trace,
    };
  } catch (error) {
    throw new Error(`Settings lock verification failed during ${phase}: ${String(error.message).replaceAll(key, "[REDACTED]")}`, { cause: error });
  } finally {
    if (locked) await blocker.query("ROLLBACK").catch(() => {});
    // Settle the owned request before restoring, including assertion failures.
    if (pending) await pending;
    try {
      if (originalValue !== undefined && !restored && connection) {
        const restore = await connection.client.callTool({ name: "update_settings", arguments: { confirm: true, small_csv_occurrence_limit: originalValue } }, undefined, { timeout: 15_000 });
        assert.notEqual(restore.isError, true, "Failed contention verification still restores its owned setting");
      }
    } finally {
      await Promise.allSettled([
        ...(connection ? [connection.client.close()] : []),
        ...(blockerConnected ? [blocker.end()] : []),
        ...(monitorConnected ? [monitor.end()] : []),
      ]);
    }
  }
}
