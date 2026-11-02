import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(new URL("../package.json", import.meta.url));
const pg = require("pg");
const ts = require("typescript");
const fixtureUrl = process.env.LIME_TEST_DATABASE_URL;

function validateFixtureUrl(raw) {
  const url = new URL(raw);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.equal(url.hostname, "localhost", "Only the disposable Unix-socket fixture is allowed");
  assert.equal(url.pathname, "/lime_report");
  assert.equal(url.password, "", "The fixture must not contain real credentials");
  assert.equal(url.hash, "");
  assert.match(url.searchParams.get("host") ?? "", /^\/(?:private\/)?tmp\/lime-pg-report-[A-Za-z0-9]+\/pg\/socket$/);
  assert.match(url.searchParams.get("port") ?? "", /^\d{4,5}$/);
  assert.ok(Number(url.searchParams.get("port")) >= 1024 && Number(url.searchParams.get("port")) <= 65535);
  assert.equal(url.searchParams.get("sslmode"), "disable");
  const names = [...url.searchParams.keys()];
  assert.equal(names.length, new Set(names).size, "Duplicate connection options are not allowed");
  assert.ok(names.every((name) => ["host", "port", "sslmode"].includes(name)), "Unexpected connection option");
  return url;
}

test("HTML SQL fixture refuses ordinary databases, TCP hosts, and connection overrides", () => {
  const safe = "postgresql://fixture@localhost/lime_report?host=%2Fprivate%2Ftmp%2Flime-pg-report-abc123%2Fpg%2Fsocket&port=55439&sslmode=disable";
  assert.equal(validateFixtureUrl(safe).pathname, "/lime_report");
  for (const changed of [
    safe.replace("localhost", "127.0.0.1"),
    safe.replace("lime_report?", "production?"),
    safe.replace("fixture@", "fixture:secret@"),
    safe.replace("lime-pg-report-abc123", "existing-postgres"),
    safe + "&options=-csearch_path%3Dpublic",
    safe + "&host=other-server",
  ]) assert.throws(() => validateFixtureUrl(changed));
});

test("HTML report preflight enforces real PostgreSQL row and byte budgets before raw fetch", {
  skip: !fixtureUrl && "Set LIME_TEST_DATABASE_URL to the isolated private-socket fixture",
  timeout: 45_000,
}, async () => {
  const url = validateFixtureUrl(fixtureUrl);
  const socket = realpathSync(url.searchParams.get("host"));
  assert.ok(
    /\/codex-security-artifacts-[a-f0-9]+\/pg-report-[A-Za-z0-9]+\/socket$/.test(socket)
      || /^\/(?:private\/)?tmp\/lime-pg-report-[A-Za-z0-9]+\/pg\/socket$/.test(socket),
    "The socket must resolve into a disposable fixture directory",
  );
  const admin = new pg.Client({ connectionString: url.href, connectionTimeoutMillis: 5000 });
  await admin.connect();
  const schema = `lime_html_test_${randomUUID().replaceAll("-", "")}`;
  let created = false;
  const clients = [];
  const trace = [];
  let afterPreflight;
  try {
    const { rows: [server] } = await admin.query("SELECT current_database() AS db, inet_server_addr() AS address, current_setting('data_directory') AS directory");
    assert.equal(server.db, "lime_report");
    assert.equal(server.address, null);
    assert.equal(realpathSync(server.directory), path.join(path.dirname(socket), "data"));
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await admin.query(`CREATE TABLE "${schema}".evidence (id integer PRIMARY KEY, snippet text NOT NULL)`);
    await admin.query(`INSERT INTO "${schema}".evidence VALUES (1, 'original'), (2, 'second')`);

    class ObservedClient extends pg.Client {
      query(...args) {
        const sql = typeof args[0] === "string" ? args[0] : args[0]?.text ?? "";
        const entry = { sql };
        trace.push(entry);
        const result = super.query(...args);
        if (!result?.then) return result;
        return result.then(async (value) => {
          entry.rowCount = value.rowCount;
          if (sql.startsWith("WITH html_report_rows") && afterPreflight) await afterPreflight();
          return value;
        });
      }
    }
    const source = await readFile(new URL("../src/lib/html-report-read.ts", import.meta.url), "utf8");
    const compiled = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const exported = {};
    vm.runInNewContext(compiled, {
      exports: exported,
      require(name) {
        if (name === "server-only") return {};
        if (name === "drizzle-orm/node-postgres") return { drizzle: () => ({}) };
        if (name === "@/db") return { pool: {
          async connect() {
            const client = new ObservedClient({ connectionString: url.href, connectionTimeoutMillis: 5000 });
            await client.connect();
            client.release = () => { void client.end(); };
            clients.push(client);
            return client;
          },
        } };
        if (name === "@/db/schema") return {};
        throw new Error(`Unexpected dependency: ${name}`);
      },
      BigInt, Number,
    });
    const { withHtmlReportRead, HtmlReportTooLargeError } = exported;
    const projection = `SELECT id, snippet FROM "${schema}".evidence ORDER BY id`;
    const rawFetches = () => trace.filter((entry) => entry.sql === projection);

    const ordinary = await withHtmlReportRead((context) => context.query(projection, [], 2));
    assert.deepEqual(ordinary.rows.map((row) => [row.id, row.snippet]), [[1, "original"], [2, "second"]]);
    assert.equal(rawFetches().length, 1);
    assert.ok(trace.some((entry) => entry.sql.startsWith("WITH html_report_rows") && entry.sql.includes(projection)));

    trace.length = 0;
    const tooMany = "SELECT n, 'x'::text FROM generate_series(1, 4097) AS n";
    await assert.rejects(withHtmlReportRead((context) => context.query(tooMany, [], 2)),
      (error) => error instanceof HtmlReportTooLargeError);
    assert.ok(trace.some((entry) => entry.sql.startsWith("WITH html_report_rows") && entry.sql.includes(tooMany)));
    assert.ok(!trace.some((entry) => entry.sql === tooMany), "Over-row projection must not reach Node");
    assert.equal(trace.at(-1).sql, "ROLLBACK");

    trace.length = 0;
    const huge = "SELECT 1 AS id, repeat('x', $1)::text AS snippet";
    await assert.rejects(withHtmlReportRead((context) => context.query(huge, [1_400_000], 2)),
      (error) => error instanceof HtmlReportTooLargeError);
    assert.ok(trace.some((entry) => entry.sql.startsWith("WITH html_report_rows") && entry.sql.includes(huge)));
    assert.ok(!trace.some((entry) => entry.sql === huge), "Over-byte projection must not reach Node");
    assert.equal(trace.at(-1).sql, "ROLLBACK");

    trace.length = 0;
    afterPreflight = async () => {
      afterPreflight = undefined;
      await admin.query(`UPDATE "${schema}".evidence SET snippet='changed' WHERE id=1`);
    };
    const snapshot = await withHtmlReportRead((context) => context.query(projection, [], 2));
    assert.equal(snapshot.rows[0].snippet, "original", "Fetch must use the preflight snapshot");
    assert.equal((await admin.query(`SELECT snippet FROM "${schema}".evidence WHERE id=1`)).rows[0].snippet, "changed");
    assert.equal(rawFetches().length, 1);
  } finally {
    await Promise.allSettled(clients.map((client) => client.end()));
    if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
