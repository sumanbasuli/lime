import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function fixture(t) {
  const temporary = await mkdtemp(path.join(tmpdir(), "lime-bundle-safety-"));
  const root = path.join(temporary, "checkout");
  t.after(() => rm(temporary, { recursive: true, force: true }));
  for (const directory of ["scripts", "deploy/release", "deploy/docker", "data", "dist/release", "lime"]) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  await copyFile(path.join(repository, "scripts/build-release-bundle.sh"), path.join(root, "scripts/build-release-bundle.sh"));
  await copyFile(path.join(repository, "scripts/validate-release-version.sh"), path.join(root, "scripts/validate-release-version.sh"));
  await copyFile(path.join(repository, "Makefile"), path.join(root, "Makefile"));
  for (const file of ["chromium-seccomp.json", "LICENSE.moby", "README.md"]) {
    await copyFile(path.join(repository, "deploy/docker", file), path.join(root, "deploy/docker", file));
  }
  await writeFile(path.join(root, "VERSION"), "2.0.0\n");
  await writeFile(path.join(root, "docker-compose.release.yml"), "services: {}\n");
  await writeFile(path.join(root, "deploy/release/README.md"), "Fixture release bundle\n");
  await writeFile(path.join(root, "deploy/release/.env.example"), "LIME_IMAGE_REGISTRY=old.example\nLIME_IMAGE_TAG=v0.0.0\n");
  await writeFile(path.join(root, "data/act-rules.json"), "{}\n");
  return root;
}

function build(root, version) {
  const result = spawnSync("bash", [path.join(root, "scripts/build-release-bundle.sh"), version], {
    cwd: root, env: { ...process.env, LIME_IMAGE_REGISTRY: "example.invalid/lime" }, encoding: "utf8", timeout: 15_000,
  });
  assert.ifError(result.error);
  return result;
}

async function publishNotesFixture(t) {
  const root = await fixture(t);
  const bin = path.join(root, "bin");
  await mkdir(bin);
  await copyFile(path.join(repository, "scripts/publish-github-release.sh"), path.join(root, "scripts/publish-github-release.sh"));
  await copyFile(path.join(repository, "scripts/extract-release-notes.sh"), path.join(root, "scripts/extract-release-notes.sh"));
  await writeFile(path.join(root, "CHANGELOG.md"), "## 2.0.0\n\nFixture release notes.\n");
  await writeFile(path.join(root, "dist/lime-v2.0.0-release.tar.gz"), "fixture bundle\n");
  await writeFile(path.join(bin, "git"), "#!/usr/bin/env sh\nexit 99\n", { mode: 0o755 });
  return { root, bin };
}

function publishNotes(root, bin, environment = {}) {
  const result = spawnSync("bash", [path.join(root, "scripts/publish-github-release.sh"), "v2.0.0"], {
    cwd: root,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...environment },
    encoding: "utf8", timeout: 15_000,
  });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0, "the fake git command must stop before any remote operation");
  return result;
}

test("a traversal version cannot erase an existing checkout path", async (t) => {
  const root = await fixture(t);
  const intermediate = path.join(root, "dist/release/lime-vx");
  const victim = path.join(root, "dist/victim");
  assert.equal(path.resolve(intermediate, "../../victim"), victim, "the destructive target stays inside this disposable fixture");
  await mkdir(intermediate);
  await mkdir(victim);
  await writeFile(path.join(victim, "sentinel"), "keep this\n");
  const result = build(root, "x/../../victim");
  assert.notEqual(result.status, 0, "a slash-bearing version must be rejected before deletion");
  assert.equal(await readFile(path.join(victim, "sentinel"), "utf8"), "keep this\n");
});

test("malformed versions are rejected before any release output changes", async (t) => {
  const root = await fixture(t);
  const marker = path.join(root, "dist/release/marker");
  await writeFile(marker, "keep this\n");
  for (const version of ["2.0.0/../elsewhere", "2.0.0\\elsewhere", "2.0.0\nother", "2.0.0;touch nope", "v2.0.0"]) {
    assert.notEqual(build(root, version).status, 0, `reject ${JSON.stringify(version)}`);
    assert.equal(await readFile(marker, "utf8"), "keep this\n");
  }
});

