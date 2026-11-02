import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const json = async (path) => JSON.parse(await read(path));

function atLeast(version, minimum) {
  const parts = version.split(".").map(Number);
  assert.equal(parts.length, 3);
  assert.ok(parts.every(Number.isSafeInteger), `Expected a release version: ${version}`);
  for (let index = 0; index < 3; index++) {
    if (parts[index] !== minimum[index]) return parts[index] > minimum[index];
  }
  return true;
}

test("Go build image and current prerequisites follow the module's patched toolchain", async () => {
  const version = /^go (\d+\.\d+\.\d+)$/m.exec(await read("shopkeeper/go.mod"))?.[1];
  assert.ok(version && atLeast(version, [1, 27, 3]), "Go 1.27.3 closes the October 2026 security fixes");
  assert.ok((await read("shopkeeper/Dockerfile")).includes(`FROM golang:${version}-alpine AS builder`));
  for (const path of ["docs/setup.md", "docs/deployment/debian.md", "docs-site/content/product-docs.ts"]) {
    assert.ok((await read(path)).includes(`Go ${version}+`), `${path} must describe the current Go prerequisite`);
  }
});

test("dashboard and both release workflows select the same patched Node runtime", async () => {
  const version = /^FROM node:(\d+\.\d+\.\d+)-alpine AS base$/m.exec(await read("lime/Dockerfile"))?.[1];
  assert.ok(version && atLeast(version, [24, 22, 1]), "Select a patched Node release, not a cached floating major");
  for (const path of [".github/workflows/release-docker.yml", ".github/workflows/docs-pages.yml"]) {
    assert.ok((await read(path)).includes(`node-version: "${version}"`), `${path} must match the image runtime`);
  }
  for (const path of ["docs/setup.md", "docs/deployment/debian.md", "docs/docs-site.md", "docs-site/content/product-docs.ts", "docs/mcp.md", "docs/architecture/ui.md"]) {
    assert.ok((await read(path)).includes(`Node${path === "docs/setup.md" ? ".js" : ""} ${version}`), `${path} must describe the current Node baseline`);
  }
});

for (const app of ["lime", "docs-site"]) {
  test(`${app} locks the patched Next runtime and its matching lint packages`, async () => {
    const manifest = await json(`${app}/package.json`);
    const lock = await json(`${app}/package-lock.json`);
    const version = manifest.dependencies.next;
    assert.ok(atLeast(version, [16, 4, 1]), "Next 16.4.0 predates October 2026 security patches");
    assert.equal(manifest.devDependencies["eslint-config-next"], version);
    assert.equal(lock.packages[""].dependencies.next, version);
    assert.equal(lock.packages[""].devDependencies["eslint-config-next"], version);
    for (const name of [
      "next", "eslint-config-next", "@next/eslint-plugin-next", "@next/env",
      "@next/swc-linux-x64-musl", "@next/swc-linux-arm64-musl",
      "@next/swc-linux-x64-gnu", "@next/swc-linux-arm64-gnu",
    ]) {
      assert.equal(lock.packages[`node_modules/${name}`].version, version, `${app}: ${name}`);
    }
    assert.ok(atLeast(lock.packages["node_modules/sharp"].version, [0, 35, 5]), "Retain the fixed upstream image library");
  });
}

test("bundled PostgreSQL and the installer probe select the same patched 17.x image", async () => {
  const image = /^\s+image: (postgres:17\.(\d+)-alpine)$/m.exec(await read("docker-compose.yml"));
  assert.ok(image && Number(image[2]) >= 11, "Keep PostgreSQL on the supported, patched 17.x line");
  assert.ok((await read("docker-compose.docs.yml")).includes(`image: ${image[1]}`));
  assert.ok((await read("scripts/install.sh")).includes(` ${image[1]} || fail`));
});
