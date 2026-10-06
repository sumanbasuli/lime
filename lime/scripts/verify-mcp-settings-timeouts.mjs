import assert from "node:assert/strict";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(new URL("../package.json", import.meta.url));
const ts = require("typescript");
const { sql } = require("drizzle-orm");
const { PgDialect } = require("drizzle-orm/pg-core");
const dialect = new PgDialect();
const key = "controlled-settings-unit-key";
const compile = (source) => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

async function loadSettings({ allowWrites = true, failLock = false } = {}) {
  const calls = [];
  const config = {};
  vm.runInNewContext(compile(await readFile(new URL("../src/lib/report-settings-config.ts", import.meta.url), "utf8")), { exports: config });
  const row = {
    key: "global", ...config.DEFAULT_REPORT_SETTINGS, ...config.DEFAULT_PERFORMANCE_SETTINGS,
    mcpEnabled: true, mcpAllowWrites: allowWrites,
    mcpKeyHash: createHash("sha256").update(key).digest("hex"),
    mcpKeyHint: "...unit", mcpKeyGeneratedAt: new Date(0),
  };
  const tx = {
    execute: async (query) => { calls.push(dialect.sqlToQuery(query).sql); },
    insert: () => ({ values: () => ({ onConflictDoNothing: async () => { calls.push("insert"); } }) }),
    select: () => ({ from: () => ({ where: () => ({ for: async (mode) => {
      calls.push(`lock:${mode}`);
      if (failLock) throw new Error("controlled database lock timeout");
      return [row];
    } }) }) }),
    update: () => ({ set: (patch) => ({ where: async () => { calls.push("update"); Object.assign(row, patch); } }) }),
  };
  const dependencies = {
    "drizzle-orm": { sql, eq: (field, value) => [field, value] },
    crypto: { createHash, randomBytes, timingSafeEqual },
    "@/db/schema": { appSettings: { key: "key" } },
    "@/lib/report-settings-config": config,
    "@/db": { db: { transaction: async (work) => {
      try { const result = await work(tx); calls.push("commit"); return result; }
      catch (error) { calls.push("rollback"); throw error; }
    } } },
  };
  const exports = {};
  vm.runInNewContext(compile(await readFile(new URL("../src/lib/report-settings.ts", import.meta.url), "utf8")), {
    exports, Buffer, Date,
    require: (name) => { assert.ok(name in dependencies, `Unexpected dependency: ${name}`); return dependencies[name]; },
  });
  return { ...exports, calls, row };
}

test("MCP-only local SQL timeouts precede insert, row locking and settings update", async () => {
  const settings = await loadSettings();
  const result = await settings.saveSystemSettings({ reporting: { smallCsvOccurrenceLimit: 3 } }, `Bearer ${key}`);
  assert.deepEqual(settings.calls, ["SET LOCAL lock_timeout = '5s'", "SET LOCAL statement_timeout = '20s'", "insert", "lock:update", "update", "commit"]);
  assert.equal(result.reporting.smallCsvOccurrenceLimit, 3);
});

test("ordinary dashboard settings saves introduce no local SQL timeout or pool change", async () => {
  const settings = await loadSettings();
  await settings.saveSystemSettings({ reporting: { smallCsvOccurrenceLimit: 4 } });
  assert.deepEqual(settings.calls, ["insert", "lock:update", "update", "commit"]);
});

test("a failed locking statement rejects without update or commit", async () => {
  const settings = await loadSettings({ failLock: true });
  await assert.rejects(settings.saveSystemSettings({ reporting: { smallCsvOccurrenceLimit: 3 } }, `Bearer ${key}`), /controlled database lock timeout/);
  assert.deepEqual(settings.calls, ["SET LOCAL lock_timeout = '5s'", "SET LOCAL statement_timeout = '20s'", "insert", "lock:update", "rollback"]);
  assert.equal(settings.row.smallCsvOccurrenceLimit, 5);
});

test("MCP permission is still rechecked under the settings row lock", async () => {
  const settings = await loadSettings({ allowWrites: false });
  await assert.rejects(settings.saveSystemSettings({ reporting: { smallCsvOccurrenceLimit: 3 } }, `Bearer ${key}`), /lacks write permission/);
  assert.deepEqual(settings.calls, ["SET LOCAL lock_timeout = '5s'", "SET LOCAL statement_timeout = '20s'", "insert", "lock:update", "rollback"]);
  assert.equal(settings.row.smallCsvOccurrenceLimit, 5);
});
