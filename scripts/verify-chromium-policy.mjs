import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Chromium policy retains the pinned Docker baseline and only its five reviewed additions", () => {
  const policy = JSON.parse(readFileSync(path.join(root, "deploy/docker/chromium-seccomp.json"), "utf8"));
  assert.equal(policy.syscalls.length, 65);
  const additions = policy.syscalls.splice(-5);
  assert.equal(createHash("sha256").update(JSON.stringify(policy)).digest("hex"), "3e30a4b18c1cab37399d130ba2abfbaa15827f1db45c451253314c635f57907d", "upstream Moby profile changed; review architecture/capability conditions before refreshing this pin");
  const rule = (name, mask, flags) => ({
    names: [name], action: "SCMP_ACT_ALLOW",
    ...(mask === undefined ? {} : { args: [{ index: 0, value: mask, valueTwo: flags, op: "SCMP_CMP_MASKED_EQ" }] }),
    includes: { arches: ["amd64", "arm64"] },
  });
  assert.deepEqual(additions, [
    rule("unshare", 0xffffffff, 0x10000000),
    rule("clone", 0x7e020000, 0x10000000),
    rule("clone", 0x7e020000, 0x70000000),
    rule("clone", 0x7e020000, 0x20000000),
    rule("chroot"),
  ]);
});

test("each Compose deployment retains only initializer capabilities and a non-root health check", (t) => {
  const available = spawnSync("docker", ["compose", "version"], { encoding: "utf8", timeout: 10_000 });
  if (available.error?.code === "ENOENT") {
    t.skip("Docker CLI is required for daemon-free Compose interpolation checks");
    return;
  }
  assert.ifError(available.error);
  assert.equal(available.status, 0, available.stderr);
  const env = {
    ...process.env, POSTGRES_USER: "lime", POSTGRES_PASSWORD: "fixture-only", POSTGRES_DB: "lime",
    DATABASE_URL: "postgresql://fixture:fixture@db.invalid/lime", SHOPKEEPER_URL: "http://shopkeeper:8080",
    LIME_IMAGE_TAG: "vFixture", LIME_DOCS_DB_PASSWORD: "fixture-only", LIME_VERSION: "fixture",
  };
  for (const filename of ["docker-compose.yml", "docker-compose.release.yml", "docker-compose.docs.yml"]) {
    const result = spawnSync("docker", ["compose", "--env-file", "/dev/null", "-f", path.join(root, filename), "config", "--format", "json"], { cwd: root, env, encoding: "utf8", timeout: 30_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const service = JSON.parse(result.stdout).services.shopkeeper;
    assert.deepEqual(service.cap_drop, ["ALL"], filename);
    assert.deepEqual([...service.cap_add].sort(), ["CHOWN", "DAC_OVERRIDE", "SETUID", "SETGID", "SETPCAP"].sort(), filename);
    assert.ok(service.security_opt.some((entry) => entry === "no-new-privileges:true" || entry === "no-new-privileges"), filename);
    assert.ok(service.security_opt.some((entry) => entry.includes("deploy/docker/chromium-seccomp.json")), filename);
    assert.equal(service.healthcheck.test[1], "setpriv", filename);
    for (const argument of ["--reuid=10001", "--regid=10001", "--bounding-set=-all", "--no-new-privs"]) {
      assert.ok(service.healthcheck.test.includes(argument), `${filename} health check missing ${argument}`);
    }
  }
});
