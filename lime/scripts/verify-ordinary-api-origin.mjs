import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(new URL("../package.json", import.meta.url));
const ts = require("typescript");

// Exercise actual route/helper source with controlled service boundaries.
// No LIME database, settings, jobs, or running servers are touched.
async function loadSource(path, dependencies = {}, globals = {}) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports, URL, Headers, Response, Request, AbortSignal, Buffer, JSON,
    process: { env: { SHOPKEEPER_URL: "http://shopkeeper.invalid:8080" } },
    require: (name) => {
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    ...globals,
  });
  return exports;
}

const originHelper = await loadSource("../src/lib/ordinary-api-origin.ts");

function apiRequest(path, method, { origin, fetchSite, body, contentType, host, forwardedProto } = {}) {
  const url = `http://127.0.0.1:3000${path}`;
  const headers = new Headers();
  if (origin !== undefined) headers.set("Origin", origin);
  if (fetchSite) headers.set("Sec-Fetch-Site", fetchSite);
  if (contentType) headers.set("Content-Type", contentType);
  if (host) headers.set("Host", host);
  if (forwardedProto) headers.set("X-Forwarded-Proto", forwardedProto);
  const request = new Request(url, { method, headers, body });
  request.nextUrl = new URL(url);
  return request;
}

test("settings rejects text/plain cross-site forms before key rotation or save", async () => {
  let generated = 0;
  let saved = 0;
  const route = await loadSource("../src/app/api/settings/route.ts", {
    "@/lib/ordinary-api-origin": originHelper,
    "@/lib/report-settings": {
      generateMcpKey: async () => { generated++; return { mcpKey: "fixture", settings: {} }; },
      saveSystemSettings: async () => { saved++; return {}; },
      getSystemSettings: async () => ({}),
    },
  });
  const form = '{"action":"generate_mcp_key","pad":"="}\r\n';
  for (const origin of ["null", "https://foreign.test"]) {
    const response = await route.POST(apiRequest("/api/settings", "POST", { origin, body: form, contentType: "text/plain" }));
    assert.equal(response.status, 403);
  }
  assert.equal(generated, 0);
  assert.equal((await route.PUT(apiRequest("/api/settings", "PUT", {
    origin: "https://foreign.test", body: '{"reporting":{"pdfReportsEnabled":true}}', contentType: "application/json",
  }))).status, 403);
  assert.equal(saved, 0);
  assert.equal((await route.POST(apiRequest("/api/settings", "POST", {
    fetchSite: "cross-site", body: form, contentType: "text/plain",
  }))).status, 403);
  assert.equal((await route.POST(apiRequest("/api/settings", "POST", {
    fetchSite: "same-site", body: form, contentType: "text/plain",
  }))).status, 403);
  assert.equal(generated, 0);
});

test("settings keeps public HTTPS dashboard and Origin-free CLI writes", async () => {
  let generated = 0;
  let saved = 0;
  const route = await loadSource("../src/app/api/settings/route.ts", {
    "@/lib/ordinary-api-origin": originHelper,
    "@/lib/report-settings": {
      generateMcpKey: async () => { generated++; return { mcpKey: "fixture", settings: {} }; },
      saveSystemSettings: async () => { saved++; return {}; },
      getSystemSettings: async () => ({}),
    },
  });
  const publicHeaders = { origin: "https://lime.example.test", host: "lime.example.test", forwardedProto: "https" };
  assert.equal((await route.POST(apiRequest("/api/settings", "POST", {
    ...publicHeaders, body: '{"action":"generate_mcp_key"}', contentType: "application/json",
  }))).status, 200);
  assert.equal((await route.PUT(apiRequest("/api/settings", "PUT", {
    ...publicHeaders, body: '{"reporting":{"pdfReportsEnabled":true}}', contentType: "application/json",
  }))).status, 200);
  assert.equal((await route.POST(apiRequest("/api/settings", "POST", {
    body: '{"action":"generate_mcp_key"}', contentType: "application/json",
  }))).status, 200);
  assert.equal((await route.POST(apiRequest("/api/settings", "POST", {
    ...publicHeaders, forwardedProto: "https, http", body: '{"action":"generate_mcp_key"}', contentType: "application/json",
  }))).status, 200);
  assert.equal(generated, 3);
  assert.equal(saved, 1);
});

test("ordinary proxy rejects foreign writes and strips browser Origin only after validation", async () => {
  let calls = 0;
  const proxy = await loadSource("../src/lib/shopkeeper-proxy.ts", {}, {
    fetch: async (_url, init) => {
      calls++;
      assert.equal(init.headers.get("Origin"), null);
      assert.equal(init.headers.get("Sec-Fetch-Site"), null);
      return new Response(null, { status: 204 });
    },
  });
  const route = await loadSource("../src/app/api/[...path]/route.ts", {
    "@/lib/ordinary-api-origin": originHelper,
    "@/lib/shopkeeper-proxy": proxy,
  });
  const form = '{"url":"https://example.test/?pad==","check_type":"single"}\r\n';
  for (const path of ["/api/scans", "/api/link-checks", "/api/scans/id/pause"]) {
    const response = await route.POST(apiRequest(path, "POST", {
      origin: "https://foreign.test", body: path.endsWith("pause") ? undefined : form, contentType: "text/plain",
    }));
    assert.equal(response.status, 403);
  }
  assert.equal(calls, 0);
  assert.equal((await route.POST(apiRequest("/api/scans/id/pause", "POST", {
    origin: "https://lime.example.test", host: "lime.example.test", forwardedProto: "https", fetchSite: "same-origin",
  }))).status, 204);
  assert.equal((await route.POST(apiRequest("/api/scans", "POST", {
    body: '{"sitemap_url":"https://example.test/","scan_type":"single"}', contentType: "application/json",
  }))).status, 204);
  assert.equal(calls, 2);
});

test("read proxy preserves Origin and MCP proxy retains its separate Origin path", async () => {
  const seen = [];
  const proxy = await loadSource("../src/lib/shopkeeper-proxy.ts", {}, {
    fetch: async (url, init) => {
      seen.push([String(url), init.headers.get("Origin")]);
      return new Response(null, { status: 200 });
    },
  });
  const route = await loadSource("../src/app/api/[...path]/route.ts", {
    "@/lib/ordinary-api-origin": originHelper,
    "@/lib/shopkeeper-proxy": proxy,
  });
  assert.equal((await route.GET(apiRequest("/api/scans", "GET", { origin: "https://foreign.test" }))).status, 200);
  assert.equal((await proxy.proxyShopkeeperRequest(apiRequest("/mcp", "POST", {
    origin: "http://localhost:3002", body: '{}', contentType: "application/json",
  }), { bodyLimit: 1024 })).status, 200);
  assert.deepEqual(seen, [
    ["http://shopkeeper.invalid:8080/api/scans", "https://foreign.test"],
    ["http://shopkeeper.invalid:8080/mcp", "http://localhost:3002"],
  ]);
});
