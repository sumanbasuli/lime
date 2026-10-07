import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installerCompose = `services:
  db:
    ports: !override
      - "127.0.0.1:17432:5432"
  shopkeeper:
    ports: !override
      - "127.0.0.1:18080:8080"
  ui:
    ports: !override
      - "127.0.0.1:15000:3000"
`;

async function fixture(composeFile) {
  const directory = await mkdtemp(path.join(tmpdir(), "lime-start-dev-"));
  for (const name of ["Makefile", "VERSION", "docker-compose.yml", "docker-compose.dev.yml"]) {
    await copyFile(path.join(repository, name), path.join(directory, name));
  }
  await writeFile(path.join(directory, "docker-compose.install.yml"), installerCompose);
  await writeFile(path.join(directory, ".env"), [
    "POSTGRES_USER=lime",
    "POSTGRES_PASSWORD=test-only-password",
    "POSTGRES_DB=lime_db",
    "LIME_DB_PORT=17432",
    "LIME_API_PORT=18080",
    "LIME_UI_PORT=15000",
    ...(composeFile ? [`COMPOSE_FILE=${composeFile}`] : []),
    "",
  ].join("\n"));
  const environment = { ...process.env };
  delete environment.COMPOSE_FILE;
  return {
    directory,
    environment,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

function dryRun({ directory, environment }) {
  const result = spawnSync("make", ["-n", "start-dev", "DOCKER_COMPOSE=docker compose"], {
    cwd: directory,
    env: environment,
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout;
}

test("installer-managed start-dev keeps the localhost override last", async () => {
  const setup = await fixture("docker-compose.yml:docker-compose.install.yml");
  try {
    const output = dryRun(setup);
    assert.match(output, /docker compose up -d db/);
    assert.match(output, /docker compose -f docker-compose\.yml -f docker-compose\.dev\.yml -f docker-compose\.install\.yml up -d --build shopkeeper/);
    assert.match(output, /docker compose -f docker-compose\.yml -f docker-compose\.dev\.yml -f docker-compose\.install\.yml up -d --build --force-recreate ui/);
  } finally {
    await setup.cleanup();
  }
});

test("manual start-dev does not pick up an installer override merely because the file exists", async () => {
  for (const selected of [undefined, "docker-compose.yml:custom.yml"]) {
    const setup = await fixture(selected);
    try {
      const output = dryRun(setup);
      assert.match(output, /docker compose -f docker-compose\.yml -f docker-compose\.dev\.yml up -d --build shopkeeper/);
      assert.doesNotMatch(output, /docker compose -f docker-compose\.yml -f docker-compose\.dev\.yml -f docker-compose\.install\.yml/);
    } finally {
      await setup.cleanup();
    }
  }
});

test("installer hot-reload Compose config binds every published port to localhost", async (t) => {
  const version = spawnSync("docker", ["compose", "version", "--short"], { encoding: "utf8", timeout: 15_000 });
  if (version.status !== 0) return t.skip("Docker Compose CLI is unavailable; no daemon is required for this check");

  const setup = await fixture("docker-compose.yml:docker-compose.install.yml");
  try {
    const config = spawnSync("docker", [
      "compose", "--env-file", ".env",
      "-f", "docker-compose.yml", "-f", "docker-compose.dev.yml", "-f", "docker-compose.install.yml",
      "config", "--format", "json",
    ], { cwd: setup.directory, env: setup.environment, encoding: "utf8", timeout: 15_000 });
    assert.equal(config.status, 0, config.stderr || config.error?.message);
    const services = JSON.parse(config.stdout).services;
    for (const name of ["db", "shopkeeper", "ui"]) {
      assert.equal(services[name].ports.length, 1, `${name} should have one published port`);
      assert.equal(services[name].ports[0].host_ip, "127.0.0.1", `${name} must remain localhost-only`);
    }
    assert.equal(services.ui.build.target, "dev", "hot reload must remain enabled");
  } finally {
    await setup.cleanup();
  }
});
