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

async function loadRoute(
  limiter,
  fetchMock,
  shopkeeperUrl = "http://shopkeeper:8080",
  signalAPI = AbortSignal,
  timerAPI = { setTimeout, clearTimeout }
) {
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
    process: { env: { SHOPKEEPER_URL: shopkeeperUrl } },
    Response,
    Headers,
    AbortController,
    AbortSignal: signalAPI,
    setTimeout: timerAPI.setTimeout,
    clearTimeout: timerAPI.clearTimeout,
    URL,
    ReadableStream,
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
      acquire: async () => {
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
      acquire: async (_limit, signal) => {
        passedSignal = signal;
        return () => {};
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
    reportGenerationLimiter: { acquire: async () => () => {} },
  }, async () => {
    throw new Error("upstream offline");
  }, "http://service-user:service-password@shopkeeper:8080");
  const failedResponse = await failedRoute.GET(routeRequest(), { params: Promise.resolve({ id: "scan" }) });
  assert.equal(failedResponse.status, 502);
  const failedBody = await failedResponse.json();
  assert.match(failedBody.error, /unavailable/i);
  assert.ok(!JSON.stringify(failedBody).includes("service-password"));
});

test("a slow PDF send retains its permit until the response reaches EOF", async () => {
  const limiter = await loadLimiter();
  const finishUpstream = deferred();
  const encoder = new TextEncoder();
  let fetchCount = 0;
  const route = await loadRoute(limiter, async () => {
    fetchCount += 1;
    if (fetchCount === 1) {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode("%PDF-first"));
          void finishUpstream.promise.then(() => controller.close());
        },
      });
      return new Response(body, { headers: { "Content-Type": "application/pdf" } });
    }
    return new Response("%PDF-second", { headers: { "Content-Type": "application/pdf" } });
  });

  const first = await route.GET(routeRequest(), { params: Promise.resolve({ id: "first" }) });
  const secondPending = route.GET(routeRequest(), { params: Promise.resolve({ id: "second" }) });
  finishUpstream.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchCount, 1, "the next render must wait even after upstream finishes");
  assert.equal(await first.text(), "%PDF-first");
  const second = await secondPending;
  assert.equal(await second.text(), "%PDF-second");
  assert.equal(fetchCount, 2);
});

test("a stalled upstream PDF response times out and frees its permit", async () => {
  const limiter = await loadLimiter();
  const deadlines = [];
  const timerAPI = {
    setTimeout(callback, milliseconds) {
      assert.equal(milliseconds, 10 * 60 * 1000);
      const timer = { callback, cleared: false };
      deadlines.push(timer);
      return timer;
    },
    clearTimeout(timer) { timer.cleared = true; },
  };
  let fetchCount = 0;
  let upstreamAborted = false;
  const route = await loadRoute(limiter, async (_url, { signal }) => {
    fetchCount += 1;
    if (fetchCount === 1) {
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          upstreamAborted = true;
          reject(signal.reason);
        }, { once: true });
      });
    }
    return new Response("%PDF-after-header-timeout", {
      headers: { "Content-Type": "application/pdf" },
    });
  }, "http://shopkeeper:8080", AbortSignal, timerAPI);

  const stalled = route.GET(routeRequest(), { params: Promise.resolve({ id: "stalled" }) });
  await new Promise((resolve) => setImmediate(resolve));
  const nextPending = route.GET(routeRequest(), { params: Promise.resolve({ id: "next" }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchCount, 1);
  assert.equal(deadlines.length, 1);

  deadlines[0].callback();
  const failed = await stalled;
  assert.equal(failed.status, 502);
  assert.equal(upstreamAborted, true);
  assert.equal(deadlines[0].cleared, true);
  const next = await nextPending;
  assert.equal(await next.text(), "%PDF-after-header-timeout");
  assert.equal(fetchCount, 2);
});

test("header timeout is cleared before a healthy PDF transfer", async () => {
  const limiter = await loadLimiter();
  const deadlines = [];
  const timerAPI = {
    setTimeout(callback, milliseconds) {
      assert.equal(milliseconds, 10 * 60 * 1000);
      const timer = { callback, cleared: false };
      deadlines.push(timer);
      return timer;
    },
    clearTimeout(timer) { timer.cleared = true; },
  };
  const finishUpstream = deferred();
  let fetchSignal;
  const route = await loadRoute(limiter, async (_url, { signal }) => {
    fetchSignal = signal;
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("%PDF-healthy"));
        void finishUpstream.promise.then(() => controller.close());
      },
    }), { headers: { "Content-Type": "application/pdf" } });
  }, "http://shopkeeper:8080", AbortSignal, timerAPI);

  const response = await route.GET(routeRequest(), { params: Promise.resolve({ id: "healthy" }) });
  assert.equal(deadlines.length, 1);
  assert.equal(deadlines[0].cleared, true);
  if (!deadlines[0].cleared) deadlines[0].callback();
  assert.equal(fetchSignal.aborted, false);
  finishUpstream.resolve();
  assert.equal(await response.text(), "%PDF-healthy");
});

