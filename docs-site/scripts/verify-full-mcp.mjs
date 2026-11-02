import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { connectMcp, readMcpTool } from "./verify-mcp.mjs";
import { waitForLinkCheck } from "./verify-links.mjs";

export const MCP_WRITE_TOOL_NAMES = [
  "create_scan", "pause_scan", "resume_scan", "retry_failed_pages", "rescan_scan", "delete_scan",
  "mark_issue_false_positive", "create_link_check", "cancel_link_check", "recheck_link_check",
  "delete_link_check", "update_settings",
];

// State belongs to this verifier's fixture server, not an application database.
// Separate SDK paths keep retries and request counters deterministic.
const retryReady = new Set();

export function handleFullMcpFixture(request, response, { origin, renderPage }) {
  const pathname = new URL(request.url, origin).pathname;
  const match = pathname.match(/^\/full-mcp\/(v[12])\/(.+)$/);
  if (!match) return false;
  const [, sdk, route] = match;
  const prefix = `/full-mcp/${sdk}`;
  const send = (type, body) => {
    if (!response.destroyed) {
      response.writeHead(200, { "Content-Type": type });
      response.end(body);
    }
  };
  if (route.endsWith(".xml")) {
    const pages = route === "partial.xml"
      ? ["good", "retry"]
      : Array.from({ length: 8 }, (_, index) => `slow/${index}`);
    send("application/xml", `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${pages.map((page) => `<url><loc>${origin}${prefix}/${page}</loc></url>`).join("")}</urlset>`);
  } else if (route === "retry" && request.headers["user-agent"]?.includes("HeadlessChrome") && !retryReady.has(sdk)) {
    // Discovery/eligibility requests succeed; only actual Chromium auditing
    // fails, making retry_failed_pages exercise a genuinely failed saved URL.
    request.socket.destroy();
  } else {
    const sendPage = () => send("text/html", renderPage(pathname).replace("</main>", '<a href="/links/missing">Known missing link</a><a href="/links/good">Known healthy link</a></main>'));
    if (route.startsWith("slow/") && route !== "slow/0" && request.headers["user-agent"]?.includes("HeadlessChrome")) {
      const timer = setTimeout(sendPage, 5000);
      timer.unref();
      response.once("close", () => clearTimeout(timer));
    } else sendPage();
  }
  return true;
}

const jsonOptions = (method, payload) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });

function actionData(name, data) {
  if (!MCP_WRITE_TOOL_NAMES.includes(name) || name === "update_settings") return data;
  assert.equal(data.action, name, "A write result names the executed operation");
  assert.ok(data.http_status >= 200 && data.http_status < 300, "A successful tool preserves the dashboard's actual success status");
  if (["create_scan", "pause_scan", "resume_scan", "rescan_scan"].includes(name)) return { scan: data.data };
  if (["create_link_check", "cancel_link_check", "recheck_link_check"].includes(name)) return { check: data.data };
  return data.data;
}

