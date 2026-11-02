import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(new URL("../package.json", import.meta.url));
const ts = require("typescript");

async function loadSource(path, dependencies = {}, globals = {}) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.React,
    },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    require: (name) => {
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    Response,
    Headers,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    ...globals,
  });
  return exports;
}

async function loadAdmission(globals = {}) {
  return loadSource("../src/lib/report-html-admission.ts", {
    "server-only": {},
    "node:crypto": { randomUUID: (() => {
      let index = 0;
      return () => `lease-${++index}`;
    })() },
  }, globals);
}

function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimeout(callback, milliseconds) {
      const timer = { callback, milliseconds, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) { timer.cleared = true; },
    fire(timer) {
      if (!timer.cleared) timer.callback();
    },
  };
}

async function loadProxy(admission, next = ({ request }) => ({ request })) {
  return loadSource("../src/proxy.ts", {
    "next/server": { NextResponse: { next } },
    "@/lib/allowed-hosts": { rejectUntrustedHost: () => null },
    "@/lib/report-html-admission": admission,
  });
}

function request(method = "GET", headerValue = null) {
  const headers = new Headers();
  headers.set("host", "ui");
  if (headerValue) headers.set("x-lime-internal-report-lease", headerValue);
  return { method, headers, nextUrl: { pathname: "/reports/scans/scan/issues" } };
}

test("HTML admission is bounded; claim extends the watchdog and release is idempotent", async () => {
  const timers = fakeTimers();
  const admission = await loadAdmission(timers);
  const first = admission.admitHTMLReport();
  assert.equal(first, "lease-1");
  for (let i = 0; i < 9; i += 1) assert.ok(admission.admitHTMLReport());
  assert.equal(admission.admitHTMLReport(), null);
  assert.equal(admission.claimHTMLReport("forged"), null);
  assert.equal(admission.claimHTMLReport(null), null);
  assert.equal(timers.timers[0].milliseconds, 5 * 1000);
  const release = admission.claimHTMLReport(first);
  assert.equal(timers.timers[0].cleared, true);
  assert.equal(timers.timers[10].milliseconds, 10 * 60 * 1000);
  assert.equal(admission.claimHTMLReport(first), release);
  assert.equal(timers.timers.length, 11, "repeated claims must not refresh the watchdog");
  timers.fire(timers.timers[0]);
  assert.equal(admission.admitHTMLReport(), null, "the old handoff timeout cannot release a claimed lease");
  release();
  admission.releaseHTMLReport(first);
  assert.equal(timers.timers[10].cleared, true);
  assert.equal(admission.claimHTMLReport(first), null);
  const second = admission.admitHTMLReport();
  assert.equal(second, "lease-11");
  assert.equal(timers.timers[11].milliseconds, 5 * 1000);
  timers.fire(timers.timers[11]);
  assert.equal(admission.claimHTMLReport(second), null);
  assert.equal(admission.admitHTMLReport(), "lease-12");
});

test("proxy handoff with no page claim recovers after five seconds", async () => {
  const timers = fakeTimers();
  const admission = await loadAdmission(timers);
  const { proxy } = await loadProxy(admission);
  const orphan = proxy(request()).request.headers.get(admission.REPORT_HTML_LEASE_HEADER);
  assert.equal(orphan, "lease-1");
  for (let i = 0; i < 9; i += 1) assert.ok(admission.admitHTMLReport());
  assert.equal(timers.timers[0].milliseconds, 5 * 1000);
  assert.equal(proxy(request()).status, 503);
  timers.fire(timers.timers[0]);
  assert.equal(admission.claimHTMLReport(orphan), null);
  assert.equal(proxy(request()).request.headers.get(admission.REPORT_HTML_LEASE_HEADER), "lease-11");
});

test("proxy fails fast with retryable 503 and never trusts a caller lease", async () => {
  const admission = await loadAdmission(fakeTimers());
  let nextCalls = 0;
  const { proxy, config } = await loadProxy(admission, (options) => {
    nextCalls += 1;
    return options;
  });
  assert.equal(config.matcher, "/:path*");
  const accepted = proxy(request("GET", "attacker-token"));
  const internal = accepted.request.headers.get(admission.REPORT_HTML_LEASE_HEADER);
  assert.equal(internal, "lease-1");
  assert.notEqual(internal, "attacker-token");
  for (let i = 0; i < 9; i += 1) assert.ok(admission.admitHTMLReport());
  const busy = proxy(request("GET", "lease-1"));
  assert.equal(busy.status, 503);
  assert.equal(busy.headers.get("Retry-After"), String(admission.REPORT_HTML_RETRY_SECONDS));
  assert.equal(busy.headers.get("Cache-Control"), "private, no-store");
  assert.match(await busy.text(), /busy/i);
  assert.equal(nextCalls, 1);
  const head = proxy(request("HEAD"));
  assert.equal(head.status, 503);
  assert.equal(await head.text(), "");
  assert.equal(nextCalls, 1);
  admission.releaseHTMLReport(internal);
  assert.equal(proxy(request("HEAD")).request.headers.get(admission.REPORT_HTML_LEASE_HEADER), "lease-11");
  assert.equal(proxy(request("POST")), undefined);
});