test("a stalled PDF transfer times out and frees its permit", async () => {
  const limiter = await loadLimiter();
  const deadlines = [];
  const signalAPI = {
    any: (signals) => AbortSignal.any(signals),
    timeout: (milliseconds) => {
      assert.equal(milliseconds, 10 * 60 * 1000);
      const controller = new AbortController();
      deadlines.push(controller);
      return controller.signal;
    },
  };
  let fetchCount = 0;
  let upstreamCancelled = false;
  const route = await loadRoute(limiter, async () => {
    fetchCount += 1;
    if (fetchCount === 1) {
      return new Response(new ReadableStream({
        cancel() {
          upstreamCancelled = true;
        },
      }), { headers: { "Content-Type": "application/pdf" } });
    }
    return new Response("%PDF-after-timeout", { headers: { "Content-Type": "application/pdf" } });
  }, "http://shopkeeper:8080", signalAPI);

  const stalled = await route.GET(routeRequest(), { params: Promise.resolve({ id: "stalled" }) });
  const nextPending = route.GET(routeRequest(), { params: Promise.resolve({ id: "next" }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchCount, 1);
  assert.equal(deadlines.length, 1);

  deadlines[0].abort(new DOMException("PDF transfer timed out", "TimeoutError"));
  await assert.rejects(stalled.arrayBuffer(), { name: "AbortError" });
  assert.equal(upstreamCancelled, true);
  const next = await nextPending;
  assert.equal(await next.text(), "%PDF-after-timeout");
  assert.equal(fetchCount, 2);
});

test("cancelling a PDF send releases its permit and cancels the upstream body", async () => {
  const limiter = await loadLimiter();
  let fetchCount = 0;
  let upstreamCancelled = false;
  const route = await loadRoute(limiter, async () => {
    fetchCount += 1;
    if (fetchCount === 1) {
      return new Response(new ReadableStream({
        cancel() {
          upstreamCancelled = true;
        },
      }), { headers: { "Content-Type": "application/pdf" } });
    }
    return new Response("%PDF-after-cancel");
  });

  const first = await route.GET(routeRequest(), { params: Promise.resolve({ id: "first" }) });
  const secondPending = route.GET(routeRequest(), { params: Promise.resolve({ id: "second" }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchCount, 1);
  await first.body.cancel();
  assert.equal(upstreamCancelled, true);
  const second = await secondPending;
  assert.equal(await second.text(), "%PDF-after-cancel");
});

test("aborting a PDF request during send releases its permit", async () => {
  const limiter = await loadLimiter();
  const controller = new AbortController();
  let fetchCount = 0;
  let upstreamCancelled = false;
  const route = await loadRoute(limiter, async () => {
    fetchCount += 1;
    if (fetchCount === 1) {
      return new Response(new ReadableStream({
        cancel() {
          upstreamCancelled = true;
        },
      }), { headers: { "Content-Type": "application/pdf" } });
    }
    return new Response("%PDF-after-abort");
  });

  const first = await route.GET(routeRequest(controller.signal), {
    params: Promise.resolve({ id: "first" }),
  });
  const secondPending = route.GET(routeRequest(), { params: Promise.resolve({ id: "second" }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchCount, 1);
  controller.abort();
  await assert.rejects(first.text(), { name: "AbortError" });
  assert.equal(upstreamCancelled, true);
  const second = await secondPending;
  assert.equal(await second.text(), "%PDF-after-abort");
});

test("a PDF over the streaming size cap fails and frees the next permit", async () => {
  const limiter = await loadLimiter();
  const chunk = new Uint8Array(1024 * 1024);
  let chunks = 0;
  let fetchCount = 0;
  const route = await loadRoute(limiter, async () => {
    fetchCount += 1;
    if (fetchCount === 1) {
      return new Response(new ReadableStream({
        pull(controller) {
          if (chunks < 65) {
            chunks += 1;
            controller.enqueue(chunk);
          } else {
            controller.close();
          }
        },
      }), { headers: { "Content-Type": "application/pdf" } });
    }
    return new Response("%PDF-after-limit");
  });

  const first = await route.GET(routeRequest(), { params: Promise.resolve({ id: "first" }) });
  const secondPending = route.GET(routeRequest(), { params: Promise.resolve({ id: "second" }) });
  const reader = first.body.getReader();
  for (let index = 0; index < 64; index += 1) {
    const value = await reader.read();
    assert.equal(value.done, false);
    assert.equal(value.value.byteLength, chunk.byteLength);
  }
  await assert.rejects(reader.read(), /response size limit/);
  const second = await secondPending;
  assert.equal(await second.text(), "%PDF-after-limit");
});

test("an oversized Content-Length is rejected before streaming", async () => {
  const limiter = await loadLimiter();
  let cancelled = false;
  const route = await loadRoute(limiter, async () => new Response(new ReadableStream({
    cancel() {
      cancelled = true;
    },
  }), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(64 * 1024 * 1024 + 1),
    },
  }));

  const response = await route.GET(routeRequest(), { params: Promise.resolve({ id: "scan" }) });
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /response size limit/);
  assert.equal(cancelled, true);
});

test("an upstream fetch error releases the PDF permit for the next request", async () => {
  const limiter = await loadLimiter();
  let fetchCount = 0;
  const route = await loadRoute(limiter, async () => {
    fetchCount += 1;
    if (fetchCount === 1) {
      throw new Error("backend unavailable");
    }
    return new Response("%PDF-recovered", { headers: { "Content-Type": "application/pdf" } });
  });

  const failed = await route.GET(routeRequest(), { params: Promise.resolve({ id: "first" }) });
  assert.equal(failed.status, 502);
  const recovered = await route.GET(routeRequest(), { params: Promise.resolve({ id: "second" }) });
  assert.equal(recovered.status, 200);
  assert.equal(await recovered.text(), "%PDF-recovered");
  assert.equal(fetchCount, 2);
});

test("an ordinary backend error response keeps its status, headers, and body", async () => {
  const limiter = await loadLimiter();
  const route = await loadRoute(limiter, async () => new Response("missing report", {
    status: 404,
    headers: { "Content-Type": "text/plain", "X-Report-Test": "kept" },
  }));

  const response = await route.GET(routeRequest(), { params: Promise.resolve({ id: "missing" }) });
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("X-Report-Test"), "kept");
  assert.equal(await response.text(), "missing report");
});