test("make treats VERSION overrides as data before shell or Make function expansion", async (t) => {
  const root = await fixture(t);
  const marker = path.join(root, "unexpected-command");
  for (const override of [`VERSION=2.0.0; touch ${marker}`, `VERSION=$(shell touch ${marker})`]) {
    const result = spawnSync("make", ["--no-print-directory", "build-release-bundle", "DOCKER_COMPOSE=unused", override], {
      cwd: root, env: { ...process.env, MAKEFLAGS: "", MFLAGS: "", MAKEFILES: "", MAKELEVEL: "0" }, encoding: "utf8", timeout: 15_000,
    });
    assert.ifError(result.error);
    assert.notEqual(result.status, 0, "unsafe VERSION overrides must fail validation");
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  }
  await writeFile(path.join(root, ".env"), "UNRELATED=fixture\n");
  const withEnv = spawnSync("make", ["--no-print-directory", "build-release-bundle", "DOCKER_COMPOSE=unused", `VERSION=$(shell touch ${marker})`], {
    cwd: root, env: { ...process.env, MAKEFLAGS: "", MFLAGS: "", MAKEFILES: "", MAKELEVEL: "0" }, encoding: "utf8", timeout: 15_000,
  });
  assert.ifError(withEnv.error);
  assert.notEqual(withEnv.status, 0);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  const valid = spawnSync("make", ["--no-print-directory", "build-release-bundle", "DOCKER_COMPOSE=unused", "VERSION=2.1.0-rc.1"], {
    cwd: root, env: { ...process.env, MAKEFLAGS: "", MFLAGS: "", MAKEFILES: "", MAKELEVEL: "0" }, encoding: "utf8", timeout: 15_000,
  });
  assert.ifError(valid.error);
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(await readFile(path.join(root, "dist/release/lime-v2.1.0-rc.1/.env.example"), "utf8"), /^LIME_IMAGE_TAG=v2\.1\.0-rc\.1$/m);
});

test("make still builds an ordinary bundle from the VERSION file", async (t) => {
  const root = await fixture(t);
  const result = spawnSync("make", ["--no-print-directory", "build-release-bundle", "DOCKER_COMPOSE=unused"], {
    cwd: root, env: { ...process.env, MAKEFLAGS: "", MFLAGS: "", MAKEFILES: "", MAKELEVEL: "0" }, encoding: "utf8", timeout: 15_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(await readFile(path.join(root, "dist/release/lime-v2.0.0/.env.example"), "utf8"), /^LIME_IMAGE_TAG=v2\.0\.0$/m);
});

test("make rejects extra lines in VERSION before replacing an existing bundle", async (t) => {
  const root = await fixture(t);
  const bundle = path.join(root, "dist/release/lime-v2.0.0");
  await mkdir(bundle);
  await writeFile(path.join(bundle, "sentinel"), "keep this\n");
  await writeFile(path.join(root, "VERSION"), "2.0.0\n\n");
  const result = spawnSync("make", ["--no-print-directory", "build-release-bundle", "DOCKER_COMPOSE=unused"], {
    cwd: root, env: { ...process.env, MAKEFLAGS: "", MFLAGS: "", MAKEFILES: "", MAKELEVEL: "0" }, encoding: "utf8", timeout: 15_000,
  });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(path.join(bundle, "sentinel"), "utf8"), "keep this\n");
});

test("a symlinked release directory cannot redirect bundle deletion", async (t) => {
  const root = await fixture(t);
  const outside = path.join(root, "outside-release");
  const victim = path.join(outside, "lime-v2.0.0");
  await mkdir(victim, { recursive: true });
  await writeFile(path.join(victim, "sentinel"), "keep this\n");
  await rm(path.join(root, "dist/release"), { recursive: true });
  await symlink(outside, path.join(root, "dist/release"), "dir");
  assert.notEqual(build(root, "2.0.0").status, 0);
  assert.equal(await readFile(path.join(victim, "sentinel"), "utf8"), "keep this\n");
});

test("a symlinked dist directory or archive cannot redirect bundle output", async (t) => {
  const root = await fixture(t);
  const outside = path.join(root, "outside-dist");
  const victim = path.join(outside, "release/lime-v2.0.0");
  await mkdir(victim, { recursive: true });
  await writeFile(path.join(victim, "sentinel"), "keep this\n");
  await rm(path.join(root, "dist"), { recursive: true });
  await symlink(outside, path.join(root, "dist"), "dir");
  assert.notEqual(build(root, "2.0.0").status, 0);
  assert.equal(await readFile(path.join(victim, "sentinel"), "utf8"), "keep this\n");

  const archiveRoot = await fixture(t);
  const bundle = path.join(archiveRoot, "dist/release/lime-v2.0.0");
  const archiveVictim = path.join(archiveRoot, "outside-archive");
  await mkdir(bundle);
  await writeFile(path.join(bundle, "sentinel"), "keep bundle\n");
  await writeFile(archiveVictim, "keep archive\n");
  await symlink(archiveVictim, path.join(archiveRoot, "dist/lime-v2.0.0-release.tar.gz"));
  assert.notEqual(build(archiveRoot, "2.0.0").status, 0);
  assert.equal(await readFile(archiveVictim, "utf8"), "keep archive\n");
  assert.equal(await readFile(path.join(bundle, "sentinel"), "utf8"), "keep bundle\n");
});

test("a hard-linked archive cannot overwrite another file", async (t) => {
  const root = await fixture(t);
  const outside = path.join(root, "outside-archive");
  const archive = path.join(root, "dist/lime-v2.0.0-release.tar.gz");
  await writeFile(outside, "keep archive\n");
  await link(outside, archive);
  const result = build(root, "2.0.0");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(outside, "utf8"), "keep archive\n");
  const contents = spawnSync("tar", ["-tzf", archive], { encoding: "utf8", timeout: 15_000 });
  assert.equal(contents.status, 0, contents.stderr);
});