test("proxy releases a lease if its internal handoff throws", async () => {
  const admission = await loadAdmission(fakeTimers());
  const { proxy } = await loadProxy(admission, () => { throw new Error("handoff failed"); });
  assert.throws(() => proxy(request()), /handoff failed/);
  assert.equal(admission.admitHTMLReport(), "lease-2");
});

test("the HTML cap preserves the configured ten-PDF ceiling without a settings query", async () => {
  const admission = await loadAdmission(fakeTimers());
  const { proxy } = await loadProxy(admission);
  const first = proxy(request()).request.headers.get(admission.REPORT_HTML_LEASE_HEADER);
  const second = proxy(request()).request.headers.get(admission.REPORT_HTML_LEASE_HEADER);
  assert.equal(first, "lease-1");
  assert.equal(second, "lease-2");
  for (let i = 0; i < 8; i += 1) assert.ok(admission.admitHTMLReport());
  assert.equal(proxy(request()).status, 503);
  admission.releaseHTMLReport(first);
  assert.equal(proxy(request()).request.headers.get(admission.REPORT_HTML_LEASE_HEADER), "lease-11");
  admission.releaseHTMLReport(second);
  admission.releaseHTMLReport("lease-11");
  assert.equal(admission.admitHTMLReport(), "lease-12");
});

async function loadPage(admission, overrides = {}) {
  const callbacks = [];
  const calls = [];
  const missing = new Error("NEXT_NOT_FOUND");
  const settings = { fullPdfOccurrenceLimit: 11, singleIssuePdfOccurrenceLimit: 3, csvReportsEnabled: overrides.csvEnabled ?? true };
  const reportData = Object.hasOwn(overrides, "data") ? overrides.data : { report: "loaded" };
  const HtmlReportTooLargeError = class extends Error {};
  const reportContext = { read: () => {}, check: () => {} };
  const dependencies = {
    "react": { createElement: (_type, props, ...children) => ({ ...props, children }) },
    "next/navigation": { notFound: () => { throw missing; } },
    "next/server": { after: (callback) => callbacks.push(callback) },
    "next/headers": { headers: async () => new Headers({ [admission.REPORT_HTML_LEASE_HEADER]: overrides.token ?? "lease-1" }) },
    "@/components/issues-report-document": { IssuesReportDocument: () => {} },
    "@/lib/issues-report-data": {
      loadIssueReportData: async (...args) => { calls.push(["full", ...args]); return reportData; },
      loadScopedIssueReportData: async (...args) => { calls.push(["scoped", ...args]); return reportData; },
    },
    "@/lib/issue-report-scope": {
      getFirstSearchParam: (value) => Array.isArray(value) ? value[0] : value,
      resolveIssueReportScope: (kind, key) => kind && key ? { kind, key } : kind || key ? null : undefined,
    },
    "@/lib/performance-logging": { measureServerAction: (_name, action) => action() },
    "@/lib/report-settings": { getReportSettings: async () => overrides.settingsError ? Promise.reject(overrides.settingsError) : settings },
    "@/lib/report-html-admission": admission,
    "@/lib/html-report-read": {
      HtmlReportTooLargeError,
      withHtmlReportRead: async (work) => {
        if (overrides.tooLarge) throw new HtmlReportTooLargeError("This report is too large to render safely. Download the complete CSV export instead.");
        return work(reportContext);
      },
    },
  };
  if (overrides.afterThrows) dependencies["next/server"].after = () => { throw new Error("after failed"); };
  const page = await loadSource("../src/app/reports/scans/[id]/issues/page.tsx", dependencies, { React: dependencies.react });
  const render = (searchParams = {}) => page.default({ params: Promise.resolve({ id: "scan" }), searchParams: Promise.resolve(searchParams) });
  return { callbacks, calls, missing, render, settings };
}

