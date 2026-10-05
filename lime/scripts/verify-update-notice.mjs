import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";

const require = createRequire(new URL("../package.json", import.meta.url));
const ts = require("typescript");
// Encode the literal percent in Next's escaped directory name for a file URL.
const source = await readFile(new URL("../src/app/%255Flime/update-check/route.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const release = { tag_name: "v1.0.6", html_url: "https://github.com/sumanbasuli/lime/releases/tag/v1.0.6" };

// Run the actual route with a controlled GitHub boundary. No network, keys,
// browser preferences or application settings are changed by these tests.
function route(env = {}, upstream = async () => Response.json(release)) {
  const exports = {};
  let calls = 0;
  vm.runInNewContext(compiled, {
    exports, Date, AbortSignal,
    process: { env: { LIME_VERSION: "1.0.5", ...env } },
    require: (name) => {
      if (name === "../../../../package.json") return { version: "1.0.5" };
      assert.equal(name, "next/server");
      return { NextResponse: { json: (body) => Response.json(body) } };
    },
    fetch: async (url, init) => {
      calls++;
      assert.equal(url, "https://api.github.com/repos/sumanbasuli/lime/releases/latest");
      assert.ok(init.signal instanceof AbortSignal);
      assert.equal(init.next.revalidate, 1800);
      return upstream(url, init);
    },
  });
  return { GET: exports.GET, calls: () => calls };
}

test("unset update flag enables a newer release announcement by default", async () => {
  const handler = route();
  const response = await handler.GET();
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.enabled, true);
  assert.equal(data.outdated, true);
  assert.equal(data.current, "1.0.5");
  assert.equal(data.latest, release.tag_name);
  assert.equal(data.url, release.html_url);
  assert.equal(handler.calls(), 1);
});

test("explicit false opts out without making an outbound request", async () => {
  for (const flag of ["false", "FALSE", ""]) {
    const handler = route({ LIME_UPDATE_CHECK: flag }, () => assert.fail("Disabled checks must not call GitHub"));
    assert.deepEqual(await (await handler.GET()).json(), { enabled: false });
    assert.equal(handler.calls(), 0);
  }
});

test("explicit true remains supported", async () => {
  for (const flag of ["true", "TRUE"]) {
    const handler = route({ LIME_UPDATE_CHECK: flag });
    assert.equal((await (await handler.GET()).json()).outdated, true);
  }
});

test("GitHub network/status/JSON failures safely suppress the card", async () => {
  for (const upstream of [
    async () => { throw new Error("GitHub unavailable"); },
    async () => new Response(null, { status: 503 }),
    async () => new Response("invalid JSON"),
  ]) {
    const data = await (await route({}, upstream).GET()).json();
    assert.equal(data.enabled, true);
    assert.equal(data.outdated, false);
    assert.equal(data.latest, null);
  }
});

test("drafts and prereleases do not announce updates", async () => {
  for (const field of ["draft", "prerelease"]) {
    const data = await (await route({}, async () => Response.json({ ...release, [field]: true })).GET()).json();
    assert.equal(data.enabled, true);
    assert.equal(data.outdated, false);
    assert.equal(data.latest, null);
  }
});

test("an up-to-date installation does not announce an update", async () => {
  const data = await (await route({ LIME_VERSION: "1.0.6" }).GET()).json();
  assert.equal(data.enabled, true);
  assert.equal(data.outdated, false);
});

test("unset or blank runtime version uses the packaged version, not 0.0.0", async () => {
  for (const version of [undefined, "", " "]) {
    const data = await (await route({ LIME_VERSION: version }, async () => Response.json({ ...release, tag_name: "v1.0.5" })).GET()).json();
    assert.equal(data.current, "1.0.5");
    assert.equal(data.outdated, false);
  }
});

test("an explicit runtime release version remains authoritative", async () => {
  const data = await (await route({ LIME_VERSION: "v1.0.4" }).GET()).json();
  assert.equal(data.current, "1.0.4");
  assert.equal(data.outdated, true);
});
