import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { connectMcp, MCP_LINK_TOOL_NAMES, MCP_TOOL_NAMES, readMcpTool } from "./verify-mcp.mjs";

const OUTCOMES = ["healthy", "redirected", "broken", "error", "blocked", "unchecked"];
const WRITE_TOOLS = ["create_link_check", "cancel_link_check", "delete_link_check", "recheck_link_check"];

function expectedPage(rest, collection) {
  return {
    [collection]: rest.items, total: rest.total, limit: rest.limit,
    offset: rest.offset, has_more: rest.has_more,
  };
}

function relativePaths(data, id) {
  assert.equal(data.paths_relative_to, "dashboard_origin");
  assert.equal(data.dashboard_path, id ? `/links/${id}` : null);
  assert.equal(data.csv_path, id ? `/api/link-checks/${id}/export.csv` : null);
}

async function expectToolError(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, true, `${name} rejects ${JSON.stringify(args)}`);
  const text = result.content?.find((item) => item.type === "text")?.text;
  assert.ok(text, `${name} explains the failure`);
  assert.doesNotMatch(text, /SQLSTATE|mcp_key_hash|panic:/i, "Tool errors do not reveal internal details");
}

// Called only after the parent verifier creates completed disposable fixtures.
// This helper itself performs no writes, key generation, or settings changes.
export async function verifyLinkMcp({
  url, key, baseUrl, json, checkId, companionScanId, noCompanionScanId,
  deletedCompanionScanId, otherCheckId, sourceCheckId = checkId, snapshot, requireHttp999 = false,
}) {
  assert.ok(checkId && companionScanId && noCompanionScanId && otherCheckId,
    "Link MCP verification needs saved standalone, companion, ordinary scan, and second-check fixtures");
  assert.notEqual(checkId, otherCheckId, "Cross-check source ownership needs distinct checks");
  const origin = new URL(baseUrl).origin;
  assert.equal(new URL(url).origin, origin, "Verify the canonical dashboard MCP endpoint");
  assert.equal(new URL(url).pathname, "/mcp");
  const rest = (route) => json(`${baseUrl}${route}`);
  const checkPath = `/api/link-checks/${checkId}`;
  const saved = await rest(checkPath);
  assert.equal(saved.status, "completed", "Saved result fixtures must be stable during read verification");
  const rawResults = await rest(`${checkPath}/results?limit=200&offset=0`);
  assert.ok(rawResults.items.length, "The fixture includes saved destinations");
  assert.equal(rawResults.has_more, false, "The saved fixture fits in the baseline page");
  const sourceCheckPath = `/api/link-checks/${sourceCheckId}`;
  assert.equal((await rest(sourceCheckPath)).status, "completed");
  const sourceResults = sourceCheckId === checkId ? rawResults : await rest(`${sourceCheckPath}/results?limit=200&offset=0`);
  const sourceResult = sourceResults.items.find((item) => item.occurrence_count > 1) || sourceResults.items[0];
  assert.ok(sourceResult, "The source fixture includes a saved destination");
  const otherResults = await rest(`/api/link-checks/${otherCheckId}/results?limit=1&offset=0`);
  assert.ok(otherResults.items[0], "The second check contains a result for cross-check ownership validation");
  const companionScan = await rest(`/api/scans/${companionScanId}`);
  const companion = await rest(`/api/scans/${companionScanId}/link-check`);
  assert.equal(companionScan.include_link_check, true);
  assert.ok(companion, "The companion scan still has its saved link check");
  assert.equal(companion.status, "completed");
  assert.equal((await rest(`/api/scans/${noCompanionScanId}`)).include_link_check, false);
  assert.equal(await rest(`/api/scans/${noCompanionScanId}/link-check`), null);
  if (deletedCompanionScanId) {
    assert.equal((await rest(`/api/scans/${deletedCompanionScanId}`)).include_link_check, true);
    assert.equal(await rest(`/api/scans/${deletedCompanionScanId}/link-check`), null);
  }
  if (requireHttp999) {
    assert.ok(rawResults.items.some((item) => item.status === "broken" && item.status_code === 999),
      "The controlled HTTP 999 fixture is saved as the raw broken outcome");
  }

  const state = snapshot || (async () => ({
    check: await rest(checkPath),
    results: await rest(`${checkPath}/results?limit=200&offset=0`),
    sourceCheck: await rest(sourceCheckPath),
    sources: await rest(`${sourceCheckPath}/results/${sourceResult.id}/sources?limit=200&offset=0`),
    companion: await rest(`/api/scans/${companionScanId}/link-check`),
    history: await rest("/api/link-checks?limit=200&offset=0"),
    stats: await rest("/api/link-checks/stats"),
    settings: await rest("/api/settings"),
  }));
  const before = await state();
  for (const rejectedKey of ["", `invalid-${randomUUID()}`]) {
    await assert.rejects(() => connectMcp(url, rejectedKey), /401|Unauthorized|unauthorized/,
      "The canonical Link Checker MCP path requires the existing bearer key");
  }
  const evidence = [];
  for (const sdk of ["v1", "v2"]) {
    const { client, trace } = await connectMcp(url, key, { sdk });
    const called = new Set();
    const read = async (name, args = {}) => {
      const data = await readMcpTool(client, name, args);
      called.add(name);
      assert.ok(!JSON.stringify(data).includes(key), "Saved link reads do not expose the MCP key");
      return data;
    };
    const pages = { history: 0, results: 0, sources: 0, sourcePageSizes: [], filters: {} };
    try {
      await client.ping();
      const tools = (await client.listTools()).tools;
      assert.deepEqual(tools.map((item) => item.name).sort(), [...MCP_TOOL_NAMES].sort());
      for (const name of MCP_LINK_TOOL_NAMES) {
        const tool = tools.find((item) => item.name === name);
        assert.equal(tool.annotations.readOnlyHint, true);
        assert.equal(tool.annotations.destructiveHint, false);
        assert.equal(tool.inputSchema.additionalProperties, false);
        for (const identifier of ["check_id", "result_id", "scan_id"]) {
          if (tool.inputSchema.properties[identifier]) assert.ok(tool.inputSchema.required.includes(identifier));
        }
        if (tool.inputSchema.properties.limit) {
          assert.equal(tool.inputSchema.properties.limit.minimum, 1);
          assert.equal(tool.inputSchema.properties.limit.maximum, 100);
          assert.equal(tool.inputSchema.properties.offset.minimum, 0);
          assert.equal(tool.inputSchema.properties.offset.maximum, 100000);
        }
      }
      assert.deepEqual(tools.find((item) => item.name === "list_link_check_results").inputSchema.properties.status.enum.sort(), [...OUTCOMES].sort());
      for (const name of WRITE_TOOLS) assert.ok(!tools.some((item) => item.name === name));

      const pageThrough = async (tool, collection, route, args = {}, metric, limit = 2) => {
        const all = [];
        let offset = 0;
        for (;;) {
          const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
          if (args.status) query.set("status", args.status);
          const direct = await rest(`${route}?${query}`);
          const data = await read(tool, { ...args, limit, offset });
          assert.deepEqual(data, expectedPage(direct, collection), `${tool} agrees with the exact saved REST page`);
          assert.equal(data.has_more, offset + data[collection].length < data.total);
          assert.ok(data[collection].length <= limit);
          metric(data[collection].length);
          all.push(...data[collection]);
          if (!data.has_more) {
            assert.equal(all.length, data.total, `${tool} returns every saved row`);
            break;
          }
          assert.ok(data[collection].length, "A non-terminal page must advance");
          offset += data[collection].length;
        }
        const exhausted = await read(tool, { ...args, limit: 100, offset: 100000 });
        const directExhausted = await rest(`${route}?limit=100&offset=100000${args.status ? `&status=${args.status}` : ""}`);
        assert.deepEqual(exhausted, expectedPage(directExhausted, collection));
        assert.deepEqual(exhausted[collection], []);
        assert.equal(exhausted.has_more, false);
        return all;
      };
      const defaults = await read("list_link_checks");
      assert.deepEqual(defaults, expectedPage(await rest("/api/link-checks?limit=20&offset=0"), "checks"));
      const history = await pageThrough("list_link_checks", "checks", "/api/link-checks", {}, () => pages.history++);
      assert.equal(new Set(history.map((item) => item.id)).size, history.length, "History pagination neither skips nor repeats jobs");
      assert.ok(history.some((item) => item.id === checkId));
      assert.deepEqual(await read("get_link_check_stats"), { stats: await rest("/api/link-checks/stats") });
      const detail = await read("get_link_check", { check_id: checkId });
      assert.deepEqual(detail.check, saved);
      assert.deepEqual(Object.keys(detail).sort(), ["check", "dashboard_path", "csv_path", "paths_relative_to"].sort());
      relativePaths(detail, checkId);
      const csv = await fetch(new URL(detail.csv_path, origin), { signal: AbortSignal.timeout(30_000) });
      assert.equal(csv.status, 200, "MCP CSV path resolves at the dashboard origin");
      assert.match(csv.headers.get("content-type"), /text\/csv/);
      assert.ok((await csv.text()).includes(rawResults.items[0].target_url), "CSV contains the saved destination snapshot");
      const companionData = await read("get_scan_link_check", { scan_id: companionScanId });
      assert.deepEqual(companionData, {
        scan_id: companionScanId, include_link_check: true, check: companion,
        dashboard_path: `/links/${companion.id}`, csv_path: `/api/link-checks/${companion.id}/export.csv`,
        paths_relative_to: "dashboard_origin",
      });
      for (const [id, included] of [[noCompanionScanId, false], [deletedCompanionScanId, true]]) {
        if (!id) continue;
        const data = await read("get_scan_link_check", { scan_id: id });
        assert.deepEqual(data, { scan_id: id, include_link_check: included, check: null, dashboard_path: null, csv_path: null, paths_relative_to: "dashboard_origin" });
      }
      assert.deepEqual(await read("list_link_check_results", { check_id: checkId }),
        expectedPage(await rest(`${checkPath}/results?limit=20&offset=0`), "results"));
      const results = await pageThrough("list_link_check_results", "results", `${checkPath}/results`, { check_id: checkId }, () => pages.results++);
      assert.equal(new Set(results.map((item) => item.id)).size, results.length);
      assert.deepEqual(results, rawResults.items, "MCP preserves raw status, HTTP code, URL, error and source preview fields");
      for (const status of OUTCOMES) {
        pages.filters[status] = 0;
        const filtered = await pageThrough("list_link_check_results", "results", `${checkPath}/results`, { check_id: checkId, status }, () => pages.filters[status]++);
        assert.ok(filtered.every((item) => item.status === status));
        assert.deepEqual(filtered, results.filter((item) => item.status === status), "Filtering preserves the stored classifications");
      }
      const sourcePath = `${sourceCheckPath}/results/${sourceResult.id}/sources`;
      assert.deepEqual(await read("list_link_check_sources", { check_id: sourceCheckId, result_id: sourceResult.id }),
        expectedPage(await rest(`${sourcePath}?limit=20&offset=0`), "sources"));
      const sources = await pageThrough("list_link_check_sources", "sources", sourcePath,
        { check_id: sourceCheckId, result_id: sourceResult.id }, (size) => { pages.sources++; pages.sourcePageSizes.push(size); }, 20);
      assert.equal(sources.length, sourceResult.occurrence_count, "Every reference is retained, including repeated source occurrences");
      if (sourceResult.occurrence_count === 45) assert.deepEqual(pages.sourcePageSizes, [20, 20, 5]);

      const missing = randomUUID();
      const invalid = [
        ["get_link_check", {}], ["get_link_check", { check_id: "invalid" }],
        ["get_link_check", { check_id: missing }], ["get_link_check", { check_id: checkId, extra: true }],
        ["get_link_check_stats", { extra: true }], ["list_link_checks", { extra: true }],
        ["get_scan_link_check", {}], ["get_scan_link_check", { scan_id: "invalid" }],
        ["get_scan_link_check", { scan_id: missing }], ["get_scan_link_check", { scan_id: noCompanionScanId, extra: true }],
        ["list_link_check_results", {}], ["list_link_check_results", { check_id: "invalid" }],
        ["list_link_check_results", { check_id: missing }], ["list_link_check_results", { check_id: checkId, status: "timeout" }],
        ["list_link_check_results", { check_id: checkId, status: "invalid" }], ["list_link_check_results", { check_id: checkId, extra: true }],
        ["list_link_check_sources", { check_id: sourceCheckId }], ["list_link_check_sources", { check_id: sourceCheckId, result_id: "invalid" }],
        ["list_link_check_sources", { check_id: missing, result_id: sourceResult.id }],
        ["list_link_check_sources", { check_id: sourceCheckId, result_id: missing }],
        ["list_link_check_sources", { check_id: sourceCheckId, result_id: otherResults.items[0].id }],
        ["list_link_check_sources", { check_id: sourceCheckId, result_id: sourceResult.id, extra: true }],
      ];
      for (const [name, args] of [
        ["list_link_checks", {}],
        ["list_link_check_results", { check_id: checkId }],
        ["list_link_check_sources", { check_id: sourceCheckId, result_id: sourceResult.id }],
      ]) {
        for (const pagination of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: "2" }, { offset: -1 }, { offset: 100001 }, { offset: 1.5 }, { offset: "2" }]) {
          invalid.push([name, { ...args, ...pagination }]);
        }
      }
      for (const [name, args] of invalid) await expectToolError(client, name, args);
      for (const name of WRITE_TOOLS) {
        await expectToolError(client, name, { check_id: checkId });
      }
      assert.deepEqual([...called].sort(), [...MCP_LINK_TOOL_NAMES].sort(), "Both SDK versions really execute all six link tools");
      assert.ok(trace.some((entry) => entry.rpcMethod === "initialize" && entry.status === 200));
      assert.ok(trace.some((entry) => entry.rpcMethod === "notifications/initialized" && entry.status === 202));
      evidence.push({
        sdk, checked: [...called], pages, invalidCalls: invalid.length, rejectedMutationTools: WRITE_TOOLS,
        rawHttp999Preserved: results.some((item) => item.status_code === 999 && item.status === "broken"),
        protocol: sdk === "v2" ? { era: client.getProtocolEra(), version: client.getNegotiatedProtocolVersion() } : undefined,
        trace,
      });
    } finally {
      await client.close();
    }
  }
  assert.deepEqual(await state(), before, "MCP reads, invalid calls and rejected writes leave saved records and settings unchanged");
  return { completedAt: new Date().toISOString(), endpoint: url, tools: MCP_LINK_TOOL_NAMES, sdk: evidence, unchangedRecordsAndSettings: true };
}
