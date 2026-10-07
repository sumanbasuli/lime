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
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    require: (name) => {
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    DOMException,
    ...globals,
  });
  return exports;
}

async function loadLimiter() {
  return loadSource("../src/lib/report-generation-limiter.ts");
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("ordinary PDF work starts immediately and queued work runs in order", async () => {
  const { reportGenerationLimiter: limiter } = await loadLimiter();
  const gate = deferred();
  const started = [];

  const first = limiter.run(1, () => {
    started.push("first");
    return gate.promise;
  });
  const second = limiter.run(1, async () => {
    started.push("second");
    return "second result";
  });

  assert.deepEqual(started, ["first"]);
  gate.resolve("first result");
  assert.deepEqual(await Promise.all([first, second]), ["first result", "second result"]);
  assert.deepEqual(started, ["first", "second"]);
});

test("a full PDF queue rejects overflow, then drains admitted work", async () => {
  const {
    MAX_QUEUED_REPORT_REQUESTS: maxQueued,
    ReportGenerationQueueFullError,
    reportGenerationLimiter: limiter,
  } = await loadLimiter();
  const gate = deferred();
  const first = limiter.run(1, () => gate.promise);
  const queued = Array.from({ length: maxQueued }, (_, index) =>
    limiter.run(1, async () => index)
  );
  let overflowStarted = false;

  await assert.rejects(
    limiter.run(1, async () => {
      overflowStarted = true;
    }),
    (error) => error instanceof ReportGenerationQueueFullError
  );
  assert.equal(overflowStarted, false);

  gate.resolve("first result");
  assert.equal(await first, "first result");
  assert.deepEqual(await Promise.all(queued), Array.from({ length: maxQueued }, (_, index) => index));
  assert.equal(await limiter.run(1, async () => "after drain"), "after drain");
});

test("abort removes a queued PDF request and frees its waiting slot", async () => {
  const {
    MAX_QUEUED_REPORT_REQUESTS: maxQueued,
    reportGenerationLimiter: limiter,
  } = await loadLimiter();
  const gate = deferred();
  const first = limiter.run(1, () => gate.promise);
  const controller = new AbortController();
  let cancelledTaskStarted = false;
  const cancelled = limiter.run(1, async () => {
    cancelledTaskStarted = true;
  }, controller.signal);
  const otherWaiters = Array.from({ length: maxQueued - 1 }, () =>
    limiter.run(1, async () => "queued")
  );

  controller.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  assert.equal(cancelledTaskStarted, false);
  const replacement = limiter.run(1, async () => "replacement");

  gate.resolve("first result");
  assert.equal(await first, "first result");
  assert.deepEqual(await Promise.all(otherWaiters), Array(maxQueued - 1).fill("queued"));
  assert.equal(await replacement, "replacement");
});

test("already aborted PDF work never starts", async () => {
  const { reportGenerationLimiter: limiter } = await loadLimiter();
  const controller = new AbortController();
  controller.abort();
  let started = false;

  await assert.rejects(
    limiter.run(1, async () => {
      started = true;
    }, controller.signal),
    { name: "AbortError" }
  );
  assert.equal(started, false);
  assert.equal(await limiter.run(1, async () => "still available"), "still available");
});

test("abort after a slot transfer releases it to the next PDF waiter", async () => {
  const { reportGenerationLimiter: limiter } = await loadLimiter();
  const controller = new AbortController();
  let cancelledTaskStarted = false;

  const first = limiter.run(1, async () => "first");
  const cancelled = limiter.run(1, async () => {
    cancelledTaskStarted = true;
  }, controller.signal);
  const next = limiter.run(1, async () => "next");
  queueMicrotask(() => controller.abort());

  assert.equal(await first, "first");
  await assert.rejects(cancelled, { name: "AbortError" });
  assert.equal(cancelledTaskStarted, false);
  assert.equal(await next, "next");
});

test("a lowered concurrency limit holds queued work until enough active jobs finish", async () => {
  const { reportGenerationLimiter: limiter } = await loadLimiter();
  const activeGates = Array.from({ length: 3 }, () => deferred());
  const active = activeGates.map((gate) => limiter.run(3, () => gate.promise));
  const queuedGate = deferred();
  const queuedStarted = deferred();
  let laterStarted = false;
  const queued = limiter.run(3, () => {
    queuedStarted.resolve();
    return queuedGate.promise;
  });
  const later = limiter.run(1, async () => {
    laterStarted = true;
    return "later";
  });

  activeGates[0].resolve("first");
  assert.equal(await active[0], "first");
  activeGates[1].resolve("second");
  assert.equal(await active[1], "second");
  assert.equal(laterStarted, false);
  activeGates[2].resolve("third");
  assert.equal(await active[2], "third");
  await queuedStarted.promise;
  assert.equal(laterStarted, false);

  queuedGate.resolve("queued");
  assert.equal(await queued, "queued");
  assert.equal(await later, "later");
});

test("a raised concurrency limit starts older waiters before a new caller", async () => {
  const { reportGenerationLimiter: limiter } = await loadLimiter();
  const firstGate = deferred();
  const olderGate = deferred();
  const secondOlderGate = deferred();
  const olderStarted = deferred();
  const secondOlderStarted = deferred();
  const started = [];

  const first = limiter.run(1, () => {
    started.push("first");
    return firstGate.promise;
  });
  const older = limiter.run(1, () => {
    started.push("older");
    olderStarted.resolve();
    return olderGate.promise;
  });
  const secondOlder = limiter.run(1, () => {
    started.push("second older");
    secondOlderStarted.resolve();
    return secondOlderGate.promise;
  });
  const newer = limiter.run(3, async () => {
    started.push("newer");
    return "newer";
  });

  await Promise.all([olderStarted.promise, secondOlderStarted.promise]);
  assert.deepEqual(started, ["first", "older", "second older"]);
  olderGate.resolve("older");
  assert.equal(await older, "older");
  assert.equal(await newer, "newer");
  assert.deepEqual(started, ["first", "older", "second older", "newer"]);

  firstGate.resolve("first");
  secondOlderGate.resolve("second older");
  assert.deepEqual(await Promise.all([first, secondOlder]), ["first", "second older"]);
});

test("non-finite concurrency limits fall back to one active job", async () => {
  const { reportGenerationLimiter: limiter } = await loadLimiter();
  const gate = deferred();
  const started = [];
  const first = limiter.run(Number.NaN, () => {
    started.push("first");
    return gate.promise;
  });
  const second = limiter.run(Number.POSITIVE_INFINITY, async () => {
    started.push("second");
    return "second";
  });
  const third = limiter.run(Number.NEGATIVE_INFINITY, async () => {
    started.push("third");
    return "third";
  });

  assert.deepEqual(started, ["first"]);
  gate.resolve("first");
  assert.deepEqual(await Promise.all([first, second, third]), ["first", "second", "third"]);
  assert.deepEqual(started, ["first", "second", "third"]);
});

async function loadRoute(limiter, fetchMock) {
  return loadSource("../src/app/api/scans/[id]/issues/report.pdf/route.ts", {
    "@/lib/report-settings": {
      getSystemSettings: async () => ({
        reporting: { pdfReportsEnabled: true },
        performance: { reportGenerationConcurrency: 1 },
      }),
    },
    "@/lib/performance-logging": { measureServerAction: (_name, action) => action() },
    "@/lib/report-generation-limiter": limiter,
  }, {
    process: { env: { SHOPKEEPER_URL: "http://shopkeeper:8080" } },
    Response,
    Headers,
    URL,
    fetch: fetchMock,
  });
}

function routeRequest(signal = new AbortController().signal) {
  return { signal, headers: new Headers(), nextUrl: { search: "?kind=failed&key=issue" } };
}

test("PDF route returns retryable 503 for queue overflow without contacting backend", async () => {
  const limiter = await loadLimiter();
  let fetchCalled = false;
  const route = await loadRoute({
    ...limiter,
    reportGenerationLimiter: {
      run: async () => {
        throw new limiter.ReportGenerationQueueFullError();
      },
    },
  }, async () => {
    fetchCalled = true;
  });

  const response = await route.GET(routeRequest(), { params: Promise.resolve({ id: "scan" }) });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Retry-After"), "30");
  assert.match((await response.json()).error, /busy/i);
  assert.equal(fetchCalled, false);
});

test("aborted PDF route waiter leaves before any backend request", async () => {
  const limiter = await loadLimiter();
  const gate = deferred();
  const active = limiter.reportGenerationLimiter.run(1, () => gate.promise);
  let fetchCalled = false;
  const route = await loadRoute(limiter, async () => {
    fetchCalled = true;
  });
  const controller = new AbortController();

  const waiting = route.GET(routeRequest(controller.signal), {
    params: Promise.resolve({ id: "scan" }),
  });
  await Promise.resolve();
  controller.abort();

  const response = await waiting;
  assert.equal(response.status, 499);
  assert.equal(fetchCalled, false);
  gate.resolve("active done");
  assert.equal(await active, "active done");
});

test("ordinary PDF proxy response and unrelated upstream errors retain their behavior", async () => {
  const limiter = await loadLimiter();
  let passedSignal;
  const route = await loadRoute({
    ...limiter,
    reportGenerationLimiter: {
      run: async (_limit, task, signal) => {
        passedSignal = signal;
        return task();
      },
    },
  }, async (url) => {
    assert.equal(url.href, "http://shopkeeper:8080/api/scans/scan/issues/report.pdf?kind=failed&key=issue");
    return new Response("%PDF-test", { status: 200, headers: { "Content-Type": "application/pdf" } });
  });

  const request = routeRequest();
  const response = await route.GET(request, { params: Promise.resolve({ id: "scan" }) });
  assert.equal(passedSignal, request.signal);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "application/pdf");
  assert.equal(await response.text(), "%PDF-test");

  const failedRoute = await loadRoute({
    ...limiter,
    reportGenerationLimiter: { run: async (_limit, task) => task() },
  }, async () => {
    throw new Error("upstream offline");
  });
  const failedResponse = await failedRoute.GET(routeRequest(), { params: Promise.resolve({ id: "scan" }) });
  assert.equal(failedResponse.status, 502);
});