test("release archives retain ordinary new and existing file permissions", async (t) => {
  const root = await fixture(t);
  const archive = path.join(root, "dist/lime-v2.0.0-release.tar.gz");
  assert.equal(build(root, "2.0.0").status, 0);
  assert.equal((await stat(archive)).mode & 0o777, 0o666 & ~process.umask());
  await rm(archive);
  await writeFile(archive, "prior archive\n", { mode: 0o640 });
  const priorArchive = await stat(archive);
  assert.equal(build(root, "2.0.0").status, 0);
  assert.equal((await stat(archive)).mode & 0o777, 0o640);
  assert.equal((await stat(archive)).ino, priorArchive.ino, "ordinary existing archives retain their inode metadata");
});

test("publisher notes cannot follow a symlink to another file", async (t) => {
  const { root, bin } = await publishNotesFixture(t);
  const outside = path.join(root, "outside-notes");
  await writeFile(outside, "keep notes target\n");
  await symlink(outside, path.join(root, "dist/release-notes.md"));
  publishNotes(root, bin);
  assert.equal(await readFile(outside, "utf8"), "keep notes target\n");
});

test("publisher notes cannot modify a hard-linked file", async (t) => {
  const { root, bin } = await publishNotesFixture(t);
  const outside = path.join(root, "outside-notes");
  await writeFile(outside, "keep notes target\n");
  await link(outside, path.join(root, "dist/release-notes.md"));
  publishNotes(root, bin);
  assert.equal(await readFile(outside, "utf8"), "keep notes target\n");
  assert.equal(await readFile(path.join(root, "dist/release-notes.md"), "utf8"), "Fixture release notes.\n");
});

test("publisher notes cannot follow a symlinked dist directory", async (t) => {
  const { root, bin } = await publishNotesFixture(t);
  const outside = path.join(root, "outside-dist");
  await mkdir(outside);
  await writeFile(path.join(outside, "lime-v2.0.0-release.tar.gz"), "fixture bundle\n");
  await rm(path.join(root, "dist"), { recursive: true });
  await symlink(outside, path.join(root, "dist"), "dir");
  publishNotes(root, bin);
  await assert.rejects(readFile(path.join(outside, "release-notes.md")), { code: "ENOENT" });
});

test("publisher refuses a symlinked bundle before writing release notes", async (t) => {
  const { root, bin } = await publishNotesFixture(t);
  const bundle = path.join(root, "dist/lime-v2.0.0-release.tar.gz");
  const outside = path.join(root, "outside-bundle");
  await writeFile(outside, "do not upload\n");
  await rm(bundle);
  await symlink(outside, bundle);
  publishNotes(root, bin);
  await assert.rejects(readFile(path.join(root, "dist/release-notes.md")), { code: "ENOENT" });
});

