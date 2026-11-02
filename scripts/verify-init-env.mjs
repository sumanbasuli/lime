import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, lstat, mkdtemp, readFile, symlink, writeFile, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const compose = await readFile(path.join(repo, "docker-compose.yml"), "utf8");
assert.equal((compose.match(/\$\{POSTGRES_PASSWORD:\?/g) ?? []).length, 3, "all source services must require a configured database password");
assert.doesNotMatch(compose, /lime_dev_password/, "source Compose must not have a published password fallback");
const fixture = await mkdtemp(path.join(os.tmpdir(), "lime-init-env-test-"));
const scripts = path.join(fixture, "scripts");
const bin = path.join(fixture, "bin");
const command = path.join(scripts, "init-env.sh");
const envPath = path.join(fixture, ".env");
try {
  await mkdir(scripts);
  await mkdir(bin);
  await copyFile(path.join(repo, "scripts", "init-env.sh"), command);
  await copyFile(path.join(repo, ".env.example"), path.join(fixture, ".env.example"));
  await copyFile(path.join(repo, "Makefile"), path.join(fixture, "Makefile"));
  await copyFile(path.join(repo, "VERSION"), path.join(fixture, "VERSION"));
  const template = await readFile(path.join(fixture, ".env.example"), "utf8");
  assert.match(template, /^POSTGRES_PASSWORD=$/m);
  await writeFile(path.join(bin, "docker"), `#!/usr/bin/env bash
case "$1" in
  info) [[ "\${LIME_TEST_DOCKER_ERROR:-}" != info ]];;
  container) [[ "\${LIME_TEST_DOCKER_CONTAINER:-}" == present ]];;
  volume)
    [[ "\${LIME_TEST_DOCKER_ERROR:-}" != volume ]] || exit 1
    if [[ "$2" == inspect ]]; then [[ "\${LIME_TEST_DOCKER_VOLUME:-}" == current ]];
    elif [[ "$2" == ls ]]; then
      case "\${LIME_TEST_DOCKER_VOLUME:-}" in
        current) printf 'lime-fixture_pgdata\\n';;
        other) printf 'unrelated_pgdata\\n';;
      esac
    else exit 1; fi;;
  *) exit 1;;
esac
`, { mode: 0o700 });
  const run = (flags = {}, viaMake = false) => spawnSync(viaMake ? "make" : "bash", viaMake ? ["init-env"] : [command], {
    cwd: fixture, encoding: "utf8", env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, COMPOSE_PROJECT_NAME: "lime-fixture", DOCKER_COMPOSE: "docker-compose", COMPOSE_FILE: "", ...flags },
  });

  const fresh = run({}, true);
  assert.equal(fresh.status, 0, fresh.stderr);
  const generated = await readFile(envPath, "utf8");
  const password = generated.match(/^POSTGRES_PASSWORD=([0-9a-f]{48})$/m)?.[1];
  assert.ok(password, "fresh install should contain a unique 48-hex password");
  assert.match(generated, new RegExp(`^DATABASE_URL=postgresql://lime:${password}@localhost:5432/lime_db\\?sslmode=disable$`, "m"));
  assert.notEqual(password, "lime_dev_password");
  assert.equal((await lstat(envPath)).mode & 0o777, 0o600);

  const repeat = run();
  assert.notEqual(repeat.status, 0, "a second init must refuse to overwrite credentials");
  assert.equal(await readFile(envPath, "utf8"), generated);

  await rm(envPath);
  const external = path.join(fixture, "existing-secret");
  await writeFile(external, "keep me");
  await symlink(external, envPath);
  const linked = run();
  assert.notEqual(linked.status, 0, "a linked .env must not be overwritten");
  assert.equal(await readFile(external, "utf8"), "keep me");

  await rm(envPath);
  const hiddenProjectFlag = run({ DOCKER_COMPOSE: "docker compose -p oldproject", LIME_INIT_ENV_ALLOW_OTHER_PGDATA: "true" });
  assert.notEqual(hiddenProjectFlag.status, 0, "a project flag hidden in DOCKER_COMPOSE must not bypass the volume check");
  await assert.rejects(lstat(envPath));
  const hiddenFileFlag = run({ DOCKER_COMPOSE: "docker compose -f custom.yml", LIME_INIT_ENV_ALLOW_OTHER_PGDATA: "true" });
  assert.notEqual(hiddenFileFlag.status, 0, "a Compose file hidden in DOCKER_COMPOSE must not bypass the volume check");
  await assert.rejects(lstat(envPath));
  const customCompose = run({ COMPOSE_FILE: "docker-compose.yml:custom.yml" });
  assert.notEqual(customCompose.status, 0, "an unknown Compose file set must not bypass the volume check");
  await assert.rejects(lstat(envPath));
  const oldVolume = run({ LIME_TEST_DOCKER_VOLUME: "current" });
  assert.notEqual(oldVolume.status, 0, "existing database volume must block a fresh password");
  await assert.rejects(lstat(envPath));
  const bypassOldVolume = run({ LIME_TEST_DOCKER_VOLUME: "current", LIME_INIT_ENV_ALLOW_OTHER_PGDATA: "true" });
  assert.notEqual(bypassOldVolume.status, 0, "the current project's volume must not be bypassed");
  await assert.rejects(lstat(envPath));
  const otherVolume = run({ LIME_TEST_DOCKER_VOLUME: "other" });
  assert.notEqual(otherVolume.status, 0, "an unverified other pgdata volume must fail closed");
  await assert.rejects(lstat(envPath));
  const confirmedFresh = run({ LIME_TEST_DOCKER_VOLUME: "other", LIME_INIT_ENV_ALLOW_OTHER_PGDATA: "true" });
  assert.equal(confirmedFresh.status, 0, confirmedFresh.stderr);
  await rm(envPath);
  const oldContainer = run({ LIME_TEST_DOCKER_CONTAINER: "present" });
  assert.notEqual(oldContainer.status, 0, "existing LIME container must block a fresh password");
  await assert.rejects(lstat(envPath));
  const noDaemon = run({ LIME_TEST_DOCKER_ERROR: "info" });
  assert.notEqual(noDaemon.status, 0, "unavailable Docker state must fail closed");
  await assert.rejects(lstat(envPath));
  await writeFile(path.join(fixture, ".env.example"), "POSTGRES_USER=lime\nPOSTGRES_DB=lime_db\nPOSTGRES_PASSWORD=x\n");
  const malformed = run();
  assert.notEqual(malformed.status, 0, "a template missing DATABASE_URL must fail");
  await assert.rejects(lstat(envPath));
  console.log("source .env bootstrap checks passed");
} finally {
  await rm(fixture, { recursive: true, force: true });
}