test("oversized full and scoped HTML reports expose complete CSV links", async () => {
  for (const [query, expected] of [
    [{}, "/api/scans/scan/issues/report.csv?mode=full"],
    [{ kind: "needs_review", key: "rule / &" }, "/api/scans/scan/issues/report.csv?mode=full&kind=needs_review&key=rule+%2F+%26"],
  ]) {
    const admission = await loadAdmission(fakeTimers());
    const page = await loadPage(admission, { token: admission.admitHTMLReport(), tooLarge: true });
    const result = await page.render(query);
    assert.equal(result["data-report-too-large"], "true");
    assert.equal(result.children[2].href, expected);
    assert.equal(page.calls.length, 0, "rejected reports have no partial document");
    page.callbacks[0]();
  }
});

test("oversized HTML reports respect disabled CSV exports", async () => {
  const admission = await loadAdmission(fakeTimers());
  const page = await loadPage(admission, { token: admission.admitHTMLReport(), tooLarge: true, csvEnabled: false });
  const result = await page.render();
  assert.equal(result["data-report-too-large"], "true");
  assert.equal(result.children[2].href, undefined);
  assert.match(result.children[2].children[0], /CSV exports are disabled/);
  page.callbacks[0]();
});

test("page keeps full and scoped loader budgets and releases after normal render", async () => {
  for (const [query, expected] of [
    [{}, "full"],
    [{ kind: "failed", key: "issue" }, "scoped"],
  ]) {
    const admission = await loadAdmission(fakeTimers());
    const token = admission.admitHTMLReport();
    const page = await loadPage(admission, { token });
    const result = await page.render(query);
    assert.equal(page.callbacks.length, 1);
    assert.equal(page.calls.length, 1);
    assert.equal(page.calls[0][0], expected);
    assert.equal(page.calls[0][1], "scan");
    if (expected === "full") {
      assert.equal(page.calls[0][2].occurrenceLimit, 11);
      assert.equal(result.reportScope, "scan");
    } else {
      assert.equal(page.calls[0][2].kind, "failed");
      assert.equal(page.calls[0][3].occurrenceLimit, 3);
      assert.equal(result.reportScope, "issue");
    }
    assert.equal(page.calls[0].at(-1).includeAffectedPages, true);
    assert.ok(page.calls[0].at(-1).context, "HTML reports must bound reads before loading rows");
    assert.equal(typeof admission.claimHTMLReport(token), "function");
    page.callbacks[0]();
    assert.equal(admission.claimHTMLReport(token), null);
    assert.ok(admission.admitHTMLReport());
  }
});

test("page release callback survives notFound and loader error paths", async () => {
  for (const overrides of [
    { query: { kind: "failed" } },
    { data: null },
    { settingsError: new Error("settings failed") },
  ]) {
    const admission = await loadAdmission(fakeTimers());
    const token = admission.admitHTMLReport();
    const page = await loadPage(admission, { ...overrides, token });
    await assert.rejects(page.render(overrides.query), (error) => error === (overrides.settingsError ?? page.missing));
    assert.equal(page.callbacks.length, 1);
    assert.equal(typeof admission.claimHTMLReport(token), "function");
    page.callbacks[0]();
    assert.equal(admission.claimHTMLReport(token), null);
    assert.ok(admission.admitHTMLReport());
  }
});

test("page fails closed on an unclaimed lease and releases if after registration fails", async () => {
  const admission = await loadAdmission(fakeTimers());
  const unclaimed = await loadPage(admission);
  await assert.rejects(unclaimed.render(), /admission is unavailable/);
  assert.equal(unclaimed.callbacks.length, 0);
  const token = admission.admitHTMLReport();
  const broken = await loadPage(admission, { token, afterThrows: true });
  await assert.rejects(broken.render(), /after failed/);
  assert.equal(admission.claimHTMLReport(token), null);
});

test("PDF rendering can nest inside the separate HTML gate", async () => {
  const admission = await loadAdmission(fakeTimers());
  const limiter = await loadSource("../src/lib/report-generation-limiter.ts");
  const { proxy } = await loadProxy(admission);
  let finish;
  const held = new Promise((resolve) => { finish = resolve; });
  let saturated;
  const entered = new Promise((resolve) => { saturated = resolve; });
  const pdf = limiter.reportGenerationLimiter.run(1, async () => {
    const handoff = proxy(request());
    const token = handoff.request.headers.get(admission.REPORT_HTML_LEASE_HEADER);
    assert.ok(token);
    const page = await loadPage(admission, { token });
    await page.render();
    const others = Array.from({ length: 9 }, () => admission.admitHTMLReport());
    assert.equal(proxy(request()).status, 503);
    saturated();
    await held;
    page.callbacks[0]();
    others.forEach(admission.releaseHTMLReport);
    return "pdf finished";
  });
  await Promise.race([entered, pdf]);
  assert.equal(admission.admitHTMLReport(), null);
  finish();
  assert.equal(await pdf, "pdf finished");
  assert.ok(admission.admitHTMLReport());
});
