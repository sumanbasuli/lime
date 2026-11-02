import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(new URL("../package.json", import.meta.url));
const ts = require("typescript");

async function loadBatcher() {
  const source = await readFile(
    new URL("../src/lib/report-group-batches.ts", import.meta.url),
    "utf8"
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports });
  return exports;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("report groups run two at a time and retain input order", async () => {
  const { createReportGroupScheduler, mapReportGroups } = await loadBatcher();
  const gates = Array.from({ length: 5 }, () => deferred());
  const thirdStarted = deferred();
  const fourthStarted = deferred();
  const fifthStarted = deferred();
  const started = [];
  let active = 0;
  let peakActive = 0;

  const result = mapReportGroups([0, 1, 2, 3, 4], (index) => {
    started.push(index);
    active++;
    peakActive = Math.max(peakActive, active);
    if (index === 2) thirdStarted.resolve();
    if (index === 3) fourthStarted.resolve();
    if (index === 4) fifthStarted.resolve();
    return gates[index].promise.finally(() => {
      active--;
    });
  }, createReportGroupScheduler());

  assert.deepEqual(started, [0, 1]);
  gates[1].resolve("second");
  await thirdStarted.promise;
  assert.deepEqual(started, [0, 1, 2]);
  gates[0].resolve("first");
  await fourthStarted.promise;
  assert.deepEqual(started, [0, 1, 2, 3]);

  gates[3].resolve("fourth");
  await fifthStarted.promise;
  assert.deepEqual(started, [0, 1, 2, 3, 4]);
  gates[2].resolve("third");
  gates[4].resolve("fifth");

  assert.deepEqual(Array.from(await result), [
    "first",
    "second",
    "third",
    "fourth",
    "fifth",
  ]);
  assert.equal(peakActive, 2);
  assert.equal(active, 0);
});

test("empty reports start no group reads", async () => {
  const { createReportGroupScheduler, mapReportGroups } = await loadBatcher();
  let started = false;
  const result = await mapReportGroups([], async () => {
    started = true;
  }, createReportGroupScheduler());
  assert.equal(started, false);
  assert.deepEqual(Array.from(result), []);
});

test("a failed group does not start later batches", async () => {
  const { createReportGroupScheduler, mapReportGroups } = await loadBatcher();
  const started = [];
  await assert.rejects(
    mapReportGroups([0, 1, 2], async (index) => {
      started.push(index);
      if (index === 0) throw new Error("group query failed");
      return index;
    }, createReportGroupScheduler()),
    /group query failed/
  );
  assert.deepEqual(started, [0, 1]);
});

test("failed and needs-review groups share the two-worker budget", async () => {
  const { createReportGroupScheduler, mapReportGroups } = await loadBatcher();
  const scheduler = createReportGroupScheduler();
  const gates = Array.from({ length: 4 }, () => deferred());
  const thirdStarted = deferred();
  const fourthStarted = deferred();
  const started = [];
  let active = 0;
  let peakActive = 0;

  const load = (index) => {
    started.push(index);
    active++;
    peakActive = Math.max(peakActive, active);
    if (index === 2) thirdStarted.resolve();
    if (index === 3) fourthStarted.resolve();
    return gates[index].promise.finally(() => {
      active--;
    });
  };

  const failed = mapReportGroups([0, 1], load, scheduler);
  const needsReview = mapReportGroups([2, 3], load, scheduler);
  assert.deepEqual(started, [0, 1]);

  gates[0].resolve("failed first");
  await thirdStarted.promise;
  assert.deepEqual(started, [0, 1, 2]);
  gates[1].resolve("failed second");
  await fourthStarted.promise;
  gates[2].resolve("review first");
  gates[3].resolve("review second");

  assert.deepEqual(Array.from(await failed), ["failed first", "failed second"]);
  assert.deepEqual(Array.from(await needsReview), ["review first", "review second"]);
  assert.equal(peakActive, 2);
  assert.equal(active, 0);
});

test("one failed group stops queued work in both issue kinds", async () => {
  const { createReportGroupScheduler, mapReportGroups } = await loadBatcher();
  const scheduler = createReportGroupScheduler();
  const firstGate = deferred();
  const secondGate = deferred();
  const started = [];
  const failed = mapReportGroups([0, 1], (index) => {
    started.push(index);
    return index === 0 ? firstGate.promise : secondGate.promise;
  }, scheduler);
  const needsReview = mapReportGroups([2, 3], async (index) => {
    started.push(index);
    return index;
  }, scheduler);

  assert.deepEqual(started, [0, 1]);
  const failedRejection = assert.rejects(failed, /group query failed/);
  const reviewRejection = assert.rejects(needsReview, /group query failed/);
  firstGate.resolve(Promise.reject(new Error("group query failed")));
  await Promise.all([failedRejection, reviewRejection]);
  secondGate.resolve("in-flight read completed");
  await secondGate.promise;
  assert.deepEqual(started, [0, 1]);
});

test("a transferred permit cannot start work after the report aborts", async () => {
  const { createReportGroupScheduler, mapReportGroups } = await loadBatcher();
  const scheduler = createReportGroupScheduler();
  const firstGate = deferred();
  const secondGate = deferred();
  const started = [];
  const first = mapReportGroups([0], (index) => {
    started.push(index);
    return firstGate.promise;
  }, scheduler);
  const second = mapReportGroups([1], (index) => {
    started.push(index);
    return secondGate.promise;
  }, scheduler);
  const queued = mapReportGroups([2], async (index) => {
    started.push(index);
    return index;
  }, scheduler);
  const queuedRejection = assert.rejects(queued, /report setup failed/);

  firstGate.resolve("first completed");
  queueMicrotask(() => scheduler.abort(new Error("report setup failed")));
  await queuedRejection;
  secondGate.resolve("second completed");
  await Promise.all([first, second]);
  assert.deepEqual(started, [0, 1]);
});

test("a failed report setup stops subsequent group reads", async () => {
  const { createReportGroupScheduler, mapReportGroups } = await loadBatcher();
  const scheduler = createReportGroupScheduler();
  const gates = [deferred(), deferred()];
  const started = [];
  const groups = mapReportGroups([0, 1, 2], (index) => {
    started.push(index);
    return gates[index].promise;
  }, scheduler);
  const rejection = assert.rejects(groups, /report setup failed/);

  scheduler.abort(new Error("report setup failed"));
  gates[0].resolve("first completed");
  gates[1].resolve("second completed");
  await rejection;
  assert.deepEqual(started, [0, 1]);
});
