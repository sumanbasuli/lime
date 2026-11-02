import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helper = path.join(repo, "scripts/docs-db-credential.sh");
const compose = path.join(repo, "docker-compose.docs.yml");

function shell(command, environment = {}) {
  const env = { ...process.env, ...environment };
  if (!("LIME_DOCS_DB_PASSWORD" in environment)) delete env.LIME_DOCS_DB_PASSWORD;
  return spawnSync("bash", ["-c", 'source "$1"; ' + command, "lime-docs-test", helper], {
    cwd: repo, env, encoding: "utf8", timeout: 15_000,
  });
}

test("docs database credential is unique, URL-safe, and respects an explicit value", () => {
  const first = shell('lime_docs_db_credential; printf "%s" "$LIME_DOCS_DB_PASSWORD"');
  const second = shell('lime_docs_db_credential; printf "%s" "$LIME_DOCS_DB_PASSWORD"');
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.match(first.stdout, /^[0-9a-f]{48}$/);
  assert.match(second.stdout, /^[0-9a-f]{48}$/);
  assert.notEqual(first.stdout, second.stdout);

  const preserved = shell('lime_docs_db_credential; printf "%s" "$LIME_DOCS_DB_PASSWORD"', { LIME_DOCS_DB_PASSWORD: "manual-test-password-0001" });
  assert.equal(preserved.status, 0, preserved.stderr);
  assert.equal(preserved.stdout, "manual-test-password-0001");
  for (const bad of ["short", "has@unsafe", "has space in it"]) {
    const rejected = shell("lime_docs_db_credential", { LIME_DOCS_DB_PASSWORD: bad });
    assert.notEqual(rejected.status, 0, `${bad} must not be embedded in DATABASE_URL`);
  }

  const isolated = shell('lime_docs_without_password bash -c \'test -z "${LIME_DOCS_DB_PASSWORD+x}"\' || exit 1; printf "%s" "$LIME_DOCS_DB_PASSWORD"', { LIME_DOCS_DB_PASSWORD: "manual-test-password-0001" });
  assert.equal(isolated.status, 0, isolated.stderr);
  assert.equal(isolated.stdout, "manual-test-password-0001", "the parent retains the credential after invoking a dependency tool");
});

test("verification runner refuses retained project resources without invoking Compose", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "lime-docs-credential-"));
  const fakeDocker = path.join(fixture, "docker");
  const trace = path.join(fixture, "docker-calls");
  try {
    await writeFile(fakeDocker, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$LIME_TEST_DOCKER_TRACE"
case "$1 $2" in
  'ps -aq')
    [[ "$LIME_TEST_DOCKER_STATE" != error ]] || exit 1
    [[ "$LIME_TEST_DOCKER_STATE" != container ]] || printf 'owned-container\\n';;
  'volume ls')
    [[ "$LIME_TEST_DOCKER_STATE" != error ]] || exit 1
    [[ "$LIME_TEST_DOCKER_STATE" != volume ]] || printf 'lime-verification_pgdata\\n';;
  'volume inspect') [[ "$LIME_TEST_DOCKER_STATE" == unlabeled ]];;
  *) exit 88;;
esac
`, { mode: 0o700 });
    for (const [state, allowed] of [["fresh", true], ["container", false], ["volume", false], ["unlabeled", false], ["error", false]]) {
      await writeFile(trace, "");
      const result = shell("lime_verify_project_unoccupied", {
        PATH: `${fixture}${path.delimiter}${process.env.PATH}`,
        LIME_TEST_DOCKER_TRACE: trace,
        LIME_TEST_DOCKER_STATE: state,
      });
      assert.equal(result.status === 0, allowed, `${state}: ${result.stderr}`);
      const calls = (await readFile(trace, "utf8")).trim().split("\n");
      assert.ok(calls.every((call) => /^ps -aq --filter |^volume ls -q --filter |^volume inspect lime-verification_(pgdata|screenshots)$/.test(call)), `${state}: only read-only Docker inventory is allowed`);
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("docs Compose refuses a missing credential and shares an explicit one", (t) => {
  const version = spawnSync("docker", ["compose", "version", "--short"], { encoding: "utf8", timeout: 15_000 });
  if (version.status !== 0) return t.skip("Docker Compose CLI unavailable; config needs no daemon");
  const env = { ...process.env };
  delete env.LIME_DOCS_DB_PASSWORD;
  delete env.COMPOSE_FILE;
  delete env.COMPOSE_PROJECT_NAME;
  const args = ["compose", "--env-file", "/dev/null", "-f", compose, "config", "--format", "json"];
  const missing = spawnSync("docker", args, { cwd: repo, env, encoding: "utf8", timeout: 15_000 });
  assert.notEqual(missing.status, 0, "a manual stack must not start with the published password");
  const password = "a".repeat(48);
  const configured = spawnSync("docker", args, { cwd: repo, env: { ...env, LIME_DOCS_DB_PASSWORD: password }, encoding: "utf8", timeout: 15_000 });
  assert.equal(configured.status, 0, configured.stderr);
  const services = JSON.parse(configured.stdout).services;
  assert.equal(services.db.environment.POSTGRES_PASSWORD, password);
  assert.equal(services.shopkeeper.environment.DATABASE_URL, `postgresql://lime:${password}@db:5432/lime_docs_db?sslmode=disable`);
  assert.equal(services.ui.environment.DATABASE_URL, services.shopkeeper.environment.DATABASE_URL);
  for (const name of ["db", "shopkeeper", "ui"]) {
    assert.equal(services[name].ports[0].host_ip, "127.0.0.1", `${name} remains bound to loopback by default`);
  }
});

test("installed AI client subprocesses never inherit the disposable database password", async (t) => {
  if (!existsSync(path.join(repo, "docs-site/node_modules/@modelcontextprotocol/sdk"))) {
    return t.skip("Docs-site MCP SDK is not installed");
  }
  const { runInstalledCli } = await import("../docs-site/scripts/verify-mcp-installed-clients.mjs");
  const childCode = 'process.stdout.write(JSON.stringify({ hasDbPassword: "LIME_DOCS_DB_PASSWORD" in process.env, hasMcpKey: process.env.LIME_MCP_KEY === "test-key" }))';
  const inherited = process.env.LIME_DOCS_DB_PASSWORD;
  const inheritedKey = process.env.LIME_MCP_KEY;
  try {
    process.env.LIME_DOCS_DB_PASSWORD = "test-db-secret";
    process.env.LIME_MCP_KEY = "test-key";
    const result = await runInstalledCli(process.execPath, ["-e", childCode], { timeout: 15_000 });
    assert.deepEqual(JSON.parse(result.stdout), { hasDbPassword: false, hasMcpKey: true });
  } finally {
    if (inherited === undefined) delete process.env.LIME_DOCS_DB_PASSWORD;
    else process.env.LIME_DOCS_DB_PASSWORD = inherited;
    if (inheritedKey === undefined) delete process.env.LIME_MCP_KEY;
    else process.env.LIME_MCP_KEY = inheritedKey;
  }
  const explicit = await runInstalledCli(process.execPath, ["-e", childCode], {
    env: { ...process.env, LIME_DOCS_DB_PASSWORD: "test-db-secret", LIME_MCP_KEY: "test-key" }, timeout: 15_000,
  });
  assert.deepEqual(JSON.parse(explicit.stdout), { hasDbPassword: false, hasMcpKey: true });
});