test("publisher still writes ordinary notes to an explicit path", async (t) => {
  const { root, bin } = await publishNotesFixture(t);
  const notes = path.join(root, "release-notes", "custom.md");
  publishNotes(root, bin, { RELEASE_NOTES_PATH: notes });
  assert.equal(await readFile(notes, "utf8"), "Fixture release notes.\n");
  assert.equal((await stat(notes)).mode & 0o777, 0o666 & ~process.umask());
  await writeFile(notes, "old notes\n", { mode: 0o640 });
  await chmod(notes, 0o640);
  const priorNotes = await stat(notes);
  publishNotes(root, bin, { RELEASE_NOTES_PATH: notes });
  assert.equal((await stat(notes)).mode & 0o777, 0o640);
  assert.equal((await stat(notes)).ino, priorNotes.ino, "ordinary existing notes retain their inode metadata");
});

test("a symlinked dist cannot redirect native backend or UI staging", async (t) => {
  const root = await fixture(t);
  const outside = path.join(root, "outside-dist");
  const bin = path.join(root, "bin");
  await mkdir(path.join(outside, "shopkeeper"), { recursive: true });
  await mkdir(path.join(outside, "ui"), { recursive: true });
  await mkdir(bin);
  await writeFile(path.join(outside, "shopkeeper/sentinel"), "keep backend\n");
  await writeFile(path.join(outside, "ui/sentinel"), "keep UI\n");
  await writeFile(path.join(bin, "go"), "#!/usr/bin/env sh\nexit 0\n", { mode: 0o755 });
  await writeFile(path.join(bin, "npm"), "#!/usr/bin/env sh\nexit 0\n", { mode: 0o755 });
  await rm(path.join(root, "dist"), { recursive: true });
  await symlink(outside, path.join(root, "dist"), "dir");
  for (const [target, subdirectory, expected] of [
    ["build-shopkeeper", "shopkeeper", "keep backend\n"],
    ["build-ui", "ui", "keep UI\n"],
  ]) {
    const result = spawnSync("make", ["--no-print-directory", target, "DOCKER_COMPOSE=unused"], {
      cwd: root,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MAKEFLAGS: "", MFLAGS: "", MAKEFILES: "", MAKELEVEL: "0" },
      encoding: "utf8", timeout: 15_000,
    });
    assert.ifError(result.error);
    assert.notEqual(result.status, 0, `${target} must reject the symlink before staging`);
    assert.equal(await readFile(path.join(outside, subdirectory, "sentinel"), "utf8"), expected);
  }
});

test("make rejects an unsafe VERSION file before compiling the backend", async (t) => {
  const root = await fixture(t);
  const marker = path.join(root, "unexpected-command");
  const bin = path.join(root, "bin");
  await mkdir(bin);
  await mkdir(path.join(root, "shopkeeper/migrations"), { recursive: true });
  await writeFile(path.join(bin, "go"), "#!/usr/bin/env sh\nexit 0\n", { mode: 0o755 });
  await writeFile(path.join(root, "VERSION"), `2.0.0"; touch ${marker}; #\n`);
  const result = spawnSync("make", ["--no-print-directory", "build-shopkeeper", "DOCKER_COMPOSE=unused"], {
    cwd: root,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MAKEFLAGS: "", MFLAGS: "", MAKEFILES: "", MAKELEVEL: "0" },
    encoding: "utf8", timeout: 15_000,
  });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0, "the unsafe version must fail before the backend build recipe");
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});

test("make rejects an unsafe VERSION file before replacing staged UI files", async (t) => {
  const root = await fixture(t);
  const oldUi = path.join(root, "dist/ui");
  const bin = path.join(root, "bin");
  await mkdir(oldUi);
  await mkdir(bin);
  await writeFile(path.join(oldUi, "sentinel"), "keep this\n");
  await writeFile(path.join(bin, "npm"), "#!/usr/bin/env sh\nexit 0\n", { mode: 0o755 });
  await writeFile(path.join(root, "VERSION"), "2.0.0; invalid\n");
  const result = spawnSync("make", ["--no-print-directory", "build-ui", "DOCKER_COMPOSE=unused"], {
    cwd: root,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MAKEFLAGS: "", MFLAGS: "", MAKEFILES: "", MAKELEVEL: "0" },
    encoding: "utf8", timeout: 15_000,
  });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(path.join(oldUi, "sentinel"), "utf8"), "keep this\n");
});

