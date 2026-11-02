import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Duplex } from "node:stream";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(new URL("../package.json", import.meta.url));
const ts = require("typescript");
const source = await readFile(new URL("../src/lib/mcp-report-read.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const ROW_LIMIT = 16_384;
const BYTE_LIMIT = 32 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const turn = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function clock() {
  let now = 1_000;
  const timers = [];
  return {
    timers,
    Date: class extends Date { static now() { return now; } },
    setTimeout(callback, delay) {
      const timer = { callback, delay, at: now + delay, active: true, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) { if (timer) timer.active = false; },
    advance(milliseconds) {
      now += milliseconds;
      for (;;) {
        const timer = timers.find((value) => value.active && value.at <= now);
        if (!timer) break;
        timer.active = false;
        timer.callback();
      }
    },
    pending() { return timers.filter((timer) => timer.active); },
  };
}

// Exercise the real context with controlled wire/Drizzle seams. These mocks
// establish ownership and query ordering, not PostgreSQL cancellation behavior.
function fixture(options = {}) {
  const time = clock();
  const clients = [];
  const calls = [];
  const measurements = [...(options.measurements ?? [])];
  let peakQueries = 0;
  let activeQueries = 0;
  class Client extends EventEmitter {
    constructor(config) {
      super();
      this.config = config;
      this.pending = new Set();
      this.endCount = 0;
      this.closed = false;
      clients.push(this);
    }
    async connect() {
      calls.push({ phase: "connect" });
      return this.run(() => options.connect?.(this));
    }
    run(work) {
      const pending = {};
      const result = new Promise((resolve, reject) => {
        pending.reject = reject;
        this.pending.add(pending);
        Promise.resolve().then(work).then(resolve, reject);
      });
      return result.finally(() => this.pending.delete(pending));
    }
    query(text, values) {
      const phase = text.startsWith("WITH mcp_report_rows") ? "measure"
        : text.startsWith("SELECT set_config") ? "timeout"
        : text.startsWith("SET LOCAL statement_timeout") ? "startup_timeout"
        : text.startsWith("BEGIN ") ? "begin"
        : text === "COMMIT" ? "commit"
        : text.startsWith('insert into "scan_score_summary_cache" ') ? "cache_write" : "materialize";
      const call = { phase, text, values };
      calls.push(call);
      activeQueries++;
      peakQueries = Math.max(peakQueries, activeQueries);
      return this.run(async () => {
        if (this.closed) throw new Error("controlled client already closed");
        const result = await options.query?.(call, this);
        if (result !== undefined) return result;
        if (phase === "measure") {
          const measured = measurements.shift() ?? { rows: 1, bytes: 1024 };
          return { rows: [{ row_count: String(measured.rows), byte_count: String(measured.bytes) }] };
        }
        return { rows: phase === "materialize" ? [{ value: "saved evidence" }] : [] };
      }).finally(() => activeQueries--);
    }
    async end() {
      this.endCount++;
      this.closed = true;
      calls.push({ phase: "end" });
      for (const pending of this.pending) pending.reject(new Error("controlled connection closed"));
      await options.end?.(this);
    }
  }
  const dependencies = {
    "drizzle-orm/node-postgres": { drizzle: (client) => ({ client }) },
    pg: { Client: options.Client ?? Client },
    "@/db/schema": { fixtureSchema: true },
  };
  const exports = {};
  vm.runInNewContext(compiled, {
    exports, AbortController, AbortSignal, BigInt, Buffer, Date: time.Date,
    setTimeout: time.setTimeout, clearTimeout: time.clearTimeout,
    process: { env: { DATABASE_URL: "postgres://unit-user@unit.invalid/unit-db" } },
    require: (name) => { assert.ok(name in dependencies, `Unexpected dependency: ${name}`); return dependencies[name]; },
  });
  const run = (work, signal = new AbortController().signal, readOptions) => exports.withMcpReportRead(signal, work, readOptions);
  return {
    ...exports, run, calls, clients, time,
    phase: (name) => calls.filter((call) => call.phase === name),
    peakQueries: () => peakQueries,
    select(text, values = []) {
      return {
        toSQL: () => ({ sql: text, params: values }),
        then(resolve, reject) { return clients[0].query(text, values).then((result) => result.rows).then(resolve, reject); },
      };
    },
  };
}

test("an ordinary report read remains a plain await without creating a database client", async () => {
  const f = fixture();
  let reads = 0;
  const rows = [{ value: "ordinary complete export" }];
  const query = { then(resolve) { reads++; resolve(rows); }, toSQL() { assert.fail("Ordinary reads have no preflight"); } };
  assert.equal(await f.readReportQuery(query, undefined, 1), rows);
  assert.equal(reads, 1);
  assert.equal(f.clients.length, 0);
  assert.equal(f.calls.length, 0);
});

test("normal reports keep one read-only snapshot open through the complete work lifetime", async () => {
  const f = fixture();
  const gate = deferred();
  const work = f.run(async (context) => {
    assert.equal(context.db.client, f.clients[0]);
    await f.readReportQuery(f.select("SELECT saved FROM evidence"), context, 1);
    await gate.promise;
    return "complete";
  });
  await turn();
  assert.equal(f.clients[0].config.connectionTimeoutMillis, 5_000);
  assert.equal(f.clients[0].config.statement_timeout, undefined, "Do not require a pooler to accept a statement_timeout startup parameter");
  assert.equal(f.clients[0].config.options, undefined, "Do not hide session GUCs in startup options");
  assert.equal(f.clients[0].config.application_name, "lime-mcp-report");
  assert.equal(f.clients[0].endCount, 0);
  assert.equal(f.phase("begin")[0].text, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.equal(f.phase("startup_timeout")[0].text, "SET LOCAL statement_timeout = '30000ms'");
  assert.ok(f.calls.findIndex((call) => call.phase === "begin") < f.calls.findIndex((call) => call.phase === "startup_timeout"));
  assert.equal(f.calls.some((call) => /^SET (?!LOCAL\b)/.test(call.text ?? "")), false, "A pooled session must not retain a global timeout setting");
  assert.equal(f.time.pending()[0].delay, TIMEOUT_MS);
  gate.resolve();
  assert.equal(await work, "complete");
  assert.equal(f.clients[0].endCount, 1);
  assert.equal(f.clients[0].listenerCount("error"), 0);
  assert.equal(f.time.pending().length, 0);
  assert.equal(f.calls.some((call) => call.text === "COMMIT"), false);
});

test("the returned work retains cleanup ownership until the client has ended", async () => {
  const gate = deferred();
  const f = fixture({ end: () => gate.promise });
  let settled = false;
  const work = f.run(async () => "complete");
  work.then(() => { settled = true; }, () => { settled = true; });
  await turn();
  assert.equal(f.clients[0].endCount, 1);
  assert.equal(settled, false);
  gate.resolve();
  assert.equal(await work, "complete");
  assert.equal(settled, true);
});

test("exact row and byte preparation boundaries are accepted before materialization", async () => {
  const f = fixture({ measurements: [{ rows: ROW_LIMIT, bytes: BYTE_LIMIT }] });
  const rows = await f.run((context) => context.read(f.select("SELECT saved FROM evidence"), 1));
  assert.equal(rows[0].value, "saved evidence");
  assert.deepEqual(f.calls.map((call) => call.phase), ["connect", "begin", "startup_timeout", "timeout", "measure", "timeout", "materialize", "end"]);
});

for (const [name, measured] of [
  ["one row over", { rows: ROW_LIMIT + 1, bytes: 1 }],
  ["one byte over", { rows: 1, bytes: BYTE_LIMIT + 1 }],
  ["negative row count", { rows: -1, bytes: 1 }],
  ["negative byte count", { rows: 1, bytes: -1 }],
]) {
  test(`${name} fails before raw stored fields are materialized`, async () => {
    const f = fixture({ measurements: [measured] });
    await assert.rejects(f.run((context) => context.read(f.select("SELECT hostile FROM evidence"), 1)), /report preparation limit/);
    assert.equal(f.phase("materialize").length, 0);
    assert.equal(f.phase("measure").length, 1);
    assert.equal(f.clients[0].endCount, 1);
    assert.equal(f.time.pending().length, 0);
  });
}

test("individually small reads share cumulative row and byte budgets", async () => {
  for (const mode of ["rows", "bytes"]) {
    const half = mode === "rows" ? { rows: ROW_LIMIT / 2, bytes: 1 } : { rows: 1, bytes: BYTE_LIMIT / 2 };
    const f = fixture({ measurements: [half, half, { rows: 1, bytes: 1 }] });
    await assert.rejects(f.run(async (context) => {
      await context.query("SELECT first FROM evidence", [], 1);
      await context.query("SELECT second FROM evidence", [], 1);
      await context.query("SELECT third FROM evidence", [], 1);
    }), /report preparation limit/);
    assert.equal(f.phase("materialize").length, 2);
    assert.equal(f.phase("measure").length, 3);
  }
});

test("preflight verifies exact projection width and preserves all bound parameters", async () => {
  const f = fixture();
  const text = "SELECT $1::text, $2::integer, $3::boolean";
  const params = ["a quote ' and comma, remain data", 19, false];
  await f.run((context) => context.read(f.select(text, params), 3));
  const measure = f.phase("measure")[0];
  assert.ok(measure.text.includes('mcp_report_rows ("c0", "c1", "c2")'));
  assert.ok(measure.text.includes(`(${text}) UNION ALL SELECT NULL, NULL, NULL WHERE false`));
  for (let index = 0; index < 3; index++) assert.ok(measure.text.includes(`octet_length("c${index}"::text)::numeric`));
  assert.ok(measure.text.includes("1024::numeric + 6 *"));
  assert.equal(measure.values, params);
  assert.equal(f.phase("materialize")[0].text, text);
  assert.equal(f.phase("materialize")[0].values, params);
  assert.ok(!measure.text.includes(params[0]), "Parameters are not pasted into SQL");
});

test("invalid projection widths are rejected without starting a preflight or raw read", async () => {
  for (const columns of [0, -1, 129, 1.5, NaN]) {
    const f = fixture();
    await assert.rejects(f.run((context) => context.query("SELECT saved FROM evidence", [], columns)), /Invalid report projection/);
    assert.equal(f.phase("measure").length, 0);
    assert.equal(f.phase("materialize").length, 0);
  }
});

test("concurrent readers serialize timeout, preflight and materialization as one unit", async () => {
  const gate = deferred();
  let measures = 0;
  const f = fixture({ query: async (call) => {
    if (call.phase === "measure" && ++measures === 1) await gate.promise;
  } });
  const work = f.run((context) => Promise.all([
    context.query("SELECT first FROM evidence", [1], 1),
    context.query("SELECT second FROM evidence", [2], 1),
  ]));
  await turn();
  assert.equal(f.phase("measure").length, 1);
  assert.equal(f.phase("materialize").length, 0);
  assert.equal(f.phase("timeout").length, 1);
  gate.resolve();
  await work;
  assert.deepEqual(f.calls.filter((call) => ["measure", "materialize"].includes(call.phase)).map((call) => call.phase), ["measure", "materialize", "measure", "materialize"]);
  assert.equal(f.peakQueries(), 1);
});

test("each materializing statement gets a timeout based on the remaining preparation window", async () => {
  const f = fixture({ query: (call) => {
    if (call.phase === "measure") f.time.advance(5_000);
  } });
  await f.run((context) => context.query("SELECT saved FROM evidence", [], 1));
  assert.deepEqual(f.phase("timeout").map((call) => Array.from(call.values)), [["30000ms"], ["25000ms"]]);
});

test("the first rejection stops queued readers and cannot be hidden by catching it", async () => {
  const f = fixture({ measurements: [{ rows: ROW_LIMIT + 1, bytes: 1 }] });
  await assert.rejects(f.run(async (context) => {
    const results = await Promise.allSettled([
      context.query("SELECT first FROM evidence", [], 1),
      context.query("SELECT second FROM evidence", [], 1),
      context.query("SELECT third FROM evidence", [], 1),
    ]);
    assert.ok(results.every((result) => result.status === "rejected"));
    return "must not be a partial success";
  }), /report preparation limit/);
  assert.equal(f.phase("measure").length, 1);
  assert.equal(f.phase("materialize").length, 0);
});

test("already-aborted callers create neither a client nor a timer", async () => {
  const f = fixture();
  const caller = new AbortController();
  caller.abort();
  await assert.rejects(f.run(() => assert.fail("Cancelled work cannot start"), caller.signal), { name: "AbortError" });
  assert.equal(f.clients.length, 0);
  assert.equal(f.time.timers.length, 0);
});

test("connection rejection closes the dedicated client without a phantom SQL lease", async () => {
  const f = fixture({ connect: () => { throw new Error("controlled connect rejection"); } });
  await assert.rejects(f.run(() => assert.fail("No work before connect")), /controlled connect rejection/);
  assert.equal(f.phase("startup_timeout").length, 0);
  assert.equal(f.clients[0].endCount, 1);
  assert.equal(f.clients[0].listenerCount("error"), 0);
  assert.equal(f.time.pending().length, 0);
});

test("caller abort and the preparation deadline both close a stalled connection attempt", async () => {
  for (const ending of ["caller", "deadline"]) {
    const gate = deferred();
    const f = fixture({ connect: () => gate.promise });
    const caller = new AbortController();
    const work = f.run(() => assert.fail("No work before connect"), caller.signal);
    const rejection = assert.rejects(work, /connection cancelled or timed out/);
    await turn();
    if (ending === "caller") caller.abort();
    else f.time.advance(TIMEOUT_MS);
    await rejection;
    assert.equal(f.clients[0].endCount, 1);
    assert.equal(f.phase("startup_timeout").length, 0);
    assert.equal(f.time.pending().length, 0);
    gate.resolve();
  }
});

function installedClientFixture({ refuse = false } = {}) {
  const { Client } = require("pg");
  const clients = [];
  class StartupStream extends Duplex {
    constructor() {
      super();
      this.writes = [];
    }
    _read() {}
    _write(chunk, _encoding, callback) { this.writes.push(Buffer.from(chunk)); callback(); }
    _final(callback) { callback(); this.destroy(); }
    connect() {
      queueMicrotask(() => {
        if (refuse) this.destroy(Object.assign(new Error("controlled startup refusal"), { code: "ECONNREFUSED" }));
        else this.emit("connect");
      });
    }
    setNoDelay() {}
  }
  class ControlledClient extends Client {
    constructor(config) {
      const stream = new StartupStream();
      super({ ...config, connectionString: undefined, user: "unit-user", database: "unit-db", host: "unit.invalid", password: "controlled-unused-test-value", ssl: false, stream });
      this.fixtureStream = stream;
      this.connectSettled = false;
      this.endCount = 0;
      clients.push(this);
    }
    connect() {
      const promise = super.connect();
      promise.then(() => { this.connectSettled = true; }, () => { this.connectSettled = true; });
      return promise;
    }
    end() { this.endCount++; return super.end(); }
    query() { assert.fail("No SQL before the controlled startup handshake completes"); }
  }
  return { ...fixture({ Client: ControlledClient }), installedClients: clients };
}

test("installed pg startup cancellation settles even when pg leaves its own connect promise pending", { timeout: 2_000 }, async () => {
  for (const ending of ["caller", "deadline"]) {
    const f = installedClientFixture();
    const caller = new AbortController();
    const work = f.run(() => assert.fail("A startup-silent connection cannot start report work"), caller.signal);
    const rejection = assert.rejects(work, /connection cancelled or timed out/);
    await turn();
    const client = f.installedClients[0];
    assert.ok(client.fixtureStream.writes.length > 0, "Actual pg sent its startup packet to the controlled stream");
    assert.equal(client.connectSettled, false);
    if (ending === "caller") caller.abort();
    else f.time.advance(TIMEOUT_MS);
    await rejection;
    assert.equal(client.endCount, 1);
    assert.equal(client.fixtureStream.destroyed, true);
    assert.equal(client._ended, true);
    assert.equal(client.connectSettled, false, "The helper must not rely on pg settling connect after end during startup");
    assert.equal(client.listenerCount("error"), 0);
    assert.equal(f.time.pending().length, 0);
  }
});

test("installed pg connection refusal still rejects and closes its controlled stream normally", { timeout: 2_000 }, async () => {
  const f = installedClientFixture({ refuse: true });
  await assert.rejects(f.run(() => assert.fail("Connection refusal cannot start report work")), /controlled startup refusal/);
  const client = f.installedClients[0];
  assert.equal(client.connectSettled, true);
  assert.equal(client.fixtureStream.destroyed, true);
  assert.equal(client.endCount, 1);
  assert.equal(client.listenerCount("error"), 0);
  assert.equal(f.time.pending().length, 0);
});

test("a server SQL error confirms statement completion and needs no disconnected-SQL delay", async () => {
  const error = Object.assign(new Error("controlled server statement timeout"), { severity: "ERROR", code: "57014" });
  const f = fixture({ query: (call) => {
    if (call.phase === "measure") throw error;
  } });
  await assert.rejects(f.run((context) => context.query("SELECT saved FROM evidence", [], 1)), /controlled server statement timeout/);
  assert.equal(f.phase("materialize").length, 0);
  assert.equal(f.clients[0].endCount, 1);
  assert.equal(f.time.pending().length, 0);
});

test("a broken connection retains ownership through the last enforced SQL deadline", async () => {
  const f = fixture({ query: (call) => {
    if (call.phase === "materialize") throw new Error("controlled transport failure");
  } });
  let settled = false;
  const work = f.run((context) => context.query("SELECT saved FROM evidence", [], 1));
  work.then(() => { settled = true; }, () => { settled = true; });
  const rejection = assert.rejects(work, /controlled transport failure/);
  await turn();
  assert.equal(f.clients[0].endCount, 1);
  assert.equal(settled, false);
  assert.equal(f.time.pending().length, 1);
  assert.equal(f.time.pending()[0].delay, TIMEOUT_MS);
  f.time.advance(TIMEOUT_MS - 1);
  await turn();
  assert.equal(settled, false);
  f.time.advance(1);
  await rejection;
  assert.equal(settled, true);
  assert.equal(f.time.pending().length, 0);
  assert.equal(f.clients[0].listenerCount("error"), 0);
});

test("aborting an active SQL read closes its client but does not release its lease early", async () => {
  const gate = deferred();
  const f = fixture({ query: (call) => call.phase === "materialize" ? gate.promise : undefined });
  const caller = new AbortController();
  let settled = false;
  const work = f.run((context) => context.query("SELECT saved FROM evidence", [], 1), caller.signal);
  work.then(() => { settled = true; }, () => { settled = true; });
  const rejection = assert.rejects(work, /controlled connection closed/);
  await turn();
  f.time.advance(5_000);
  caller.abort();
  await turn();
  assert.equal(f.clients[0].endCount, 1);
  assert.equal(settled, false);
  assert.equal(f.time.pending().length, 1);
  assert.equal(f.time.pending()[0].delay, TIMEOUT_MS - 5_000);
  f.time.advance(TIMEOUT_MS - 5_000);
  await rejection;
  gate.resolve({ rows: [] });
  assert.equal(f.clients[0].listenerCount("error"), 0);
});

test("the actual preparation deadline closes active SQL and stops its queued successor", async () => {
  const gate = deferred();
  const f = fixture({ query: (call) => call.phase === "measure" ? gate.promise : undefined });
  const work = f.run((context) => Promise.all([
    context.query("SELECT first FROM evidence", [], 1),
    context.query("SELECT second FROM evidence", [], 1),
  ]));
  const rejection = assert.rejects(work, /controlled connection closed/);
  await turn();
  f.time.advance(TIMEOUT_MS);
  await rejection;
  assert.equal(f.clients[0].endCount, 1);
  assert.equal(f.phase("measure").length, 1);
  assert.equal(f.phase("materialize").length, 0);
  assert.equal(f.time.pending().length, 0);
  gate.resolve({ rows: [] });
});

test("late work cannot become success after its client emits a connection error", async () => {
  const f = fixture();
  await assert.rejects(f.run(async () => {
    f.clients[0].emit("error", new Error("controlled client error"));
    return "must not succeed";
  }), /controlled client error/);
  assert.equal(f.clients[0].endCount, 1);
  assert.equal(f.time.pending().length, 0);
  assert.equal(f.clients[0].listenerCount("error"), 0);
});

const cacheWrite = (params = ["scan-fixture"], sql = 'insert into "scan_score_summary_cache" ("scan_id") values ($1) on conflict ("scan_id") do nothing') => ({ toSQL: () => ({ sql, params }) });
const scoreOptions = { scoreCacheScanId: "scan-fixture" };

test("scores and reports share two preparation slots before any third client is created", async () => {
  const f = fixture();
  const firstGate = deferred();
  const secondGate = deferred();
  const first = f.run(() => firstGate.promise, undefined, scoreOptions);
  const second = f.run(() => secondGate.promise);
  await turn();
  await assert.rejects(f.run(() => assert.fail("Busy work must not start")), f.McpReadPreparationBusyError);
  assert.equal(f.clients.length, 2);
  firstGate.resolve("score");
  assert.equal(await first, "score");
  assert.equal(await f.run(async () => "replacement"), "replacement");
  secondGate.resolve("report");
  assert.equal(await second, "report");
});

test("constructor and callback failures cannot leak preparation slots", async () => {
  const broken = fixture({ Client: class { constructor() { throw new Error("controlled invalid connection config"); } } });
  for (let index = 0; index < 3; index++) await assert.rejects(broken.run(async () => {}), /invalid connection config/);
  assert.equal(broken.time.pending().length, 0);
  const f = fixture();
  for (let index = 0; index < 3; index++) await assert.rejects(f.run(async () => { throw new Error("controlled callback"); }), /controlled callback/);
  assert.equal(await f.run(async () => "recovered"), "recovered");
});

test("a disconnected SQL statement keeps its shared slot until the server deadline", async () => {
  const slow = deferred();
  const secondGate = deferred();
  const f = fixture({ query: (call) => call.text === "SELECT slow" ? slow.promise : undefined });
  const caller = new AbortController();
  const first = f.run((context) => context.query("SELECT slow", [], 1), caller.signal, scoreOptions);
  const firstRejected = assert.rejects(first, /controlled connection closed/);
  await turn();
  f.time.advance(5_000);
  const second = f.run(() => secondGate.promise);
  await turn();
  caller.abort();
  await turn();
  await assert.rejects(f.run(async () => "too early"), f.McpReadPreparationBusyError);
  assert.equal(f.clients.length, 2);
  f.time.advance(25_000);
  await firstRejected;
  assert.equal(await f.run(async () => "replacement"), "replacement");
  secondGate.resolve("complete");
  await second;
  slow.resolve({ rows: [] });
});

test("default report snapshots cannot stage writes; score publication waits for reads and commits separately", async () => {
  const f = fixture();
  await f.run(async (context) => assert.equal(context.stageScoreCache, undefined));
  const gate = deferred();
  const params = ["scan-fixture"];
  const work = f.run(async (context) => {
    context.stageScoreCache(cacheWrite(params));
    params[0] = "changed-after-admission";
    assert.equal(f.phase("cache_write").length, 0);
    await context.query("SELECT saved", [], 1);
    await gate.promise;
    return "complete";
  }, undefined, scoreOptions);
  await turn();
  assert.equal(f.phase("cache_write").length, 0);
  gate.resolve();
  assert.equal(await work, "complete");
  assert.deepEqual(Array.from(f.phase("cache_write")[0].values), ["scan-fixture"]);
  const writeBegin = f.calls.findIndex((call) => call.text === "BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE");
  const writeIndex = f.calls.findIndex((call) => call.phase === "cache_write");
  assert.ok(writeBegin > f.calls.findIndex((call) => call.phase === "commit"));
  assert.ok(writeIndex > writeBegin);
  assert.equal(f.calls[writeBegin + 1].phase, "startup_timeout");
  assert.equal(f.phase("commit").length, 2);
  assert.ok(f.calls.findLastIndex((call) => call.phase === "commit") < f.calls.findLastIndex((call) => call.phase === "end"));
});

test("only one bounded fixed-scalar cache upsert for the authorized scan can be staged", async () => {
  for (const [name, query] of [
    ["wrong scan", cacheWrite(["other-scan"])],
    ["wrong table", cacheWrite(["scan-fixture"], 'insert into "app_settings" values ($1)')],
    ["returning", cacheWrite(["scan-fixture"], 'insert into "scan_score_summary_cache" values ($1) returning *')],
    ["multiple statements", cacheWrite(["scan-fixture"], 'insert into "scan_score_summary_cache" values ($1); select 1')],
    ["oversized parameter", cacheWrite(["scan-fixture", "x".repeat(4097)])],
    ["too many parameters", cacheWrite(["scan-fixture", ...Array(128).fill(1)])],
    ["object parameter", cacheWrite(["scan-fixture", { unsafe: "object" }])],
    ["nonfinite parameter", cacheWrite(["scan-fixture", Infinity])],
  ]) {
    const f = fixture();
    await assert.rejects(f.run(async (context) => context.stageScoreCache(query), undefined, scoreOptions), /Invalid MCP score cache publication/, name);
    assert.equal(f.phase("cache_write").length, 0, name);
  }
  const f = fixture();
  await assert.rejects(f.run(async (context) => {
    context.stageScoreCache(cacheWrite());
    context.stageScoreCache(cacheWrite());
  }, undefined, scoreOptions), /Invalid MCP score cache publication/);
  assert.equal(f.phase("cache_write").length, 0);
});

test("failed work never publishes a staged cache; SQL publication failures cannot become success", async () => {
  const f = fixture();
  await assert.rejects(f.run(async (context) => {
    context.stageScoreCache(cacheWrite());
    throw new Error("controlled score failure");
  }, undefined, scoreOptions), /controlled score failure/);
  assert.equal(f.phase("cache_write").length, 0);
  const serverError = Object.assign(new Error("controlled cache lock timeout"), { severity: "ERROR", code: "57014" });
  const broken = fixture({ query: (call) => { if (call.phase === "cache_write") throw serverError; } });
  await assert.rejects(broken.run(async (context) => context.stageScoreCache(cacheWrite()), undefined, scoreOptions), /cache lock timeout/);
  assert.equal(broken.phase("commit").length, 1, "No write COMMIT after publication failed");
  assert.equal(broken.time.pending().length, 0);
  assert.equal(await broken.run(async () => "recovered"), "recovered");
});

test("cache publication uses the remaining deadline and refuses reads after closing the snapshot", async () => {
  let commits = 0;
  let savedContext;
  let lateRead;
  const f = fixture({ query: (call) => {
    if (call.phase === "commit" && ++commits === 1) f.time.advance(5_000);
    if (call.phase === "cache_write") lateRead = assert.rejects(savedContext.query("SELECT too_late", [], 1), /snapshot is closed/);
  } });
  await assert.rejects(f.run(async (context) => {
    savedContext = context;
    context.stageScoreCache(cacheWrite());
  }, undefined, scoreOptions), /snapshot is closed/);
  await lateRead;
  assert.equal(f.phase("materialize").length, 0);
  assert.ok(f.phase("timeout").some((call) => call.values[0] === "25000ms"));
  assert.equal(f.phase("commit").length, 1, "A late reader failure prevents write COMMIT");
});
