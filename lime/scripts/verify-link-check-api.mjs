import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(new URL("../package.json", import.meta.url));
const ts = require("typescript");
const source = await readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

// Exercise the actual API client without touching a database, network, or scan.
function client(upstream = async () => Response.json({ id: "saved-job" })) {
  const exports = {};
  const calls = [];
  vm.runInNewContext(compiled, {
    exports, AbortSignal, URLSearchParams,
    fetch: async (url, init = {}) => {
      calls.push({ url, init });
      init.signal?.throwIfAborted();
      return upstream(url, init);
    },
  });
  return { api: exports, calls };
}

test("normal accessibility scans default to no link check, with explicit opt-in", async () => {
  const { api, calls } = client();
  const scan = { url: "https://example.com/sitemap.xml", scanType: "sitemap", viewportPreset: "desktop" };
  await api.createScan(scan);
  await api.createScan({ ...scan, includeLinkCheck: true });
  assert.equal(JSON.parse(calls[0].init.body).include_link_check, false);
  assert.equal(JSON.parse(calls[1].init.body).include_link_check, true);
  assert.equal(JSON.parse(calls[1].init.body).scan_type, "sitemap");
  assert.equal(JSON.parse(calls[1].init.body).viewport_preset, "desktop");
});

test("standalone creation sends the agreed backend shape", async () => {
  const { api, calls } = client();
  await api.createLinkCheck({ url: "https://example.com/", checkType: "crawl", maxPages: 100 });
  assert.equal(calls[0].url, "/api/link-checks");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { url: "https://example.com/", check_type: "crawl", max_pages: 100 });
  assert.equal(calls[0].init.cache, "no-store");
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test("history, global stats, filtered targets, source pages, and companion paths", async () => {
  const { api, calls } = client();
  await api.getLinkChecks(10, 20);
  await api.getLinkCheckStats();
  await api.getLinkCheck("job/id");
  await api.getLinkCheckResults("job/id", { status: "broken", limit: 20, offset: 40 });
  await api.getLinkCheckSources("job/id", "target/id", 20, 60);
  await api.getScanLinkCheck("scan/id");
  assert.deepEqual(calls.map((call) => call.url), [
    "/api/link-checks?limit=10&offset=20", "/api/link-checks/stats", "/api/link-checks/job%2Fid",
    "/api/link-checks/job%2Fid/results?limit=20&offset=40&status=broken",
    "/api/link-checks/job%2Fid/results/target%2Fid/sources?limit=20&offset=60", "/api/scans/scan%2Fid/link-check",
  ]);
  assert.ok(calls.every((call) => call.init.cache === "no-store" && call.init.signal instanceof AbortSignal));
});

test("lifecycle actions preserve endpoint semantics and accept empty deletion responses", async () => {
  const { api, calls } = client(async (_, init) => init.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({ id: "saved-job" }));
  await api.cancelLinkCheck("job");
  await api.recheckLinks("job");
  await api.deleteLinkCheck("job");
  assert.deepEqual(calls.map((call) => [call.url, call.init.method]), [
    ["/api/link-checks/job/cancel", "POST"], ["/api/link-checks/job/recheck", "POST"], ["/api/link-checks/job", "DELETE"],
  ]);
  assert.equal(api.isActiveLinkCheck("queued"), true);
  assert.equal(api.isActiveLinkCheck("running"), true);
  for (const status of ["completed", "failed", "cancelled"]) assert.equal(api.isActiveLinkCheck(status), false);
});

test("reader-facing backend errors and malformed error responses are actionable", async () => {
  const denied = client(async () => Response.json({ error: "Cancel the active check first" }, { status: 409 }));
  await assert.rejects(denied.api.deleteLinkCheck("job"), /Cancel the active check first/);
  const offline = client(async () => new Response("not JSON", { status: 502 }));
  await assert.rejects(offline.api.getLinkCheck("job"), /Link checker request failed \(502\)/);
});

test("a cancelled poll is propagated without issuing a successful request", async () => {
  const { api, calls } = client();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(api.getLinkCheck("job", controller.signal), /abort/i);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.signal.aborted, true);
});