export function assertNoPrivateToolError(text, sensitiveValues = []) {
  assert.ok(!/SQLSTATE|panic:|postgres(ql)?:\/\//i.test(text), "Tool errors do not reveal internal SQL, panic, or credential details");
  // A rejected *field name* such as mcp_key_hash is harmless and useful.
  // Check actual instance secrets instead of treating the name as a leak.
  for (const value of sensitiveValues) {
    if (value) assert.ok(!text.includes(value), "Tool errors do not disclose a verification key or its stored private hash");
  }
}

export function assertInstalledClientWorkflows(result) {
  assert.ok(Array.isArray(result?.evidence) && Array.isArray(result?.trace), "Installed-client verification returns complete nested evidence and trace");
  assert.equal(result.userConfigsUnchanged, true, "Installed-client verification preserves user configuration");
  assert.ok(result.evidence.some((item) => item.client === "codex" && item.status === "passed"), "Installed Codex completes its real MCP workflow");
  assert.ok(result.evidence.some((item) => item.client === "opencode" && item.status === "workflow_passed"), "Installed OpenCode completes its real MCP workflow, not only a handshake");
  assert.ok(!result.evidence.some((item) => /failed|incomplete/i.test(item.status ?? "")), "Installed-client evidence contains no failed or incomplete phase");
  const createdIds = new Set(result.trace.filter((item) => item.succeeded && item.createdId && ["create_scan", "create_link_check"].includes(item.tool)).map((item) => item.createdId));
  assert.ok(createdIds.size > 0, "Installed workflows trace real owned fixture jobs");
  for (const id of createdIds) {
    assert.ok(result.evidence.some((item) => item.name === "installed_client_job_cleanup" && item.id === id && item.status === "deleted_and_verified"), "Every installed-client fixture job is deleted and verified absent");
  }
}

async function assertToolError(client, name, args, message, sensitiveValues) {
  let result;
  try {
    result = await client.callTool({ name, arguments: args });
  } catch (error) {
    assert.equal(error.code, -32602, `${name} has a supported, safe rejection`);
    assertNoPrivateToolError(String(error.message), sensitiveValues);
    return;
  }
  assert.equal(result.isError, true, `${name} must reject ${JSON.stringify(args)}`);
  const text = result.content?.filter((item) => item.type === "text").map((item) => item.text).join("\n");
  assert.ok(text, `${name} explains rejection`);
  assertNoPrivateToolError(text, sensitiveValues);
  if (message) assert.match(text, message);
}

function assertIsolatedEndpoints(baseUrl, apiUrl) {
  for (const [label, value, prohibited] of [["dashboard", baseUrl, ["3000", "3001"]], ["API", apiUrl, ["8080", "8081"]]]) {
    const endpoint = new URL(value);
    assert.ok(["127.0.0.1", "localhost"].includes(endpoint.hostname), `${label} must use isolated loopback networking`);
    assert.ok(endpoint.port && !prohibited.includes(endpoint.port), `${label} must not use the normal application port`);
    assert.ok(!endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash && endpoint.pathname === "/", "Keep test URLs credential-free and origin-only");
  }
}

// No standalone entry point: mutation verification can be invoked only by the
// isolated product runner, which owns fixtures, database and lifecycle cleanup.
export async function verifyFullMcp(options) {
  const { baseUrl, apiUrl, fixtureOrigin, verificationSql, json, request, page, navigate, waitForScan, outputDir, requests, restartBackend } = options;
  assertIsolatedEndpoints(baseUrl, apiUrl);
  assert.equal(await verificationSql("SELECT current_database()"), "lime_docs_db", "Full MCP verification must use the disposable docs database");
  const runId = options.runId || randomUUID().slice(0, 8);
  assert.match(runId, /^[A-Za-z0-9-]{1,32}$/, "Verification run ID is a safe short identifier");
  const tagPrefix = `full-mcp-${runId}`;
  // The normal scan pipeline inherits triage by exact saved target URL, not
  // tag. Keep reruns distinct without erasing evidence from earlier attempts.
  // Fixture routing/request counters intentionally continue using pathname.
  const fixtureTarget = (sdk, name) => `${fixtureOrigin}/full-mcp/${sdk}/${name}?run=${runId}`;
  const previous = await json(`${baseUrl}/api/settings`);
  const evidence = [];
  const clients = [];
  const ids = { scans: [], checks: [] };
  const sensitiveValues = [];
  const toolError = (client, name, args, message) => assertToolError(client, name, args, message, sensitiveValues);
  const redact = (value) => sensitiveValues.reduce((text, secret) => secret ? text.replaceAll(secret, "[REDACTED]") : text, String(value));
  const snapshot = () => verificationSql(`SELECT json_build_object(
    'scans',(SELECT coalesce(json_agg(s ORDER BY s.id),'[]'::json) FROM scans s),
    'urls',(SELECT coalesce(json_agg(u ORDER BY u.id),'[]'::json) FROM urls u),
    'issues',(SELECT coalesce(json_agg(i ORDER BY i.id),'[]'::json) FROM issues i),
    'checks',(SELECT coalesce(json_agg(c ORDER BY c.id),'[]'::json) FROM link_checks c),
    'results',(SELECT coalesce(json_agg(r ORDER BY r.id),'[]'::json) FROM link_check_results r),
    'settings',(SELECT coalesce(json_agg(to_jsonb(a)-'mcp_key_hash' ORDER BY a.key),'[]'::json) FROM app_settings a)
  )::text`);
  const track = (collection, record) => {
    assert.match(record?.id || "", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, `${collection} action returns a real UUID`);
    if (!ids[collection].includes(record.id)) ids[collection].push(record.id);
    return record;
  };
  let phase = "key generation and read-only compatibility";
  const setPhase = (next) => { phase = next; console.log(`Checking full MCP: ${phase}...`); };
  let key;
  try {
    setPhase(phase);
    const generated = await json(`${baseUrl}/api/settings`, jsonOptions("POST", { action: "generate_mcp_key" }));
    key = generated.mcpKey;
    assert.ok(key, "A disposable verification key is returned once");
    sensitiveValues.push(key);
    const storedHash = await verificationSql("SELECT mcp_key_hash FROM app_settings WHERE key='global'");
    assert.match(storedHash, /^[a-f0-9]{64}$/, "The disposable MCP key is stored only as its SHA256 hash");
    sensitiveValues.push(storedHash);
    await json(`${baseUrl}/api/settings`, jsonOptions("PUT", { integrations: { mcpEnabled: true, mcpAllowWrites: false } }));
    const v1 = await connectMcp(`${baseUrl}/mcp`, key);
    const v2 = await connectMcp(`${baseUrl}/mcp`, key, { sdk: "v2" });
    clients.push(v1, v2);
    for (const { client } of clients) {
      const catalog = (await client.listTools()).tools;
      assert.equal(catalog.length, 17, "Existing keys remain read-only with seventeen discoverable tools");
      assert.ok(MCP_WRITE_TOOL_NAMES.every((name) => !catalog.some((tool) => tool.name === name)), "Write tools are not advertised without explicit opt-in");
      const before = await snapshot();
      await toolError(client, "create_scan", { sitemap_url: fixtureTarget("v1", "good"), scan_type: "single", request_id: randomUUID() }, /write access is disabled/i);
      await toolError(client, "update_settings", { confirm: true, small_csv_occurrence_limit: 3 }, /write access is disabled/i);
      assert.equal(await snapshot(), before, "Permission-rejected calls do not alter saved data or settings");
    }
    evidence.push({ name: phase, status: "passed", readTools: 17, writesOptIn: true });

    setPhase("dashboard write opt-in: confirmation, unsaved draft and persisted permission");
    await navigate("/settings", "Settings");
    const writeCheckbox = page.getByLabel("Allow MCP write actions", { exact: true });
    assert.equal(await writeCheckbox.isChecked(), false, "Write access starts disabled in the actual Settings UI");
    let dismissed = false;
    page.once("dialog", async (dialog) => {
      assert.equal(dialog.type(), "confirm");
      assert.match(dialog.message(), /trusted clients|MCP clients/i);
      dismissed = true;
      await dialog.dismiss();
    });
    await writeCheckbox.locator("..").click();
    assert.equal(dismissed, true, "Enabling write actions asks for explicit confirmation");
    assert.equal(await writeCheckbox.isChecked(), false, "Cancelling confirmation leaves the write permission draft disabled");
    assert.equal((await readMcpTool(v1.client, "get_capabilities")).allow_writes, false);
    page.once("dialog", (dialog) => dialog.accept());
    await writeCheckbox.locator("..").click();
    assert.equal(await writeCheckbox.isChecked(), true, "Accepting confirmation enables only the unsaved draft");
    assert.equal((await readMcpTool(v1.client, "get_capabilities")).allow_writes, false, "An unsaved UI draft does not grant MCP mutation access");
    assert.equal((await v1.client.listTools()).tools.length, 17);
    const [savedResponse] = await Promise.all([
      page.waitForResponse((response) => response.url().endsWith("/api/settings") && response.request().method() === "PUT"),
      page.getByRole("button", { name: "Save settings", exact: true }).click(),
    ]);
    assert.equal(savedResponse.status(), 200);
    assert.equal((await savedResponse.json()).integrations.mcpAllowWrites, true);
    await page.getByText(/Settings saved/i).waitFor();
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
    assert.equal(await writeCheckbox.isChecked(), true, "Saved write access survives a Settings reload");
    assert.equal(await page.getByText("New MCP key", { exact: true }).count(), 0, "One-time raw key is absent after Settings reload");
    assert.ok(!(await page.locator("main").innerText()).includes(key), "Settings screenshot must not contain the verification bearer key");
    await page.screenshot({ path: path.join(outputDir, "full-mcp-settings.png"), fullPage: true });
    assert.equal((await readMcpTool(v1.client, "get_capabilities")).allow_writes, true);
    assert.equal((await v1.client.listTools()).tools.length, 29, "Saving the real UI opt-in exposes the full MCP tool catalog");
    evidence.push({ name: phase, status: "passed", confirmationCancelledSafely: true, unsavedDraftDidNotGrantWrites: true, savedPermissionSurvivedReload: true });

    for (const [index, connection] of clients.entries()) {
      const sdk = index === 0 ? "v1" : "v2";
      const client = connection.client;
      const peer = clients[index === 0 ? 1 : 0].client;
      const called = new Set();
      const call = async (name, args = {}) => { const data = await readMcpTool(client, name, args); called.add(name); return actionData(name, data); };
      const catalog = (await client.listTools()).tools;
      assert.equal(catalog.length, 29, "Explicit write access advertises twenty-nine complete workflow tools");
      for (const name of MCP_WRITE_TOOL_NAMES) {
        const tool = catalog.find((candidate) => candidate.name === name);
        assert.ok(tool, `${name} is discoverable in full mode`);
        assert.equal(tool.annotations.readOnlyHint, false, `${name} truthfully identifies mutation risk`);
      }
      const capabilities = await call("get_capabilities");
      assert.equal(capabilities.mode, "read_write");
      assert.equal(capabilities.allow_writes, true);
      assert.equal(capabilities.read_tools.length, 17);
      assert.deepEqual([...capabilities.write_tools].sort(), [...MCP_WRITE_TOOL_NAMES].sort());
      const stats = await call("get_workspace_stats");
      assert.deepEqual(stats.stats, await json(`${baseUrl}/api/stats`), "MCP workspace statistics use the same saved data as the dashboard");

      setPhase(`${sdk}: create scan, concurrent replay and companion results`);
      const createArgs = { sitemap_url: fixtureTarget(sdk, "good"), scan_type: "single", viewport_preset: "mobile", tag: `${tagPrefix}-${sdk}`, include_link_check: true, request_id: randomUUID() };
      const concurrent = await Promise.all([client.callTool({ name: "create_scan", arguments: createArgs }), peer.callTool({ name: "create_scan", arguments: createArgs })]);
      const success = concurrent.filter((result) => !result.isError);
      assert.ok(success.length >= 1, "One concurrent idempotent request creates the operation");
      for (const rejected of concurrent.filter((result) => result.isError)) assert.match(rejected.content[0].text, /in progress|pending|retry/i, "An in-flight duplicate is safely retryable");
      const created = track("scans", actionData("create_scan", success[0].structuredContent).scan);
      called.add("create_scan");
      const replay = await call("create_scan", createArgs);
      assert.equal(replay.scan.id, created.id, "Both client generations replay the same durable request_id without duplicating scans");
      assert.equal(await verificationSql(`SELECT count(*) FROM scans WHERE tag='${tagPrefix}-${sdk}'`), "1");
      await toolError(client, "create_scan", { ...createArgs, tag: "conflicting-replay" }, /request_id|different|conflict/i);
      await toolError(client, "create_link_check", { url: `${fixtureOrigin}/links/good`, check_type: "single", request_id: createArgs.request_id }, /request_id|different|conflict/i);
      await waitForScan(created.id);
      const scan = await call("get_scan", { scan_id: created.id });
      assert.equal(scan.scan.sitemap_url, createArgs.sitemap_url.split("?")[0], "MCP hides the saved target's isolation query");
      assert.equal(await verificationSql(`SELECT sitemap_url FROM scans WHERE id='${created.id}'`), createArgs.sitemap_url, "The private scan target retains its isolation query for execution and retry");
      assert.equal(scan.scan.viewport_preset, "mobile");
      assert.deepEqual([scan.scan.viewport_width, scan.scan.viewport_height], [390, 844]);
      assert.equal(scan.scan.include_link_check, true);
      assert.equal(scan.score_summary.has_full_coverage, true);
      const companion = await call("get_scan_link_check", { scan_id: created.id });
      track("checks", companion.check);
      await waitForLinkCheck(json, baseUrl, companion.check.id);
      const companionResults = await call("list_link_check_results", { check_id: companion.check.id, limit: 100 });
      assert.ok(companionResults.results.some((item) => item.target_url.endsWith("/links/missing") && item.status === "broken" && item.status_code === 404));
      await navigate(`/scans/${created.id}`);
      await page.getByText(`${tagPrefix}-${sdk}`, { exact: true }).waitFor({ state: "visible" });
      await page.screenshot({ path: path.join(outputDir, `full-mcp-${sdk}-scan.png`), fullPage: true });
      evidence.push({ name: phase, status: "passed", scanId: created.id, companionId: companion.check.id, targetUrl: createArgs.sitemap_url, idempotentReplay: true });

      setPhase(`${sdk}: false-positive set/unset and fresh scoring`);
      const groups = await call("list_scan_issues", { scan_id: created.id, limit: 100 });
      const label = groups.issues.find((group) => group.rule_id === "label" && group.kind === "failed");
      assert.ok(label?.issue_id || label?.key, "The real axe run saved an unlabeled-input issue");
      assert.equal(label.is_false_positive, false, "The isolated target starts untriaged before exercising both score transitions");
      const issueId = label.issue_id || label.key;
      const triageArgs = { scan_id: created.id, issue_id: issueId, false_positive: true };
      await call("mark_issue_false_positive", triageArgs);
      await call("mark_issue_false_positive", triageArgs);
      const marked = await call("get_scan", { scan_id: created.id });
      assert.ok(marked.score_summary.score > scan.score_summary.score, "Triage invalidates and recomputes the canonical dashboard score");
      assert.equal(marked.score_summary.failed_count, scan.score_summary.failed_count - 1);
      assert.equal((await call("list_scan_issues", { scan_id: created.id, limit: 100 })).issues.find((group) => group.key === label.key).is_false_positive, true);
      await call("mark_issue_false_positive", { ...triageArgs, false_positive: false });
      assert.equal((await call("get_scan", { scan_id: created.id })).score_summary.score, scan.score_summary.score, "Explicit unmark restores the original score");
      const occurrences = await call("get_issue_detail", { scan_id: created.id, kind: label.kind, key: label.key, limit: 1 });
      const occurrence = occurrences.detail.occurrences[0];
      assert.ok(occurrence.screenshot_url && occurrence.element_screenshot_url);
      const reviewGroup = groups.issues.find((group) => group.kind === "needs_review");
      assert.ok(reviewGroup, "The controlled scan includes a real needs-review rule for scoped exports");
      evidence.push({ name: phase, status: "passed", issueId, originalScore: scan.score_summary.score, markedScore: marked.score_summary.score });

      setPhase(`${sdk}: actual reports, screenshots and link CSV content`);
      const reportEvidence = [];
      for (const [format, extra] of [
        ["pdf", {}], ["csv", { csv_mode: "small" }], ["csv", { csv_mode: "full" }], ["llm", {}],
        ["pdf", { issue_id: issueId }], ["csv", { issue_id: issueId }], ["llm", { issue_id: issueId }],
        ["pdf", { kind: "failed", key: issueId }],
        ["csv", { kind: "needs_review", key: reviewGroup.key }], ["llm", { kind: "needs_review", key: reviewGroup.key }],
      ]) {
        const result = await client.callTool({ name: "get_report", arguments: { scan_id: created.id, format, ...extra } });
        called.add("get_report");
        assert.notEqual(result.isError, true, result.content?.[0]?.text);
        if (format === "pdf") {
          const resource = result.content.find((item) => item.type === "resource" && item.resource?.mimeType === "application/pdf");
          assert.ok(resource?.resource?.blob, "PDF is actual embedded report content, not only an unauthenticated download path");
          const bytes = Buffer.from(resource.resource.blob, "base64");
          assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
          assert.ok(bytes.length > 100 && bytes.length <= 4 * 1024 * 1024);
          reportEvidence.push({ format, issueReport: Boolean(extra.issue_id), bytes: bytes.length });
        } else {
          // Content[0] is transport metadata. Check only the actual report body
          // so a scope mentioned in download_path cannot make a broken export pass.
          const text = result.content.slice(1).filter((item) => item.type === "text").map((item) => item.text).join("\n");
          assert.ok(text.length, "The actual report body is materialized after metadata");
          if (format === "csv") assert.match(text, /item_type,rule_id,/);
          else if (extra.kind === "needs_review") assert.ok(text.includes(reviewGroup.key), "Needs-review LLM body contains the scoped rule key");
          else assert.match(text, /label/);
          assert.ok(Buffer.byteLength(text) <= 4 * 1024 * 1024);
          assert.equal(result.structuredContent.byte_count, Buffer.byteLength(text), "Artifact metadata describes actual report bytes, not the JSON metadata envelope");
          reportEvidence.push({ format, mode: extra.csv_mode, bytes: Buffer.byteLength(text) });
        }
      }
      for (const screenshotPath of [occurrence.screenshot_url, occurrence.element_screenshot_url]) {
        const filename = screenshotPath.split("/").at(-1);
        const result = await client.callTool({ name: "get_screenshot", arguments: { scan_id: created.id, filename } });
        called.add("get_screenshot");
        assert.notEqual(result.isError, true, result.content?.[0]?.text);
        const image = result.content.find((item) => item.type === "image");
        assert.ok(image?.data && image.mimeType === "image/png");
        const savedBytes = Buffer.from(await (await request(new URL(screenshotPath, baseUrl))).arrayBuffer());
        assert.deepEqual(Buffer.from(image.data, "base64"), savedBytes, "MCP image bytes match the existing saved screenshot exactly");
      }
      const linkExport = await client.callTool({ name: "get_link_check_export", arguments: { check_id: companion.check.id } });
      called.add("get_link_check_export");
      assert.notEqual(linkExport.isError, true, linkExport.content?.[0]?.text);
      assert.match(linkExport.content.filter((item) => item.type === "text").map((item) => item.text).join("\n"), /\/links\/missing/);
      evidence.push({ name: phase, status: "passed", reports: reportEvidence, exactSavedScreenshotBytes: true });

      setPhase(`${sdk}: settings persistence, report gates and no MCP privilege escalation`);
      const originalSettings = await call("get_settings");
      await call("update_settings", { confirm: true, small_csv_occurrence_limit: 3, summary_cache_ttl_seconds: 45, report_generation_concurrency: 2 });
      const settings = await call("get_settings");
      assert.equal(settings.reporting.small_csv_occurrence_limit, 3);
      assert.equal(settings.performance.summary_cache_ttl_seconds, 45);
      assert.equal(settings.performance.report_generation_concurrency, 2);
      assert.equal(await verificationSql("SELECT small_csv_occurrence_limit || ',' || summary_cache_ttl_seconds || ',' || report_generation_concurrency FROM app_settings WHERE key='global'"), "3,45,2");
      await navigate("/settings", "Settings");
      assert.equal(await page.getByLabel(/^Small CSV sample size/).inputValue(), "3");
      await page.reload({ waitUntil: "domcontentloaded" });
      assert.equal(await page.getByLabel(/^Small CSV sample size/).inputValue(), "3", "MCP settings changes survive dashboard reload");
      const beforeBadSettings = await snapshot();
      for (const payload of [{ small_csv_occurrence_limit: 3 }, { confirm: false, small_csv_occurrence_limit: 3 }, { confirm: true }, { confirm: true, mcp_allow_writes: false }, { confirm: true, mcp_enabled: false }, { confirm: true, mcp_key_hash: "not-allowed" }, { confirm: true, reporting: { smallCsvOccurrenceLimit: 1 } }, { confirm: true, report_generation_concurrency: 0 }, { confirm: true, summary_cache_ttl_seconds: 4 }, { confirm: true, small_csv_occurrence_limit: 1.5 }]) await toolError(client, "update_settings", payload);
      assert.equal(await snapshot(), beforeBadSettings, "Rejected settings patches cannot partially alter settings or permissions");
      await call("update_settings", { confirm: true, pdf_reports_enabled: false, csv_reports_enabled: false, llm_reports_enabled: false });
      for (const format of ["pdf", "csv", "llm"]) await toolError(client, "get_report", { scan_id: created.id, format }, /disabled|enabled|unavailable/i);
      await call("update_settings", { confirm: true, ...originalSettings.reporting, summary_cache_ttl_seconds: originalSettings.performance.summary_cache_ttl_seconds, report_data_cache_ttl_seconds: originalSettings.performance.report_data_cache_ttl_seconds, report_generation_concurrency: originalSettings.performance.report_generation_concurrency });
      assert.ok(!JSON.stringify(settings).includes(key) && !JSON.stringify(settings).includes("mcp_key_hash"));
      evidence.push({ name: phase, status: "passed", databaseAndBrowserReload: true, integrationMutationRejected: true });

      setPhase(`${sdk}: same-ID pause/resume/retry and preserved completed pages`);
      const slow = track("scans", (await call("create_scan", { sitemap_url: fixtureTarget(sdk, "slow.xml"), scan_type: "sitemap", viewport_preset: "tablet", tag: `${tagPrefix}-${sdk}-pause`, include_link_check: true, request_id: randomUUID() })).scan);
      const active = await waitForScan(slow.id, ["scanning"]);
      assert.equal(active.id, slow.id);
      const deadline = Date.now() + 45_000;
      let completedBeforePause = 0;
      while (Date.now() < deadline) {
        // During the active batch, juicer publishes real completion progress;
        // URL/result rows are persisted together when the batch pauses/ends.
        completedBeforePause = (await json(`${baseUrl}/api/scans/${slow.id}`)).scanned_urls;
        if (completedBeforePause > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      assert.ok(completedBeforePause > 0 && completedBeforePause < 8, "Pause is tested after one real page completes, while work remains");
      await call("pause_scan", { scan_id: slow.id });
      const paused = await waitForScan(slow.id, ["paused"]);
      const pausedRows = await verificationSql(`SELECT coalesce(json_agg(u ORDER BY id),'[]'::json)::text FROM urls u WHERE scan_id='${slow.id}' AND status='completed'`);
      assert.ok(JSON.parse(pausedRows).length > 0 && paused.scanned_urls < 8, "Cooperative pause persists actual completed page work and leaves unfinished pages pending");
      const pausedCompanion = await call("get_scan_link_check", { scan_id: slow.id });
      track("checks", pausedCompanion.check);
      assert.equal(pausedCompanion.check.status, "queued", "A companion remains queued while its parent scan is paused");
      await call("resume_scan", { scan_id: slow.id });
      const completedSlow = await waitForScan(slow.id);
      assert.equal(completedSlow.id, paused.id);
      assert.equal(completedSlow.scanned_urls, 8);
      const resumedRows = JSON.parse(await verificationSql(`SELECT coalesce(json_agg(u ORDER BY id),'[]'::json)::text FROM urls u WHERE scan_id='${slow.id}' AND status='completed'`));
      for (const row of JSON.parse(pausedRows)) assert.deepEqual(resumedRows.find((item) => item.id === row.id), row, "Resume retains completed saved URL rows");
      await waitForLinkCheck(json, baseUrl, pausedCompanion.check.id);
      await toolError(client, "resume_scan", { scan_id: slow.id }, /paused|state|completed/i);
      await toolError(client, "pause_scan", { scan_id: slow.id }, /active|state|completed/i);
      retryReady.delete(sdk);
      const partial = track("scans", (await call("create_scan", { sitemap_url: fixtureTarget(sdk, "partial.xml"), scan_type: "sitemap", viewport_preset: "laptop", tag: `${tagPrefix}-${sdk}-retry`, request_id: randomUUID() })).scan);
      await waitForScan(partial.id);
      assert.equal(await verificationSql(`SELECT count(*) FROM urls WHERE scan_id='${partial.id}' AND status='failed'`), "1");
      const completedBeforeRetry = await verificationSql(`SELECT coalesce(json_agg(u ORDER BY id),'[]'::json)::text FROM urls u WHERE scan_id='${partial.id}' AND status='completed'`);
      const goodRequestCount = requests.get(`/full-mcp/${sdk}/good`);
      retryReady.add(sdk);
      const retry = await call("retry_failed_pages", { scan_id: partial.id });
      assert.equal(retry.scan.id, partial.id);
      assert.equal(retry.retried_url_count, 1);
      await waitForScan(partial.id);
      assert.equal(requests.get(`/full-mcp/${sdk}/good`), goodRequestCount, "Retry does not request an already-completed page again");
      const completedAfterRetry = JSON.parse(await verificationSql(`SELECT coalesce(json_agg(u ORDER BY id),'[]'::json)::text FROM urls u WHERE scan_id='${partial.id}' AND status='completed'`));
      for (const row of JSON.parse(completedBeforeRetry)) assert.deepEqual(completedAfterRetry.find((item) => item.id === row.id), row);
      await toolError(client, "retry_failed_pages", { scan_id: partial.id }, /failed|partial|state|retry/i);
      evidence.push({ name: phase, status: "passed", pausedScanId: slow.id, retainedCompletedPages: JSON.parse(pausedRows).length, retriedScanId: partial.id, retriedPages: 1 });

      setPhase(`${sdk}: rescan identity, inherited triage and durable replay`);
      await call("mark_issue_false_positive", triageArgs);
      const rescanArgs = { scan_id: created.id, request_id: randomUUID() };
      const rescanned = track("scans", (await call("rescan_scan", rescanArgs)).scan);
      assert.notEqual(rescanned.id, created.id);
      assert.equal(rescanned.viewport_preset, created.viewport_preset);
      assert.equal(rescanned.tag, created.tag);
      assert.equal(rescanned.include_link_check, true);
      await waitForScan(rescanned.id);
      assert.equal((await call("list_scan_issues", { scan_id: rescanned.id, limit: 100 })).issues.find((group) => group.rule_id === "label").is_false_positive, true);
      const rescannedCompanion = await call("get_scan_link_check", { scan_id: rescanned.id });
      track("checks", rescannedCompanion.check);
      await waitForLinkCheck(json, baseUrl, rescannedCompanion.check.id);
      if (sdk === "v1" && restartBackend) {
        await restartBackend();
        assert.equal((await call("rescan_scan", rescanArgs)).scan.id, rescanned.id, "Durable idempotency survives backend restart");
      }
      assert.equal(actionData("rescan_scan", await readMcpTool(peer, "rescan_scan", rescanArgs)).scan.id, rescanned.id);
      await call("mark_issue_false_positive", { ...triageArgs, false_positive: false });
      assert.equal((await call("list_scan_issues", { scan_id: rescanned.id, limit: 100 })).issues.find((group) => group.rule_id === "label").is_false_positive, true, "Child triage is independent of source changes");
      evidence.push({ name: phase, status: "passed", rescanId: rescanned.id, newCompanionId: rescannedCompanion.check.id, restartReplay: sdk === "v1" && Boolean(restartBackend) });

      setPhase(`${sdk}: standalone link-check cancel, recheck and export`);
      const cancelled = track("checks", (await call("create_link_check", { url: `${fixtureOrigin}/links/cancel`, check_type: "single", request_id: randomUUID() })).check);
      await waitForLinkCheck(json, baseUrl, cancelled.id, ["running"]);
      await call("cancel_link_check", { check_id: cancelled.id });
      await waitForLinkCheck(json, baseUrl, cancelled.id, ["cancelled"]);
      const cancelledSaved = await call("get_link_check", { check_id: cancelled.id });
      assert.equal(cancelledSaved.check.status, "cancelled");
      const recheckArgs = { check_id: companion.check.id, request_id: randomUUID() };
      const rechecked = track("checks", (await call("recheck_link_check", recheckArgs)).check);
      assert.notEqual(rechecked.id, companion.check.id);
      assert.equal(rechecked.scan_id, null, "A recheck preserves the old saved result and creates a detached new check");
      assert.equal(actionData("recheck_link_check", await readMcpTool(peer, "recheck_link_check", recheckArgs)).check.id, rechecked.id);
      await waitForLinkCheck(json, baseUrl, rechecked.id);
      assert.equal((await call("get_scan_link_check", { scan_id: created.id })).check.id, companion.check.id);
      const savedRecheckResults = await call("list_link_check_results", { check_id: rechecked.id, limit: 100 });
      const missingTarget = savedRecheckResults.results.find((item) => item.status === "broken" && item.status_code === 404 && new URL(item.target_url).pathname === "/links/missing");
      assert.ok(missingTarget, "The recheck has a real saved broken destination to verify in the dashboard");
      const [renderedTargets] = await Promise.all([
        page.waitForResponse((response) => new URL(response.url()).pathname === `/api/link-checks/${rechecked.id}/results` && response.request().method() === "GET"),
        navigate(`/links/${rechecked.id}`, "Link check details"),
      ]);
      assert.equal(renderedTargets.status(), 200, "The actual link-details UI successfully fetches its saved results");
      const destination = page.getByTitle(missingTarget.target_url, { exact: true });
      await destination.waitFor({ state: "visible" });
      assert.equal(await destination.innerText(), missingTarget.target_url, "The loaded destination row displays the saved MCP URL exactly");
      const brokenRow = page.locator('section[aria-labelledby="link-target-title"] article').filter({ has: destination });
      await brokenRow.getByText("HTTP 404", { exact: true }).waitFor({ state: "visible" });
      await brokenRow.getByText("Broken", { exact: true }).waitFor({ state: "visible" });
      await brokenRow.getByText("Destination not found", { exact: true }).waitFor({ state: "visible" });
      await page.screenshot({ path: path.join(outputDir, `full-mcp-${sdk}-links.png`), fullPage: true });
      evidence.push({ name: phase, status: "passed", cancelledCheckId: cancelled.id, newRecheckId: rechecked.id, originalCompanionPreserved: true });

      setPhase(`${sdk}: strict argument validation and live permission revocation`);
      const missing = randomUUID();
      const invalid = [
        ["create_scan", { ...createArgs, request_id: randomUUID(), unexpected: true }], ["create_scan", { ...createArgs, request_id: "invalid" }], ["create_scan", { ...createArgs, request_id: randomUUID(), scan_type: "invalid" }],
        ["rescan_scan", { scan_id: created.id }], ["rescan_scan", { scan_id: missing, request_id: randomUUID() }],
        ["mark_issue_false_positive", { ...triageArgs, issue_id: missing }], ["mark_issue_false_positive", { ...triageArgs, false_positive: "true" }],
        ["delete_scan", { scan_id: created.id }], ["delete_scan", { scan_id: created.id, confirm: false }],
        ["delete_link_check", { check_id: rechecked.id }], ["delete_link_check", { check_id: rechecked.id, confirm: false }],
        ["create_link_check", { url: "javascript:alert(1)", request_id: randomUUID() }], ["create_link_check", { url: `${fixtureOrigin}/links/good`, max_pages: 501, request_id: randomUUID() }],
        ["get_report", { scan_id: created.id, format: "html" }], ["get_report", { scan_id: created.id, format: "llm", unexpected: true }],
        ["get_report", { scan_id: created.id, format: "csv", kind: "failed" }], ["get_report", { scan_id: created.id, format: "pdf", key: issueId }],
        ["get_report", { scan_id: created.id, format: "llm", issue_id: issueId, kind: "failed", key: issueId }],
        ["get_screenshot", { scan_id: created.id, filename: "../app_settings" }], ["get_screenshot", { scan_id: missing, filename: occurrence.screenshot_url.split("/").at(-1) }],
        ["get_link_check_export", { check_id: missing }],
      ];
      const beforeInvalid = await snapshot();
      for (const [name, args] of invalid) await toolError(client, name, args);
      assert.equal(await snapshot(), beforeInvalid, "Rejected tools do not partially change application records/settings");
      await json(`${baseUrl}/api/settings`, jsonOptions("PUT", { integrations: { mcpAllowWrites: false } }));
      const revoked = await snapshot();
      await toolError(client, "delete_scan", { scan_id: created.id, confirm: true }, /write access is disabled/i);
      await toolError(peer, "delete_link_check", { check_id: rechecked.id, confirm: true }, /write access is disabled/i);
      assert.equal(await snapshot(), revoked, "A cached full-mode client cannot mutate after live write revocation");
      assert.equal((await client.listTools()).tools.length, 17);
      assert.equal((await call("get_scan", { scan_id: created.id })).scan.id, created.id, "Read access remains available after write revocation");
      await json(`${baseUrl}/api/settings`, jsonOptions("PUT", { integrations: { mcpAllowWrites: true } }));
      evidence.push({ name: phase, status: "passed", invalidCalls: invalid.length, cachedClientsRecheckedLivePermission: true });

      setPhase(`${sdk}: confirmed delete and saved-evidence cleanup`);
      for (const id of [rescanned.id, slow.id, partial.id, created.id]) {
        await call("delete_scan", { scan_id: id, confirm: true });
        await request(`${baseUrl}/api/scans/${id}`, {}, 404);
        assert.equal(await verificationSql(`SELECT count(*) FROM issues WHERE scan_id='${id}'`), "0");
        assert.equal(await verificationSql(`SELECT count(*) FROM urls WHERE scan_id='${id}'`), "0");
      }
      await request(new URL(occurrence.screenshot_url, baseUrl), {}, 404);
      const createReplayAfterDelete = await call("create_scan", createArgs);
      assert.equal(createReplayAfterDelete.scan.id, created.id, "Replaying a completed action after deletion never creates a replacement record");
      await request(`${baseUrl}/api/scans/${created.id}`, {}, 404);
      for (const id of [cancelled.id, rechecked.id]) {
        await call("delete_link_check", { check_id: id, confirm: true });
        await request(`${baseUrl}/api/link-checks/${id}`, {}, 404);
        assert.equal(await verificationSql(`SELECT count(*) FROM link_check_results WHERE link_check_id='${id}'`), "0");
      }
      assert.ok(MCP_WRITE_TOOL_NAMES.every((name) => called.has(name)), "Each SDK generation really executes all twelve write tools");
      evidence.push({ name: phase, status: "passed", allWriteTools: [...MCP_WRITE_TOOL_NAMES], screenshotsRemoved: true, replayAfterDeletionDidNotRecreate: true, trace: connection.trace, protocol: sdk === "v2" ? { era: client.getProtocolEra(), version: client.getNegotiatedProtocolVersion() } : undefined });
    }
    if (options.verifyInstalledClients) {
      setPhase("installed Codex and OpenCode clients");
      const installed = await options.verifyInstalledClients({ baseUrl, fixtureOrigin, key, outputDir });
      evidence.push(installed);
      assertInstalledClientWorkflows(installed);
    }
    return { completedAt: new Date().toISOString(), endpoint: `${baseUrl}/mcp`, readTools: 17, fullTools: 29, evidence, createdFixtureIds: ids };
  } catch (error) {
    evidence.push({ name: phase, status: "failed", message: redact(error.message) });
    throw new Error(`Full MCP verification failed during ${phase}: ${redact(error.message)}`, { cause: error });
  } finally {
    for (const connection of clients) await connection.client.close().catch(() => {});
    await json(`${baseUrl}/api/settings`, jsonOptions("PUT", { reporting: previous.reporting, performance: previous.performance, integrations: { mcpEnabled: previous.integrations.mcpEnabled, mcpAllowWrites: previous.integrations.mcpAllowWrites } }));
    await writeFile(path.join(outputDir, "full-mcp-client-results.json"), JSON.stringify({ completedAt: new Date().toISOString(), phase, evidence, createdFixtureIds: ids }, null, 2));
  }
}
