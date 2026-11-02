import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const composeFiles = ["docker-compose.yml", "docker-compose.release.yml", "docker-compose.docs.yml"];
const twoGiB = 2 * 1024 ** 3;
const threeGiB = 3 * 1024 ** 3;
const fixtureEnv = {
  ...process.env,
  POSTGRES_USER: "lime",
  POSTGRES_PASSWORD: "fixture-only",
  POSTGRES_DB: "lime",
  DATABASE_URL: "postgresql://fixture:fixture@db.invalid/lime",
  SHOPKEEPER_URL: "http://shopkeeper:8080",
  LIME_IMAGE_TAG: "vFixture",
  LIME_DOCS_DB_PASSWORD: "fixture-only",
  LIME_VERSION: "fixture",
};
delete fixtureEnv.LIME_SHOPKEEPER_MEMORY_LIMIT;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    ...options,
  });
  assert.ifError(result.error);
  return result;
}

function composeConfig(filename, extraEnv = {}) {
  return run("docker", ["compose", "--env-file", "/dev/null", "-f", filename, "config", "--format", "json"], {
    env: { ...fixtureEnv, ...extraEnv },
  });
}

function hasCompose() {
  const result = spawnSync("docker", ["compose", "version"], { encoding: "utf8", timeout: 10_000 });
  return !result.error && result.status === 0;
}

function memoryBytes(value) {
  if (typeof value === "number") return value;
  assert.equal(typeof value, "string", `unexpected Compose memory value: ${String(value)}`);
  const match = /^(\d+)([kmgt]?)(?:i?b)?$/i.exec(value);
  assert.ok(match, `unexpected Compose memory format: ${value}`);
  return Number(match[1]) * 1024 ** ({ "": 0, k: 1, m: 2, g: 3, t: 4 }[match[2].toLowerCase()]);
}

function assertBackendLimit(config, expectedBytes, label) {
  const services = JSON.parse(config).services;
  assert.ok(services?.shopkeeper, `${label}: missing Shopkeeper service`);
  assert.equal(memoryBytes(services.shopkeeper.mem_limit), expectedBytes, `${label}: RAM cap`);
  assert.equal(memoryBytes(services.shopkeeper.memswap_limit), expectedBytes, `${label}: combined RAM/swap cap`);
  for (const name of ["db", "ui"]) {
    if (!services[name]) continue;
    assert.equal(services[name].mem_limit, undefined, `${label}: unexpected ${name} RAM cap`);
    assert.equal(services[name].memswap_limit, undefined, `${label}: unexpected ${name} swap cap`);
  }
}

test("all Compose deployments resolve the default and overridden backend limits", (t) => {
  if (!hasCompose()) {
    t.skip("Docker Compose CLI is required for daemon-free interpolation checks");
    return;
  }
  for (const filename of composeFiles) {
    const fullPath = path.join(root, filename);
    const defaultConfig = composeConfig(fullPath);
    assert.equal(defaultConfig.status, 0, `${filename}: ${defaultConfig.stderr}`);
    assertBackendLimit(defaultConfig.stdout, twoGiB, filename);

    const overridden = composeConfig(fullPath, { LIME_SHOPKEEPER_MEMORY_LIMIT: "3g" });
    assert.equal(overridden.status, 0, `${filename} override: ${overridden.stderr}`);
    assertBackendLimit(overridden.stdout, threeGiB, `${filename} override`);

    const invalid = composeConfig(fullPath, { LIME_SHOPKEEPER_MEMORY_LIMIT: "not-a-memory-size" });
    assert.notEqual(invalid.status, 0, `${filename}: invalid memory override was accepted`);
    assert.match(invalid.stderr, /mem|size|unit|byte/i, `${filename}: failure was unrelated to memory parsing`);
  }
});

test("native backend unit sets a whole-service RAM and swap limit", async () => {
  const source = await readFile(path.join(root, "deploy/debian/systemd/lime-shopkeeper.service"), "utf8");
  const serviceSection = source.split(/^\[Service\]\s*$/m)[1]?.split(/^\[[^\]]+\]\s*$/m)[0];
  assert.ok(serviceSection, "native Shopkeeper service section missing");
  const setting = (key) => serviceSection.match(new RegExp(`^${key}=(.*)$`, "gm")) ?? [];
  assert.deepEqual(setting("MemoryAccounting"), ["MemoryAccounting=yes"]);
  assert.deepEqual(setting("MemoryMax"), ["MemoryMax=2G"]);
  assert.deepEqual(setting("MemorySwapMax"), ["MemorySwapMax=0"]);
});

test("release bundle and tarball retain the backend memory policy", async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "lime-backend-memory-bundle-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const checkout = path.join(temporary, "checkout");
  for (const directory of ["scripts", "deploy/release", "deploy/docker", "data"]) {
    await mkdir(path.join(checkout, directory), { recursive: true });
  }
  for (const filename of ["build-release-bundle.sh", "validate-release-version.sh"]) {
    await copyFile(path.join(root, "scripts", filename), path.join(checkout, "scripts", filename));
  }
  for (const filename of ["README.md", ".env.example"]) {
    await copyFile(path.join(root, "deploy/release", filename), path.join(checkout, "deploy/release", filename));
  }
  for (const filename of ["chromium-seccomp.json", "LICENSE.moby", "README.md"]) {
    await copyFile(path.join(root, "deploy/docker", filename), path.join(checkout, "deploy/docker", filename));
  }
  await copyFile(path.join(root, "docker-compose.release.yml"), path.join(checkout, "docker-compose.release.yml"));
  await writeFile(path.join(checkout, "data/fixture.json"), "{}\n");

  const build = run("bash", [path.join(checkout, "scripts/build-release-bundle.sh"), "9.9.9"], { cwd: checkout });
  assert.equal(build.status, 0, build.stderr);
  const bundlePath = path.join(checkout, "dist/release/lime-v9.9.9/docker-compose.release.yml");
  const bundled = await readFile(bundlePath, "utf8");
  const source = await readFile(path.join(root, "docker-compose.release.yml"), "utf8");
  assert.equal(bundled, source, "bundle changed or omitted the release Compose policy");

  const archive = path.join(checkout, "dist/lime-v9.9.9-release.tar.gz");
  const extract = run("tar", ["-xOzf", archive, "lime-v9.9.9/docker-compose.release.yml"], { cwd: checkout });
  assert.equal(extract.status, 0, extract.stderr);
  assert.equal(extract.stdout, source, "archive changed or omitted the release Compose policy");

  if (!hasCompose()) {
    t.diagnostic("Docker Compose unavailable; exact bundle bytes were checked, but bundle interpolation was skipped");
    return;
  }
  const bundledConfig = composeConfig(bundlePath);
  assert.equal(bundledConfig.status, 0, bundledConfig.stderr);
  assertBackendLimit(bundledConfig.stdout, twoGiB, "release bundle");
  const bundleOverride = composeConfig(bundlePath, { LIME_SHOPKEEPER_MEMORY_LIMIT: "3g" });
  assert.equal(bundleOverride.status, 0, bundleOverride.stderr);
  assertBackendLimit(bundleOverride.stdout, threeGiB, "release bundle override");
});