test("make publish wrapper uses the VERSION file, not an interpolated tag override", async (t) => {
  const root = await fixture(t);
  const marker = path.join(root, "unexpected-command");
  await writeFile(path.join(root, "scripts/publish-release-images.sh"), "#!/usr/bin/env bash\nprintf '%s\\n' \"$1\" > published-tag\n", { mode: 0o755 });
  for (const override of [`LIME_IMAGE_TAG=v2.0.0; touch ${marker}`, `LIME_IMAGE_TAG=$(shell touch ${marker})`]) {
    const result = spawnSync("make", ["--no-print-directory", "publish-release-images", "DOCKER_COMPOSE=unused", override], {
      cwd: root, env: { ...process.env, MAKEFLAGS: "", MFLAGS: "", MAKEFILES: "", MAKELEVEL: "0" }, encoding: "utf8", timeout: 15_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(path.join(root, "published-tag"), "utf8"), "v2.0.0\n");
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  }
});

test("make passes custom Docker image tags as data", async (t) => {
  const root = await fixture(t);
  const marker = path.join(root, "unexpected-command");
  const bin = path.join(root, "bin");
  await mkdir(bin);
  await writeFile(path.join(root, ".env"), "UNRELATED=fixture\n");
  await writeFile(path.join(bin, "docker"), "#!/usr/bin/env bash\nprintf '%s\\n' \"$@\" > docker-args\n", { mode: 0o755 });
  for (const tag of [`v2.0.0; touch ${marker}`, `$(shell touch ${marker})`]) {
    const result = spawnSync("make", ["--no-print-directory", "build-docker-shopkeeper", "DOCKER_COMPOSE=unused", `LIME_IMAGE_TAG=${tag}`], {
      cwd: root,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MAKEFLAGS: "", MFLAGS: "", MAKEFILES: "", MAKELEVEL: "0" },
      encoding: "utf8", timeout: 15_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.ok((await readFile(path.join(root, "docker-args"), "utf8")).split("\n").includes(`lime-shopkeeper:${tag}`));
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  }
});

test("ordinary and prerelease bundles retain their contents and repeat-build replacement", async (t) => {
  const root = await fixture(t);
  for (const version of ["2.0.0", "2.1.0-rc.1"]) {
    const result = build(root, version);
    assert.equal(result.status, 0, result.stderr);
    const name = `lime-v${version}`;
    const bundle = path.join(root, "dist/release", name);
    const archive = path.join(root, "dist", `${name}-release.tar.gz`);
    const env = await readFile(path.join(bundle, ".env.example"), "utf8");
    assert.match(env, /^LIME_IMAGE_REGISTRY=example\.invalid\/lime$/m);
    assert.match(env, new RegExp(`^LIME_IMAGE_TAG=v${version.replaceAll(".", "\\.")}$`, "m"));
    const contents = spawnSync("tar", ["-tzf", archive], { encoding: "utf8", timeout: 15_000 });
    assert.equal(contents.status, 0, contents.stderr);
    assert.match(contents.stdout, new RegExp(`${name}/docker-compose\\.release\\.yml`));
    assert.match(contents.stdout, new RegExp(`${name}/data/act-rules\\.json`));
    for (const file of ["chromium-seccomp.json", "LICENSE.moby", "README.md"]) {
      assert.ok(contents.stdout.includes(`${name}/deploy/docker/${file}`), `missing ${file} in release archive`);
      assert.equal(await readFile(path.join(bundle, "deploy/docker", file), "utf8"), await readFile(path.join(repository, "deploy/docker", file), "utf8"));
    }
    await writeFile(path.join(bundle, "stale"), "remove on rebuild\n");
    assert.equal(build(root, version).status, 0);
    await assert.rejects(readFile(path.join(bundle, "stale")), { code: "ENOENT" });
  }
});

test("restricted build umask keeps shipped catalogs readable by service UIDs", async (t) => {
  const root = await fixture(t);
  await chmod(path.join(root, "data"), 0o700);
  await chmod(path.join(root, "data/act-rules.json"), 0o600);
  const result = spawnSync("bash", ["-c", 'umask 077; exec bash "$1" "$2"', "fixture", path.join(root, "scripts/build-release-bundle.sh"), "2.0.0"], {
    cwd: root, env: { ...process.env }, encoding: "utf8", timeout: 15_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const bundle = path.join(root, "dist/release/lime-v2.0.0");
  assert.equal((await stat(path.join(bundle, "data"))).mode & 0o777, 0o755);
  assert.equal((await stat(path.join(bundle, "data/act-rules.json"))).mode & 0o777, 0o644);
  assert.equal((await stat(path.join(bundle, "deploy/docker/chromium-seccomp.json"))).mode & 0o777, 0o644);
  assert.equal((await stat(path.join(root, "data/act-rules.json"))).mode & 0o777, 0o600, "do not change host source permissions");
});
