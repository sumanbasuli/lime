import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const staleVersion = "1.0.0";
const lockedVersion = "2.0.0";
const oldArtifact = "old staged artifact\n";
const builtArtifact = `// next=${lockedVersion}\n`;
const publicAsset = "fixture public asset\n";

const fakeNpm = String.raw`#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const root = process.env.LIME_NATIVE_BUILD_ROOT;
assert.equal(process.cwd(), path.join(root, "lime"));
const installed = path.join("node_modules", "next", "package.json");
const version = JSON.parse(fs.readFileSync(installed, "utf8")).version;
fs.appendFileSync(path.join(root, "calls.jsonl"), JSON.stringify({ args, version }) + "\n");
if (args.length === 1 && args[0] === "ci") {
  if (process.env.LIME_NATIVE_BUILD_FAILURE === "install") process.exit(17);
  const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
  fs.writeFileSync(installed, JSON.stringify({ version: lock.packages["node_modules/next"].version }));
} else {
  assert.deepEqual(args, ["run", "build"]);
  fs.mkdirSync(".next/standalone", { recursive: true });
  fs.mkdirSync(".next/static", { recursive: true });
  fs.writeFileSync(".next/standalone/server.js", "// next=" + version + "\n");
  fs.writeFileSync(".next/static/chunk.js", "// static next=" + version + "\n");
  if (process.env.LIME_NATIVE_BUILD_FAILURE === "build") process.exit(18);
}
`;

async function runBuild(t, failure) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lime-native-build-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([
    mkdir(join(root, "bin")),
    mkdir(join(root, "scripts")),
    mkdir(join(root, "lime/node_modules/next"), { recursive: true }),
    mkdir(join(root, "lime/public"), { recursive: true }),
    mkdir(join(root, "dist/ui"), { recursive: true }),
  ]);
  await Promise.all([
    copyFile(new URL("../Makefile", import.meta.url), join(root, "Makefile")),
    copyFile(new URL("./validate-release-version.sh", import.meta.url), join(root, "scripts/validate-release-version.sh")),
    writeFile(join(root, "VERSION"), "2.0.0\n"),
    writeFile(join(root, "bin/npm"), fakeNpm, { mode: 0o755 }),
    writeFile(join(root, "calls.jsonl"), ""),
    writeFile(join(root, "lime/package.json"), JSON.stringify({ dependencies: { next: lockedVersion } })),
    writeFile(join(root, "lime/package-lock.json"), JSON.stringify({ packages: { "node_modules/next": { version: lockedVersion } } })),
    writeFile(join(root, "lime/node_modules/next/package.json"), JSON.stringify({ version: staleVersion })),
    writeFile(join(root, "lime/public/asset.txt"), publicAsset),
    writeFile(join(root, "dist/ui/server.js"), oldArtifact),
    writeFile(join(root, "dist/ui/stale.txt"), oldArtifact),
  ]);

  // Skip unrelated prerequisites while retaining the real build success message.
  const result = spawnSync("make", [
    "--no-print-directory", "-o", "build-shopkeeper", "-o", "build-release-bundle", "build",
    "GIT_COMMIT=fixture", "DOCKER_COMPOSE=unused", "HOST_KERNEL=fixture",
  ], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${join(root, "bin")}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
      MAKEFLAGS: "", MFLAGS: "", MAKEFILES: "", MAKELEVEL: "0",
      LIME_NATIVE_BUILD_ROOT: root,
      LIME_NATIVE_BUILD_FAILURE: failure,
    },
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.ifError(result.error);
  t.diagnostic(`make build (${failure || "success"}), exit=${result.status}\n${result.stdout}${result.stderr}`);
  assert.equal(result.signal, null);
  assert.equal(result.status, failure ? 2 : 0);
  const calls = (await readFile(join(root, "calls.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
  assert.deepEqual(calls, failure === "install" ? [
    { args: ["ci"], version: staleVersion },
  ] : [
    { args: ["ci"], version: staleVersion },
    { args: ["run", "build"], version: lockedVersion },
  ]);
  assert.equal(result.stdout.includes("Production artifacts ready in dist/"), failure === "");
  return root;
}

test("native build installs the selected lock before building and staging UI artifacts", async (t) => {
  const root = await runBuild(t, "");
  assert.equal(await readFile(join(root, "dist/ui/server.js"), "utf8"), builtArtifact);
  assert.equal(await readFile(join(root, "dist/ui/.next/static/chunk.js"), "utf8"), `// static next=${lockedVersion}\n`);
  assert.equal(await readFile(join(root, "dist/ui/public/asset.txt"), "utf8"), publicAsset);
  await assert.rejects(readFile(join(root, "dist/ui/stale.txt")), { code: "ENOENT" });
});

test("failed dependency installation leaves previous staging artifacts intact and skips the build", async (t) => {
  const root = await runBuild(t, "install");
  assert.equal(await readFile(join(root, "dist/ui/server.js"), "utf8"), oldArtifact);
  assert.equal(await readFile(join(root, "dist/ui/stale.txt"), "utf8"), oldArtifact);
  await assert.rejects(readFile(join(root, "lime/.next/standalone/server.js")), { code: "ENOENT" });
});

test("failed UI build does not publish partial output or announce production artifacts", async (t) => {
  const root = await runBuild(t, "build");
  assert.equal(await readFile(join(root, "lime/.next/standalone/server.js"), "utf8"), builtArtifact);
  await assert.rejects(readFile(join(root, "dist/ui/server.js")), { code: "ENOENT" });
  await assert.rejects(readFile(join(root, "dist/ui/.next/static/chunk.js")), { code: "ENOENT" });
  await assert.rejects(readFile(join(root, "dist/ui/public/asset.txt")), { code: "ENOENT" });
});
