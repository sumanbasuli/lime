import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isIP } from "node:net";
import test from "node:test";
import { domainToASCII } from "node:url";
import vm from "node:vm";

const projectRequire = createRequire(new URL("../package.json", import.meta.url));
const ts = projectRequire("typescript");

// Exercise the production helper and proxy without starting Next, Shopkeeper,
// PostgreSQL, or a network listener. The URL deliberately has an internal
// listener host: admission must use the wire Host, not request.url.
async function loadSource(path, dependencies, environment) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports, URL, Headers, Request, Response, Buffer, AbortSignal,
    process: environment,
    require: (name) => {
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
  });
  return exports;
}

async function hostFixture(config) {
  const environment = { env: { LIME_ALLOWED_HOSTS: config } };
  const allowedHosts = await loadSource("../src/lib/allowed-hosts.ts", {
    "node:net": { isIP },
    "node:url": { domainToASCII },
  }, environment);
  return { allowedHosts, environment };
}

function request(path = "/", { host, method = "GET", forwardedHost, forwardedProto, origin } = {}) {
  const url = `http://127.0.0.1:3000${path}`;
  const headers = new Headers();
  if (host !== undefined) headers.set("Host", host);
  if (forwardedHost !== undefined) headers.set("X-Forwarded-Host", forwardedHost);
  if (forwardedProto !== undefined) headers.set("X-Forwarded-Proto", forwardedProto);
  if (origin !== undefined) headers.set("Origin", origin);
  const value = new Request(url, { method, headers });
  value.nextUrl = new URL(url);
  return value;
}

function accepts(allowedHosts, host, options) {
  assert.equal(allowedHosts.rejectUntrustedHost(request("/", { host, ...options })), null, `Expected Host ${host} to be accepted`);
}

function rejects(allowedHosts, host, options) {
  const response = allowedHosts.rejectUntrustedHost(request("/", { host, ...options }));
  assert.ok(response instanceof Response, `Expected Host ${host} to be rejected`);
  assert.ok(response.status >= 400 && response.status < 500, `Expected client rejection for Host ${host}, got ${response.status}`);
}

function rejectsRawHost(allowedHosts, host) {
  // Fetch Headers strips surrounding whitespace. Feed the helper the raw
  // adapter value to verify it does not repair malformed authorities itself.
  const value = request("/", { host: "lime.example.com" });
  const raw = {
    url: value.url,
    method: value.method,
    nextUrl: value.nextUrl,
    headers: {
      get(name) { return name.toLowerCase() === "host" ? host : value.headers.get(name); },
      has(name) { return name.toLowerCase() === "host" || value.headers.has(name); },
    },
  };
  const response = allowedHosts.rejectUntrustedHost(raw);
  assert.ok(response instanceof Response && response.status >= 400 && response.status < 500, `Expected raw Host ${host} to be rejected`);
}

test("implicit loopback and literal IP hosts remain usable with custom ports", async () => {
  const { allowedHosts } = await hostFixture("");
  for (const host of [
    "localhost", "LOCALHOST:3100", "localhost.:8080",
    "127.0.0.1", "127.0.0.1:8180", "192.0.2.10:65535",
    "[::1]", "[::1]:3000", "[2001:db8::12]:8080",
    "[::ffff:127.0.0.1]:8080",
  ]) accepts(allowedHosts, host);
  rejects(allowedHosts, undefined);
  rejects(allowedHosts, "");
  rejects(allowedHosts, "browser-owned.example");
});

test("configured domains are exact, normalized, and independent of internal listener URL", async () => {
  const { allowedHosts } = await hostFixture("LIME.Example.COM., bücher.example, ui, shopkeeper, dashboard.internal, backend.internal");
  for (const host of [
    "lime.example.com", "LIME.EXAMPLE.COM.:8443", "xn--bcher-kva.example:443",
    "ui:3000", "shopkeeper:8080", "dashboard.internal:3000", "backend.internal:8080",
  ]) accepts(allowedHosts, host);
  for (const host of ["evil.lime.example.com", "lime.example.com.evil.test", "unconfigured.example"]) rejects(allowedHosts, host);
  accepts(allowedHosts, "lime.example.com:3100", { forwardedHost: "attacker.example", forwardedProto: "https" });
  rejects(allowedHosts, "attacker.example", { forwardedHost: "lime.example.com", forwardedProto: "https", origin: "https://attacker.example" });
  rejects(allowedHosts, "attacker.example", { origin: "https://attacker.example", method: "POST" });
});

