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
    exports, URL, Headers, Response, Request, AbortSignal, Buffer, JSON, setTimeout,
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
const boundedBody = await loadSource("../src/lib/bounded-json-body.ts");

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

function streamedSettingsRequest(method, stream, headers = {}) {
  return new Request("http://127.0.0.1:3000/api/settings", {
    method, headers, body: stream, duplex: "half",
  });
}

test("settings rejects text/plain cross-site forms before key rotation or save", async () => {
  let generated = 0;
  let saved = 0;
  const route = await loadSource("../src/app/api/settings/route.ts", {
    "@/lib/ordinary-api-origin": originHelper,
    "@/lib/bounded-json-body": boundedBody,
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
    "@/lib/bounded-json-body": boundedBody,
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

test("settings limits actual streamed bytes on PUT and POST without trusting Content-Length", async () => {
  let generated = 0;
  let saved = 0;
  const route = await loadSource("../src/app/api/settings/route.ts", {
    "@/lib/ordinary-api-origin": originHelper,
    "@/lib/bounded-json-body": boundedBody,
    "@/lib/report-settings": {
      generateMcpKey: async () => { generated++; return {}; },
      saveSystemSettings: async () => { saved++; return {}; },
      getSystemSettings: async () => ({}),
    },
  });
  const oversized = () => new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(1024 * 1024));
      controller.enqueue(new Uint8Array([123]));
      controller.close();
    },
  });

  for (const method of ["PUT", "POST"]) {
    const response = await route[method](streamedSettingsRequest(method, oversized(), {
      "Content-Length": "1", "Content-Type": "application/json",
    }));
    assert.equal(response.status, 413);
    assert.equal(response.headers.get("Connection"), "close");
  }
  assert.equal(saved, 0);
  assert.equal(generated, 0);

  // A forged large header must not reject a small, legitimate request.
  assert.equal((await route.POST(apiRequest("/api/settings", "POST", {
    body: '{"action":"generate_mcp_key"}', contentType: "text/plain",
  }))).status, 200);
  assert.equal(generated, 1);
});

test("settings times out a stalled body and retains JSON/BOM compatibility", async () => {
  let generated = 0;
  let saved = 0;
  let canceled = 0;
  const shortDeadlineBody = {
    readBoundedJSONBody: (request, options) =>
      boundedBody.readBoundedJSONBody(request, { ...options, timeoutMs: 20 }),
  };
  const route = await loadSource("../src/app/api/settings/route.ts", {
    "@/lib/ordinary-api-origin": originHelper,
    "@/lib/bounded-json-body": shortDeadlineBody,
    "@/lib/report-settings": {
      generateMcpKey: async () => { generated++; return {}; },
      saveSystemSettings: async () => { saved++; return {}; },
      getSystemSettings: async () => ({}),
    },
  });
  const stalled = new ReadableStream({ cancel() { canceled++; } });
  const timedOut = await route.POST(streamedSettingsRequest("POST", stalled));
  assert.equal(timedOut.status, 408);
  assert.equal(timedOut.headers.get("Connection"), "close");
  assert.equal(canceled, 1);
  assert.equal(generated, 0);
  assert.equal(saved, 0);

  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from('{"action":"generate_mcp_key"}')]);
  assert.equal((await route.POST(apiRequest("/api/settings", "POST", { body: bom, contentType: "text/plain" }))).status, 200);
  assert.equal((await route.PUT(apiRequest("/api/settings", "PUT", {
    body: '{"reporting":{"pdfReportsEnabled":true}}', contentType: "text/plain",
  }))).status, 200);
  assert.equal((await route.PUT(apiRequest("/api/settings", "PUT", { body: "not json" }))).status, 400);
  assert.equal((await route.POST(apiRequest("/api/settings", "POST", { body: "not json" }))).status, 400);
  assert.equal(generated, 1);
  assert.equal(saved, 1);
});

test("settings bounds pathological tiny chunks and yields to the upload deadline", async () => {
  const manyEmptyChunks = () => {
    let sent = 0;
    return new ReadableStream({
      pull(controller) {
        if (sent++ < 100_000) controller.enqueue(new Uint8Array(0));
        else controller.close();
      },
    });
  };
  const timedOut = await boundedBody.readBoundedJSONBody(
    streamedSettingsRequest("PUT", manyEmptyChunks()),
    { maxBytes: 1024 * 1024, timeoutMs: 5 },
  );
  assert.equal(timedOut.kind, "timed_out");

  const emptyChunkDeadline = await boundedBody.readBoundedJSONBody(
    streamedSettingsRequest("PUT", manyEmptyChunks()),
    { maxBytes: 1024 * 1024, timeoutMs: 20 },
  );
  assert.equal(emptyChunkDeadline.kind, "timed_out");

  const emptyChunkLimit = await boundedBody.readBoundedJSONBody(
    streamedSettingsRequest("PUT", manyEmptyChunks()),
    { maxBytes: 1024 * 1024, timeoutMs: 5_000 },
  );
  assert.equal(emptyChunkLimit.kind, "too_large");

  let sent = 0;
  const fragmented = new ReadableStream({
    pull(controller) {
      if (sent < 8_193) controller.enqueue(new Uint8Array([sent++ === 0 ? 49 : 32]));
      else controller.close();
    },
  });
  const smallFragmentedJSON = await boundedBody.readBoundedJSONBody(
    streamedSettingsRequest("PUT", fragmented),
    { maxBytes: 1024 * 1024, timeoutMs: 5_000 },
  );
  assert.equal(smallFragmentedJSON.kind, "ok");
  assert.equal(smallFragmentedJSON.value, 1);
});

test("settings accepts the exact byte cap and cancels an aborted body", async () => {
  const json = '{"action":"generate_mcp_key"}';
  const exact = await boundedBody.readBoundedJSONBody(
    apiRequest("/api/settings", "POST", { body: json }),
    { maxBytes: Buffer.byteLength(json), timeoutMs: 1_000 },
  );
  assert.equal(exact.kind, "ok");
  assert.equal(exact.value.action, "generate_mcp_key");

  let canceled = 0;
  const controller = new AbortController();
  const request = new Request("http://127.0.0.1:3000/api/settings", {
    method: "PUT", signal: controller.signal, duplex: "half",
    body: new ReadableStream({ cancel() { canceled++; } }),
  });
  const reading = boundedBody.readBoundedJSONBody(request, {
    maxBytes: 1024 * 1024, timeoutMs: 1_000,
  });
  controller.abort();
  assert.equal((await reading).kind, "invalid");
  assert.equal(canceled, 1);

  let preCanceled = 0;
  const preController = new AbortController();
  const preRequest = new Request("http://127.0.0.1:3000/api/settings", {
    method: "PUT", signal: preController.signal, duplex: "half",
    body: new ReadableStream({ cancel() { preCanceled++; } }),
  });
  preController.abort();
  assert.equal((await boundedBody.readBoundedJSONBody(preRequest, {
    maxBytes: 1024 * 1024, timeoutMs: 1_000,
  })).kind, "invalid");
  assert.equal(preCanceled, 1);
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

test("screenshot proxy preserves the backend private no-store policy", async () => {
  const proxy = await loadSource("../src/lib/shopkeeper-proxy.ts", {}, {
    fetch: async () => new Response("image", {
      headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store" },
    }),
  });
  const route = await loadSource("../src/app/api/[...path]/route.ts", {
    "@/lib/ordinary-api-origin": originHelper,
    "@/lib/shopkeeper-proxy": proxy,
  });
  const response = await route.GET(apiRequest("/api/screenshots/scan-1/page.png", "GET"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(await response.text(), "image");
});