test("ambiguous or malformed Host values fail closed", async () => {
  const { allowedHosts } = await hostFixture("lime.example.com");
  for (const host of [
    "lime.example.com, attacker.example", "lime.example.com, lime.example.com",
    "https://lime.example.com", "user@lime.example.com", "lime.example.com/path",
    "lime.example.com?query", "lime.example.com#fragment", "lime.example.com:",
    "local%68ost", "lime%2eexample.com",
    "lime.example.com:word", "lime.example.com:0", "lime.example.com:65536",
    "::1", "[::1", "[::1]extra", "[fe80::1%25en0]:3000",
    "127.1", "0x7f000001", "010.0.0.1",
  ]) rejects(allowedHosts, host);
  for (const host of [" lime.example.com", "lime.example.com ", "lime.example.com\t"]) rejectsRawHost(allowedHosts, host);
});

test("malformed allowlist configuration fails closed rather than silently dropping an entry", async () => {
  for (const value of [
    "lime.example.com,,other.example", "https://lime.example.com",
    "*.example.com", "lime.example.com/path", "lime.example.com:word",
  ]) {
    const { allowedHosts } = await hostFixture(value);
    rejects(allowedHosts, "lime.example.com");
    rejects(allowedHosts, "127.0.0.1");
  }
});

test("global Next proxy rejects unknown hosts before routes or report admission", async () => {
  const { allowedHosts, environment } = await hostFixture("lime.example.com,ui");
  let nextCalls = 0;
  let admissionCalls = 0;
  const admission = {
    REPORT_HTML_LEASE_HEADER: "x-lime-internal-report-lease",
    REPORT_HTML_RETRY_SECONDS: 30,
    admitHTMLReport() { admissionCalls += 1; return `lease-${admissionCalls}`; },
    releaseHTMLReport() {},
  };
  const { proxy, config } = await loadSource("../src/proxy.ts", {
    "next/server": { NextResponse: { next(options) { nextCalls += 1; return { kind: "next", options }; } } },
    "@/lib/allowed-hosts": allowedHosts,
    "@/lib/report-html-admission": admission,
  }, environment);

  assert.equal(config.matcher, "/:path*", "Host admission must cover every Next path");
  for (const path of [
    "/", "/scans", "/settings", "/api/settings", "/api/scans",
    "/api/scans/id/issues/report.csv", "/api/scans/id/issues/report.pdf",
    "/mcp", "/reports/scans/id/issues", "/_next/static/app.js",
  ]) {
    const response = proxy(request(path, { host: "attacker.example" }));
    assert.ok(response instanceof Response && response.status >= 400 && response.status < 500, `Expected ${path} to be rejected`);
  }
  assert.equal(nextCalls, 0);
  assert.equal(admissionCalls, 0, "Unknown hosts must not take report capacity");

  const write = proxy(request("/api/settings", { host: "attacker.example", method: "POST", origin: "http://attacker.example" }));
  assert.ok(write instanceof Response && write.status >= 400 && write.status < 500);
  assert.equal(nextCalls, 0);

  for (const path of ["/", "/api/settings", "/mcp", "/reports/scans/id/issues/extra"]) {
    const response = proxy(request(path, { host: "lime.example.com" }));
    assert.equal(response.kind, "next", `Expected ${path} to continue`);
  }
  assert.equal(admissionCalls, 0, "Only the exact printable report path needs a lease");

  const report = proxy(request("/reports/scans/id/issues", { host: "ui:3000" }));
  assert.equal(report.kind, "next");
  assert.equal(report.options.request.headers.get(admission.REPORT_HTML_LEASE_HEADER), "lease-1");
  assert.equal(admissionCalls, 1);
});
