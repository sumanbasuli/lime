import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { connectMcp, readMcpTool, MCP_TOOL_NAMES, verifyMcpReadClient } from "./verify-mcp.mjs";
import { verifyMcpBridge } from "./verify-mcp-bridge.mjs";
import { verifyLinkMcp } from "./verify-link-mcp.mjs";
import { handleLinkFixture, verifyLinkChecks, waitForLinkCheck } from "./verify-links.mjs";

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const baseUrl = arg("--base-url", "http://127.0.0.1:14000");
const apiUrl = arg("--api-url", "http://127.0.0.1:19080");
const fixturePort = Number(process.env.LIME_VERIFY_FIXTURE_PORT || 19090);
const fixtureOrigin = process.env.LIME_VERIFY_FIXTURE_ORIGIN || `http://host.docker.internal:${fixturePort}`;
const outputDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.artifacts/verification");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const exec = promisify(execFile);
const evidence = [];
const browserErrors = [];
let currentWorkflow = "startup";
const requests = new Map();
let retryAvailable = false;
let browser;
let page;
let mcpConnection;
let mcpV2Evidence;
let mcpBridgeEvidence;

function fixturePage(url) {
  // The embedded axe rules produce 17 failed and two manual-review groups on
  // this page. Keep exactly four unlabeled text inputs for occurrence paging.
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>LIME verification ${url}</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font:18px sans-serif;line-height:1.6;max-width:800px;margin:48px auto;padding:16px;color:#111;background:#fff}button,input,select{padding:12px;margin:12px;min-width:70px}img{width:80px;height:60px}.fixture-case{margin:20px 0;padding:12px;border:1px solid #ddd}</style></head><body><main>
<h1>LIME verification fixture</h1><p>Controlled test page with known accessibility failures.</p>
${Array.from({length:4},(_,index)=>`<input id="missing-label-${index}">`).join("")}
<button></button><img src="/pixel.svg"><p style="color:#eee">Low contrast text</p><a href="/good">Read another page</a>
<section class="fixture-case">
<h2></h2><h4>Skipped heading level</h4><a href="/unnamed"></a>
<select><option>Choose a course</option></select><input type="button" value="">
<ul><div>Invalid direct list child</div></ul><li>List item outside a list</li>
<div aria-florp="true">Invalid ARIA attribute</div><div aria-hidden="invalid">Invalid ARIA value</div><div role="madeup">Invalid ARIA role</div>
<div role="slider" tabindex="0" aria-label="Volume">Slider missing required value</div>
<p aria-label="Paragraph label">Prohibited ARIA label</p><div role="checkbox" aria-checked="false" tabindex="0"></div><div role="progressbar" aria-valuenow="50"></div>
<p style="background-image:linear-gradient(90deg,#fff,#000);color:#555">Text over gradient requires manual contrast review.</p>
</section></main></body></html>`;
}

const fixtureServer = createServer((request, response) => {
  const pathname = new URL(request.url, fixtureOrigin).pathname;
  requests.set(pathname, (requests.get(pathname) || 0) + 1);
  if (handleLinkFixture(request, response, { origin: fixtureOrigin, requests })) return;
  if (pathname === "/index.xml") {
    response.writeHead(200, { "Content-Type": "application/xml" });
    response.end(`<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${fixtureOrigin}/nested.xml</loc></sitemap><sitemap><loc>${fixtureOrigin}/nested.xml</loc></sitemap></sitemapindex>`);
  } else if (pathname === "/nested.xml") {
    response.writeHead(200, { "Content-Type": "application/xml" });
    response.end(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${[`${fixtureOrigin}/good`, `${fixtureOrigin}/good`, `${fixtureOrigin}/second`, `http://localhost:${fixturePort}/external`].map((url)=>`<url><loc>${url}</loc></url>`).join("")}</urlset>`);
  } else if (pathname.endsWith(".xml")) {
    const urls = pathname === "/partial.xml"
      ? ["/good", "/retry"]
      : Array.from({ length: 8 }, (_, index) => `/slow/${index}`);
    response.writeHead(200, { "Content-Type": "application/xml" });
    response.end(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((url) => `<url><loc>${fixtureOrigin}${url}</loc></url>`).join("")}</urlset>`);
  } else if (pathname === "/retry" && request.headers["user-agent"]?.includes("HeadlessChrome") && !retryAvailable) {
    // Profiler resolves eligibility with GET and a regular Chrome user agent. Let
    // that succeed, then fail only the headless Chromium navigation so this URL
    // remains in the scan and exercises retry instead of being filtered out.
    request.socket.destroy();
  } else if (pathname === "/pixel.svg") {
    response.writeHead(200, { "Content-Type": "image/svg+xml" });
    response.end('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="#ffed00"/></svg>');
  } else {
    const send = () => {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(fixturePage(pathname));
    };
    if (pathname.startsWith("/slow/")) setTimeout(send, 2500);
    else send();
  }
});

async function request(url, options = {}, expectedStatus = 200) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(120_000) });
  assert.equal(response.status, expectedStatus, `${options.method || "GET"} ${url}: ${await response.clone().text().then((text) => text.slice(0, 300))}`);
  return response;
}

async function json(url, options = {}, expectedStatus = 200) {
  return (await request(url, options, expectedStatus)).json();
}

const jsonOptions = (method, payload) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
const scanUrl = (id) => `${baseUrl}/api/scans/${id}`;

async function verificationSql(statement) {
  const { stdout } = await exec("docker", ["compose", "-p", "lime-verification", "-f", "docker-compose.docs.yml", "exec", "-T", "db", "psql", "-U", "lime", "-d", "lime_docs_db", "-Atc", statement], { cwd: repoRoot });
  return stdout.trim();
}

async function waitForScan(id, statuses = ["completed"], timeout = 180_000) {
  const deadline = Date.now() + timeout;
  let scan;
  while (Date.now() < deadline) {
    scan = await json(scanUrl(id));
    if (statuses.includes(scan.status)) return scan;
    assert.notEqual(scan.status, "failed", `Scan failed: ${JSON.stringify(scan)}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Scan timed out: ${JSON.stringify(scan)}`);
}

async function check(name, action) {
  currentWorkflow = name;
  console.log(`Checking ${name}...`);
  await action();
  evidence.push({ name, status: "passed" });
  console.log(`PASS ${name}`);
}

async function navigate(route, heading) {
  const response = await page.goto(baseUrl + route, { waitUntil: "domcontentloaded" });
  assert.equal(response?.status(), 200, route);
  if (heading) await page.getByRole("heading", { name: heading, exact: true }).waitFor();
  await page.locator('[data-nextjs-dialog], .vite-error-overlay').waitFor({ state: "hidden" });
}

async function createFromForm(target, type, preset, tag, includeLinkCheck = false) {
  await navigate("/scans/new", "New scan");
  await page.getByRole("button", { name: type === "single" ? "Single page" : "Sitemap", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(preset, "i") }).click();
  await page.getByLabel(type === "single" ? "Page URL" : "Sitemap URL", { exact: true }).fill(fixtureOrigin + target);
  await page.getByLabel(/Tag/).fill(tag);
  const includeLinks = page.getByLabel("Include link check", { exact: true });
  assert.equal(await includeLinks.isChecked(), false, "Accessibility scans keep link checks opt-in");
  if (includeLinkCheck) await includeLinks.check();
  const [response] = await Promise.all([
    page.waitForResponse((response) => response.url().endsWith("/api/scans") && response.request().method() === "POST"),
    page.getByRole("button", { name: "Start scan", exact: true }).click(),
  ]);
  assert.equal(response.status(), 201);
  const scan = await response.json();
  await page.waitForURL(`**/scans/${scan.id}`);
  assert.equal(scan.viewport_preset, preset.toLowerCase());
  const dimensions = { desktop: [1440, 900], laptop: [1280, 800], tablet: [768, 1024], mobile: [390, 844] }[scan.viewport_preset];
  assert.deepEqual([scan.viewport_width, scan.viewport_height], dimensions);
  assert.equal(scan.scan_type, type);
  assert.equal(scan.tag, tag);
  assert.equal(scan.include_link_check, includeLinkCheck);
  return scan;
}

async function imageReady(locator) {
  await locator.waitFor({ state: "visible" });
  await locator.scrollIntoViewIfNeeded();
  await page.waitForFunction((img) => img.complete && img.naturalWidth > 0, await locator.elementHandle(), { timeout: 15_000 });
}

async function displayedScore(id) {
  await navigate(`/scans/${id}`);
  return Number(await page.getByText("out of 100", { exact: true }).locator("..").locator("div").first().innerText());
}

async function download(button, extension) {
  const [file] = await Promise.all([
    page.waitForEvent("download", { timeout: 120_000 }),
    button.click(),
  ]);
  assert.match(file.suggestedFilename(), new RegExp(`\\.${extension}$`));
  const destination = path.join(outputDir, file.suggestedFilename());
  await file.saveAs(destination);
  const content = await readFile(destination);
  assert.ok(content.length > 100, `Empty ${extension} report`);
  if (extension === "pdf") assert.equal(content.subarray(0, 5).toString(), "%PDF-");
  return content;
}

async function rpc(method, params = {}, key, status = 200, endpoint = `${baseUrl}/mcp`) {
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" };
  if (key) headers.Authorization = `Bearer ${key}`;
  return json(endpoint, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }, status);
}

await mkdir(outputDir, { recursive: true });
await Promise.all(["failure.png", "results.json", "docker.log"].map((name) => rm(path.join(outputDir, name), { force: true })));
await new Promise((resolve, reject) => fixtureServer.once("error", reject).listen(fixturePort, "0.0.0.0", resolve));
try {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => browserErrors.push(`${currentWorkflow} | ${page.url()} | ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(`${currentWorkflow} | ${page.url()} | ${message.text()}`);
  });
  page.on("response", (response) => { if (response.status() >= 500) browserErrors.push(`${response.status()} ${response.url()}`); });

  await check("startup, stats, new-scan validation and documentation link", async () => {
    assert.equal((await json(`${baseUrl}/api/health`)).status, "ok");
    assert.deepEqual(await json(`${baseUrl}/_lime/update-check`), { enabled: false }, "Disabled release checks remain reachable without contacting GitHub");
    const stats = await json(`${baseUrl}/api/stats`);
    assert.equal(stats.total_scans, 0, "Use only the isolated verification stack");
    await navigate("/", "Overview");
    assert.equal(await page.getByRole("link", { name: "Documentation", exact: true }).getAttribute("href"), "https://lime.heysuman.com/docs/");
    await navigate("/scans/new", "New scan");
    await page.getByRole("button", { name: "Start scan", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Please enter a sitemap URL" }).waitFor();
    await json(`${baseUrl}/api/scans`, jsonOptions("POST", { sitemap_url: "invalid", scan_type: "single" }), 400);
    for (const payload of [
      { sitemap_url: fixtureOrigin + "/good", scan_type: "invalid" },
      { sitemap_url: fixtureOrigin + "/good", scan_type: "single", viewport_preset: "invalid" },
    ]) await json(`${baseUrl}/api/scans`, jsonOptions("POST", payload), 400);
  });

  await check("update notice preference, release link and persisted dismissal", async () => {
    const latest = "v9.9.9-verification";
    const releaseUrl = `${fixtureOrigin}/release`;
    await page.route("**/_lime/update-check", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ enabled: true, current: "1.0.5", latest, url: releaseUrl, outdated: true }),
    }));
    try {
      await navigate("/settings", "Settings");
      const notice = page.getByText("Update available", { exact: true });
      await notice.waitFor();
      assert.equal(await page.getByRole("link", { name: "View release", exact: true }).getAttribute("href"), releaseUrl);
      const preference = page.getByLabel(/^Update notice/);
      assert.equal(await preference.isChecked(), true, "A fresh browser defaults to showing update notices");
      assert.equal(await page.evaluate(() => localStorage.getItem("lime.updateNotice.enabled")), null, "No preference is needed to show a new update card");
      await preference.locator("..").click();
      await notice.waitFor({ state: "hidden" });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction((input) => !input.checked, await preference.elementHandle());
      assert.equal(await preference.isChecked(), false);
      assert.equal(await page.evaluate(() => localStorage.getItem("lime.updateNotice.enabled")), "false");
      await preference.locator("..").click();
      await notice.waitFor();
      await page.getByRole("button", { name: "Dismiss update notice", exact: true }).click();
      await notice.waitFor({ state: "hidden" });
      assert.equal(await page.evaluate(() => localStorage.getItem("lime.updateNotice.dismissed")), latest);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
      assert.equal(await page.evaluate(() => localStorage.getItem("lime.updateNotice.dismissed")), latest);
      assert.equal(await notice.isVisible(), false, "Dismissal persists for the mocked release");
    } finally {
      await page.unroute("**/_lime/update-check");
      await page.evaluate(() => {
        localStorage.removeItem("lime.updateNotice.enabled");
        localStorage.removeItem("lime.updateNotice.dismissed");
      });
    }
  });

  let single;
  await check("single-page scan with mobile viewport, tag and persisted issue evidence", async () => {
    single = await createFromForm("/good", "single", "Mobile", "verification-single");
    const completed = await waitForScan(single.id);
    assert.equal(completed.total_urls, 1);
    assert.equal(completed.scanned_urls, 1);
    assert.equal(completed.viewport_width, 390);
    assert.equal(completed.viewport_height, 844);
    const issues = await json(`${scanUrl(single.id)}/issues`);
    assert.ok(issues.some((item) => item.issue.violation_type === "label"));
    assert.ok(issues.some((item) => item.occurrences.some((occurrence) => occurrence.element_screenshot_path && occurrence.html_snippet)));
    await navigate(`/scans/${single.id}`);
    for (const name of ["Failed", "Passed", "Needs review", "All checks"]) {
      await page.getByRole("button", { name, exact: true }).click();
      assert.equal(await page.getByRole("button", { name, exact: true }).getAttribute("aria-pressed"), "true");
    }
  });

  await check("scan search and tag filters", async () => {
    await navigate("/");
    await page.getByRole("searchbox", { name: "Search scans" }).fill("verification-single");
    await page.getByRole("searchbox", { name: "Search scans" }).press("Enter");
    await page.waitForURL("**/scans?q=verification-single");
    await page.locator(`a[href="/scans/${single.id}"]`).first().waitFor();
    await navigate("/scans?tag=verification-single");
    assert.equal(await page.locator("tbody tr").count(), 1);
  });

  let paused;
  await check("sitemap scan, cooperative pause, resume and persisted coverage", async () => {
    paused = await createFromForm("/sitemap.xml", "sitemap", "Desktop", "verification-pause", true);
    await waitForScan(paused.id, ["scanning"]);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    const state = await waitForScan(paused.id, ["paused"]);
    assert.equal(state.total_urls, 8);
    assert.ok(state.scanned_urls < state.total_urls, "Fixture must pause before completion");
    assert.equal(await verificationSql(`SELECT count(*) FROM urls WHERE scan_id='${paused.id}' AND status='failed'`), "0", "Pause cancellation leaves unfinished healthy pages pending, not failed");
    const pausedLinks = await json(`${scanUrl(paused.id)}/link-check`);
    assert.equal(pausedLinks.status, "queued", "A scan companion waits for accessibility completion");
    const recovery = await createFromForm("/sitemap.xml", "sitemap", "Tablet", "verification-recovery", true);
    const recoveryLinks = await json(`${scanUrl(recovery.id)}/link-check`);
    await waitForScan(recovery.id, ["scanning"]);
    await navigate("/scans/new", "New scan");
    await exec("docker", ["compose", "-p", "lime-verification", "-f", "docker-compose.docs.yml", "restart", "shopkeeper"], { cwd: repoRoot });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (await fetch(`${apiUrl}/api/health`).then((response) => response.ok).catch(() => false)) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.equal((await waitForScan(paused.id, ["paused"])).scanned_urls, state.scanned_urls);
    assert.equal((await json(`${scanUrl(paused.id)}/link-check`)).status, "queued", "Restart must not run a paused scan's companion");
    assert.equal((await waitForScan(recovery.id)).scanned_urls, 8);
    await waitForLinkCheck(json, baseUrl, recoveryLinks.id);
    await navigate(`/scans/${paused.id}`);
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    const completed = await waitForScan(paused.id);
    assert.equal(completed.total_urls, 8);
    assert.equal(completed.scanned_urls, 8);
    assert.equal(await verificationSql(`SELECT count(*) FROM urls WHERE scan_id='${paused.id}' AND status='completed'`), "8", "Resume audits every healthy page, not only counts attempted pages");
    const completedLinks = await waitForLinkCheck(json, baseUrl, pausedLinks.id);
    assert.equal(completedLinks.pages_checked, 8, "The companion checks the same persisted scan page set after resume");
  });

  await check("nested sitemap discovery, duplicate removal and off-host filtering", async () => {
    const scan = await createFromForm("/index.xml", "sitemap", "Desktop", "verification-index");
    const completed = await waitForScan(scan.id);
    assert.equal(completed.total_urls, 2);
    assert.equal(completed.scanned_urls, 2);
  });

  let partial;
  await check("failed-page retry preserves scan ID and completed page results", async () => {
    partial = await createFromForm("/partial.xml", "sitemap", "Laptop", "verification-retry");
    const completed = await waitForScan(partial.id);
    assert.equal(completed.total_urls, 2);
    await navigate(`/scans/${partial.id}`);
    await page.getByText("Partial scan recovery", { exact: true }).waitFor();
    const goodRequests = requests.get("/good");
    retryAvailable = true;
    const [response] = await Promise.all([
      page.waitForResponse((response) => response.url().endsWith("/retry-failed")),
      page.getByRole("button", { name: "Retry failed pages", exact: true }).click(),
    ]);
    const retry = await response.json();
    assert.equal(retry.scan.id, partial.id);
    assert.equal(retry.retried_url_count, 1);
    assert.equal((await waitForScan(partial.id)).scanned_urls, 2);
    assert.equal(requests.get("/good"), goodRequests, "Already completed page must not be rescanned");
    await navigate(`/scans/${partial.id}`);
    await page.getByText("Partial scan recovery", { exact: true }).waitFor({ state: "hidden" });
  });

  let issue;
  await check("chunked issues, formatted HTML, spotlight thumbnail and expanded screenshot", async () => {
    const chunks = await json(`${scanUrl(single.id)}/issues/chunks?limit=1`);
    assert.equal(chunks.items.length, 1);
    const nextChunk = await json(`${scanUrl(single.id)}/issues/chunks?offset=1&limit=1`);
    assert.equal(nextChunk.items.length, 1);
    assert.notDeepEqual(nextChunk.items[0], chunks.items[0]);
    const all = await json(`${scanUrl(single.id)}/issues`);
    issue = all.find((item) => item.issue.violation_type === "label").issue;
    await navigate(`/scans/${single.id}/issues`, "Issue details");
    const card = page.locator("[data-issue-card]").filter({ hasText: "Form elements must have labels" }).first();
    await card.locator(".issue-card-trigger").click();
    await card.getByText("Affected elements", { exact: true }).waitFor();
    await card.locator("pre code").first().waitFor();
    const thumbnail = card.locator('img[alt^="Screenshot of "]').first();
    await imageReady(thumbnail);
    const previewSrc = await thumbnail.getAttribute("src");
    assert.match(previewSrc, /_preview\.png$/, "Thumbnail uses the focused preview");
    const preview = await thumbnail.evaluate((img) => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const context = canvas.getContext("2d");
      context.drawImage(img, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let yellowPixels = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index] > 180 && pixels[index + 1] > 140 && pixels[index + 2] < 80) yellowPixels += 1;
      }
      return { height: img.naturalHeight, yellowPixels };
    });
    assert.ok(preview.yellowPixels > 10, "Focused thumbnail retains yellow spotlight highlight");
    await thumbnail.locator("..").click();
    const dialog = page.getByRole("dialog");
    await imageReady(dialog.locator("img"));
    const fullSrc = await dialog.locator("img").getAttribute("src");
    assert.equal(fullSrc, previewSrc.replace("_preview.png", ".png"), "Expanded image retains the full spotlight capture");
    assert.ok(await dialog.locator("img").evaluate((img) => img.naturalHeight) > preview.height, "Expanded capture contains full page context");
    await page.screenshot({ path: path.join(outputDir, "screenshot-lightbox.png") });
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
  });

  await check("UI issue-group pagination, needs-review details and scoped CSV", async () => {
    const initial = await json(`${scanUrl(single.id)}/issues/chunks`);
    const all = await json(`${scanUrl(single.id)}/issues/chunks?limit=50`);
    assert.ok(all.counts.totalIssueCardCount > initial.items.length, "Fixture exceeds the first issue-group page");
    assert.equal(all.items.length, all.counts.totalIssueCardCount);
    // Existing grouping prioritizes failed rules over incomplete outcomes for
    // the same rule. Use the ARIA review-only rule, not mixed color contrast.
    const review = all.items.find((item) => item.kind === "needs_review" && item.ruleId === "aria-prohibited-attr");
    assert.ok(review, "Fixture creates a review-only ARIA group");
    assert.ok(review.occurrenceCount > 0);
    await navigate(`/scans/${single.id}/issues`, "Issue details");
    assert.equal(await page.locator(".issue-card-trigger").count(), initial.items.length);
    const [nextPage] = await Promise.all([
      page.waitForResponse((response) => response.url().includes(`/scans/${single.id}/issues/chunks?`) && response.request().method() === "GET"),
      page.getByRole("button", { name: "Load more issues", exact: true }).click(),
    ]);
    assert.equal(nextPage.status(), 200);
    await page.getByText(`All ${all.counts.totalIssueCardCount} issue groups are loaded.`, { exact: true }).waitFor();
    assert.equal(await page.locator(".issue-card-trigger").count(), all.counts.totalIssueCardCount);
    await page.getByRole("button", { name: "Load more issues", exact: true }).waitFor({ state: "hidden" });
    const cardIds = await page.locator(".issue-card-trigger").evaluateAll((triggers) => triggers.map((trigger) => trigger.closest("section").id));
    assert.equal(new Set(cardIds).size, cardIds.length, "Failed and review issue groups have unique anchors");

    const card = page.locator(`[id="rule-${review.ruleId}"]`);
    await card.getByText("Needs review", { exact: true }).waitFor();
    await card.locator(".issue-card-trigger").click();
    await card.getByText("Affected elements", { exact: true }).waitFor();
    await card.locator("pre code").first().waitFor();
    assert.equal(await card.getByRole("button", { name: "Mark false positive", exact: true }).count(), 0);
    await card.getByRole("button", { name: `Download reports for ${review.title}`, exact: true }).click();
    const scopedCsv = await download(page.getByRole("menuitem", { name: /Download CSV/ }), "csv");
    const text = scopedCsv.toString();
    assert.match(text, /^item_type,rule_id,/);
    assert.match(text, new RegExp(`^needs_review,${review.ruleId},`, "m"));
    assert.doesNotMatch(text, /^failed,/m, "Manual-review export excludes failed groups");
    assert.equal(text.split(/\r?\n/).filter((line) => line.startsWith("needs_review,")).length, review.occurrenceCount);
  });

  await check("occurrence pagination and issue-detail error recovery", async () => {
    await navigate(`/scans/${paused.id}/issues`);
    const card = page.locator("[data-issue-card]").filter({ hasText: "Form elements must have labels" }).first();
    await card.locator(".issue-card-trigger").click();
    await card.getByText("Affected elements", { exact: true }).waitFor();
    const initialImages = await card.locator('img[alt^="Screenshot of "]').count();
    assert.equal(initialImages, 25);
    await card.getByRole("button", { name: /load more occurrences/i }).click();
    await page.waitForFunction(() => document.querySelectorAll('img[alt^="Screenshot of "]').length === 32);
    const detail = await json(`${scanUrl(paused.id)}/issues/details?kind=failed&key=${(await json(`${scanUrl(paused.id)}/issues`)).find((entry) => entry.issue.violation_type === "label").issue.id}&occurrenceLimit=1`);
    assert.equal(detail.detail.occurrences.length, 1);
    const defaultDetail = await json(`${scanUrl(paused.id)}/issues/details?kind=failed&key=${detail.summary.issueId}`);
    assert.equal(defaultDetail.detail.occurrences.length, 25, "Omitted detail limit uses default page size");
    assert.equal(defaultDetail.detail.occurrenceOffset, 0);
    const probe = await browser.newPage();
    let interceptedDetails = 0;
    try {
      await probe.route("**/issues/details?**", (route) => {
        interceptedDetails += 1;
        return route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"Temporary verification failure"}' });
      });
      // This fresh, settled-scan probe must be interactive before injecting the
      // error. Progress routes elsewhere use rendered controls, not networkidle.
      await probe.goto(`${baseUrl}/scans/${single.id}/issues`, { waitUntil: "networkidle" });
      const [injected] = await Promise.all([
        probe.waitForResponse((response) => response.url().includes("/issues/details?") && response.status() === 503),
        probe.locator(".issue-card-trigger").first().click(),
      ]);
      assert.equal(injected.status(), 503);
      assert.ok(interceptedDetails > 0, "The intended issue-detail request was intercepted");
      await probe.getByText("Temporary verification failure", { exact: true }).waitFor();
      await probe.unroute("**/issues/details?**");
      await probe.getByRole("button", { name: "Retry loading details", exact: true }).click();
      await probe.getByText("Affected elements", { exact: true }).waitFor();
    } catch (error) {
      await probe.screenshot({ path: path.join(outputDir, "issue-retry-probe-failure.png"), fullPage: true });
      throw new Error(`Issue retry probe failed (${interceptedDetails} injected requests, expanded=${await probe.locator(".issue-card-trigger").first().getAttribute("aria-expanded")}): ${error.message}`, { cause: error });
    } finally { await probe.close(); }
    await navigate(`/scans/${single.id}/issues`);
  });

  await check("false-positive triage persistence and restored score/report state", async () => {
    const baseline = await json(`${scanUrl(single.id)}/issues/chunks`);
    assert.equal(baseline.items.length, 12, "Omitted group limit uses default page size");
    const baselineScore = await displayedScore(single.id);
    assert.ok(Number.isFinite(baselineScore));
    await navigate(`/scans/${single.id}/issues`);
    const card = page.locator("[data-issue-card]").filter({ hasText: "Form elements must have labels" }).first();
    const [marked] = await Promise.all([
      page.waitForResponse((response) => response.url().endsWith("/false-positive") && response.request().method() === "POST"),
      card.getByRole("button", { name: "Mark false positive", exact: true }).click(),
    ]);
    assert.equal(marked.status(), 200);
    assert.equal((await json(`${scanUrl(single.id)}/issues`)).find((item) => item.issue.id === issue.id).issue.is_false_positive, true);
    const concurrentReads = await Promise.all(Array.from({ length: 6 }, () => json(`${scanUrl(single.id)}/issues/chunks`)));
    const excluded = concurrentReads[0];
    assert.equal(excluded.counts.activeIssueCount, baseline.counts.activeIssueCount - 1);
    assert.equal(excluded.counts.excludedIssueCount, baseline.counts.excludedIssueCount + 1);
    for (const read of concurrentReads) {
      assert.deepEqual(read.counts, excluded.counts, "Concurrent issue reads preserve the triage state without cache rebuild errors");
    }
    await page.getByRole("button", { name: "Load more issues", exact: true }).click();
    await page.getByText(`All ${excluded.counts.totalIssueCardCount} issue groups are loaded.`, { exact: true }).waitFor();
    const expectedGroups = await json(`${scanUrl(single.id)}/issues/chunks?limit=50`);
    const expectedIds = expectedGroups.items.map((item) => `rule-${item.kind === "failed" ? item.violationType : item.ruleId}`).sort();
    const loadedIds = await page.locator(".issue-card-trigger").evaluateAll((triggers) => triggers.map((trigger) => trigger.closest("section").id).sort());
    assert.deepEqual(loadedIds, expectedIds, "Triage followed by pagination loads every group without skipping or duplicating one");
    assert.ok(await displayedScore(single.id) > baselineScore, "Excluded scored issue improves score");
    const excludedCsv = await (await request(`${scanUrl(single.id)}/issues/report.csv?mode=full`)).text();
    assert.doesNotMatch(excludedCsv, /^failed,label,/m, "False positive excluded from full CSV");
    await navigate(`/scans/${single.id}/issues`);
    await page.reload({ waitUntil: "domcontentloaded" });
    // Excluded groups are sorted after active/review groups, beyond page one.
    await page.getByRole("button", { name: "Load more issues", exact: true }).click();
    await page.getByText(`All ${baseline.counts.totalIssueCardCount} issue groups are loaded.`, { exact: true }).waitFor();
    const [unmarked] = await Promise.all([
      page.waitForResponse((response) => response.url().endsWith("/false-positive") && response.request().method() === "DELETE"),
      card.getByRole("button", { name: "Unmark false positive", exact: true }).click(),
    ]);
    assert.equal(unmarked.status(), 200);
    assert.equal((await json(`${scanUrl(single.id)}/issues`)).find((item) => item.issue.id === issue.id).issue.is_false_positive, false);
    assert.deepEqual((await json(`${scanUrl(single.id)}/issues/chunks`)).counts, baseline.counts);
    assert.equal(await displayedScore(single.id), baselineScore, "Unmark restores score");
    assert.match(await (await request(`${scanUrl(single.id)}/issues/report.csv?mode=full`)).text(), /^failed,label,/m);
  });

  await check("full/scoped PDF, CSV and LLM downloads", async () => {
    const reportPage = await browser.newPage();
    try {
      assert.equal((await reportPage.goto(`${baseUrl}/reports/scans/${single.id}/issues`, { waitUntil: "domcontentloaded" })).status(), 200);
      await reportPage.locator('[data-report-ready="true"]').waitFor();
      await reportPage.emulateMedia({ media: "print" });
      assert.equal(await reportPage.getByRole("link", { name: "Skip to content", exact: true }).isVisible(), false, "Dashboard controls excluded from printed reports");
      assert.ok((await reportPage.locator("main").innerText()).includes("Form elements must have labels"));
    } finally { await reportPage.close(); }
    await navigate(`/scans/${single.id}/issues`, "Issue details");
    const text = await download(page.getByRole("button", { name: "Download LLM report", exact: true }), "txt");
    assert.match(text.toString(), /label/);
    await download(page.getByRole("button", { name: "Download PDF report", exact: true }), "pdf");
    await page.getByRole("button", { name: "Download CSV report", exact: true }).click();
    await download(page.getByRole("menuitem", { name: /Download small report/i }), "csv");
    await page.getByRole("button", { name: "Download CSV report", exact: true }).click();
    await download(page.getByRole("menuitem", { name: /Download full report/i }), "csv");
    const card = page.locator("[data-issue-card]").filter({ hasText: "Form elements must have labels" }).first();
    for (const [name, extension] of [["CSV", "csv"], ["LLM", "txt"], ["PDF", "pdf"]]) {
      await card.getByRole("button", { name: /^Download reports for/ }).click();
      await download(page.getByRole("menuitem", { name: new RegExp(`^Download ${name}`) }), extension);
    }
  });

  await check("settings save, reload and report enable gates", async () => {
    await navigate("/settings", "Settings");
    const field = page.getByLabel(/^Small CSV sample size/);
    await field.fill("2");
    const concurrency = page.getByLabel(/^Report concurrency/);
    await concurrency.fill("3");
    await page.getByRole("button", { name: "Save settings", exact: true }).click();
    await page.getByText(/Settings saved/i).waitFor();
    await page.reload({ waitUntil: "domcontentloaded" });
    assert.equal(await field.inputValue(), "2");
    assert.equal(await concurrency.inputValue(), "3");
    const settings = await json(`${baseUrl}/api/settings`);
    assert.equal(settings.reporting.smallCsvOccurrenceLimit, 2);
    assert.equal(settings.performance.reportGenerationConcurrency, 3);
    const sampleCsv = await (await request(`${scanUrl(single.id)}/issues/report.csv?mode=small`)).text();
    assert.equal([...sampleCsv.matchAll(/^failed,label,/gm)].length, 2, "Saved sample size affects CSV output");
    for (const label of ["Enable PDF generation", "Enable CSV generation", "Enable LLM export"]) {
      await page.getByLabel(new RegExp(`^${label}`)).locator("..").click();
    }
    await page.getByRole("button", { name: "Save settings", exact: true }).click();
    await page.getByText(/Settings saved/i).waitFor();
    for (const extension of ["csv", "llm.txt", "pdf"]) await request(`${scanUrl(single.id)}/issues/report.${extension}`, {}, 403);
    await navigate(`/scans/${single.id}/issues`);
    assert.equal(await page.getByRole("button", { name: /^Download (CSV|PDF|LLM) report$/ }).count(), 0);
    await json(`${baseUrl}/api/settings`, jsonOptions("PUT", { reporting: settings.reporting }));
  });

  let mcpKey;
  let mcpScan;
  await check("MCP settings, client setup, one-time key and draft preservation", async () => {
    await rpc("initialize", {}, undefined, 401);
    await navigate("/settings", "Settings");
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    assert.equal(await page.getByRole("link", { name: "MCP setup guide" }).getAttribute("href"), "https://lime.heysuman.com/docs/user/mcp/");
    await page.getByRole("button", { name: "Copy MCP endpoint", exact: true }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `${baseUrl}/mcp`);
    await page.getByRole("button", { name: "Copy HTTP connection details", exact: true }).click();
    const httpDetails = await page.evaluate(() => navigator.clipboard.readText());
    assert.ok(httpDetails.includes(`${baseUrl}/mcp`));
    assert.ok(httpDetails.includes("Authorization: Bearer <YOUR_MCP_KEY>"));
    await page.getByRole("button", { name: "Copy Codex config", exact: true }).click();
    const config = await page.evaluate(() => navigator.clipboard.readText());
    assert.ok(config.includes(`url = "${baseUrl}/mcp"`));
    assert.ok(config.includes('bearer_token_env_var = "LIME_MCP_KEY"'));
    const saved = await json(`${baseUrl}/api/settings`);
    const draftCap = saved.reporting.fullPdfOccurrenceLimit + 1;
    await page.getByLabel(/^Full PDF occurrence cap/).fill(String(draftCap));
    await page.getByLabel(/^Report concurrency/).fill("4");
    const [generated] = await Promise.all([
      page.waitForResponse((response) => response.url().endsWith("/api/settings") && response.request().method() === "POST"),
      page.getByRole("button", { name: "Generate MCP key", exact: true }).click(),
    ]);
    assert.equal(generated.status(), 200);
    const result = await generated.json();
    mcpKey = result.mcpKey;
    assert.ok(mcpKey, "Generated MCP key response");
    await page.getByText("New MCP key", { exact: true }).waitFor();
    assert.ok((await page.locator("code").last().innerText()) === mcpKey);
    await page.getByRole("button", { name: "Copy MCP key", exact: true }).click();
    assert.ok((await page.evaluate(() => navigator.clipboard.readText())) === mcpKey, "Raw key can be copied once");
    assert.equal(await page.getByLabel(/^Full PDF occurrence cap/).inputValue(), String(draftCap));
    assert.equal(await page.getByLabel(/^Report concurrency/).inputValue(), "4");
    assert.equal((await json(`${baseUrl}/api/settings`)).reporting.fullPdfOccurrenceLimit, saved.reporting.fullPdfOccurrenceLimit, "Key generation does not save reporting drafts");
    assert.equal(result.settings.integrations.mcpEnabled, true, "Generation enables MCP immediately");
    assert.equal(await verificationSql("SELECT length(mcp_key_hash) FROM app_settings WHERE key='global'"), "64", "Only a SHA256 key hash is stored");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Rotate MCP key", exact: true }).waitFor();
    assert.equal(await page.getByText("New MCP key", { exact: true }).count(), 0, "Raw key is not shown after reload");
    assert.ok(!(await (await request(`${baseUrl}/api/settings`)).text()).includes(mcpKey), "Settings never expose the raw key");
    mcpConnection = await connectMcp(`${baseUrl}/mcp`, mcpKey);
    const version = await json(`${baseUrl}/api/version`);
    assert.equal(mcpConnection.client.getServerVersion().version, version.version);
    await mcpConnection.client.ping();
    assert.equal(mcpConnection.transport.sessionId, undefined, "Stateless JSON transport does not issue session IDs");
    assert.ok(mcpConnection.trace.some((entry) => entry.rpcMethod === "initialize" && entry.status === 200));
    assert.ok(mcpConnection.trace.some((entry) => entry.rpcMethod === "notifications/initialized" && entry.status === 202 && entry.protocol === "2025-11-25"));
    const tools = (await mcpConnection.client.listTools()).tools;
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [...MCP_TOOL_NAMES].sort());
    for (const tool of tools) {
      assert.equal(tool.annotations.readOnlyHint, true);
      assert.equal(tool.annotations.destructiveHint, false);
      if (tool.inputSchema.properties.scan_id) assert.ok(tool.inputSchema.required.includes("scan_id"));
    }
  });

  await check("MCP SDK cold scores, pagination, triage freshness and usable reports", async () => {
    const client = mcpConnection.client;
    mcpScan = await json(`${apiUrl}/api/scans`, jsonOptions("POST", { sitemap_url: fixtureOrigin + "/good", scan_type: "single", tag: "mcp-cold-cache" }), 201);
    await waitForScan(mcpScan.id);
    assert.equal(await verificationSql(`SELECT count(*) FROM scan_score_summary_cache WHERE scan_id='${mcpScan.id}'`), "0", "MCP-only fixture has never been opened in the dashboard");
    const directCold = await rpc("tools/call", { name: "get_scan", arguments: { scan_id: mcpScan.id } }, mcpKey, 200, `${apiUrl}/mcp`);
    assert.equal(directCold.result.structuredContent.score_summary, null, "Direct Shopkeeper accurately reports a cold score cache");
    const cold = await readMcpTool(client, "get_scan", { scan_id: mcpScan.id });
    assert.equal(cold.scan.id, mcpScan.id);
    assert.equal(cold.progress.percent, 100);
    assert.equal(cold.score_summary.has_score, true, "Canonical MCP computes score without dashboard navigation");
    assert.equal(cold.score_summary.completed_url_count, 1);
    assert.equal(cold.score_summary.score, await displayedScore(mcpScan.id));
    await navigate("/settings", "Settings");
    const scans = await readMcpTool(client, "list_scans", { limit: 2, offset: 0 });
    assert.equal(scans.scans.length, 2);
    const secondPage = await readMcpTool(client, "list_scans", { limit: 2, offset: 2 });
    assert.ok(!secondPage.scans.some((scan) => scans.scans.some((first) => first.id === scan.id)));
    const groups = [];
    let total;
    for (let offset = 0; total === undefined || offset < total; offset += 7) {
      const data = await readMcpTool(client, "list_scan_issues", { scan_id: mcpScan.id, limit: 7, offset });
      total = data.total;
      groups.push(...data.issues);
    }
    assert.equal(groups.length, total);
    assert.equal(new Set(groups.map((group) => `${group.kind}:${group.key}`)).size, total);
    const beyond = await readMcpTool(client, "list_scan_issues", { scan_id: mcpScan.id, offset: 100000 });
    assert.equal(beyond.issues.length, 0);
    assert.equal(beyond.total, total, "Empty final page retains the true group total");
    const labeled = groups.find((group) => group.rule_id === "label");
    assert.ok(labeled);
    const occurrences = await readMcpTool(client, "get_issue_detail", { scan_id: mcpScan.id, kind: labeled.kind, key: labeled.key, limit: 1 });
    assert.equal(occurrences.detail.occurrences.length, 1);
    assert.equal(occurrences.detail.has_more, true);
    const occurrence = occurrences.detail.occurrences[0];
    assert.ok(occurrence.html_snippet.includes("input"));
    assert.ok(occurrence.css_selector);
    for (const imagePath of [occurrence.screenshot_url, occurrence.element_screenshot_url]) {
      assert.ok(imagePath);
      assert.ok(imagePath.startsWith(`/api/screenshots/${mcpScan.id}/`));
      assert.match((await request(new URL(imagePath, baseUrl))).headers.get("content-type"), /image/);
    }
    const reviewGroup = groups.find((group) => group.kind === "needs_review");
    assert.ok(reviewGroup);
    await readMcpTool(client, "get_issue_detail", { scan_id: mcpScan.id, kind: reviewGroup.kind, key: reviewGroup.key, limit: 1 });
    const multiGroups = await readMcpTool(client, "list_scan_issues", { scan_id: paused.id });
    const multiLabel = multiGroups.issues.find((group) => group.rule_id === "label");
    const occurrenceIDs = [];
    for (let offset = 0; offset < 32; offset += 7) {
      const data = await readMcpTool(client, "get_issue_detail", { scan_id: paused.id, kind: multiLabel.kind, key: multiLabel.key, limit: 7, offset });
      assert.equal(data.detail.summary.occurrence_count, 32);
      assert.equal(data.detail.has_more, offset + data.detail.occurrences.length < 32);
      occurrenceIDs.push(...data.detail.occurrences.map((item) => item.id));
    }
    assert.equal(new Set(occurrenceIDs).size, 32, "Occurrence pagination does not skip or duplicate rows");
    const exhausted = await readMcpTool(client, "get_issue_detail", { scan_id: paused.id, kind: multiLabel.kind, key: multiLabel.key, offset: 100000 });
    assert.equal(exhausted.detail.occurrences.length, 0);
    assert.equal(exhausted.detail.has_more, false);
    await json(`${scanUrl(mcpScan.id)}/issues/${labeled.key}/false-positive`, { method: "POST" });
    const stale = await rpc("tools/call", { name: "get_scan", arguments: { scan_id: mcpScan.id } }, mcpKey, 200, `${apiUrl}/mcp`);
    assert.equal(stale.result.structuredContent.score_summary, null, "Direct endpoint never serves the stale triage score");
    const marked = await readMcpTool(client, "get_scan", { scan_id: mcpScan.id });
    assert.ok(marked.score_summary.score > cold.score_summary.score);
    // The existing dashboard scorer removes false-positive rules before
    // aggregation; its legacy excluded_count is not a triage counter.
    assert.equal(marked.score_summary.excluded_count, cold.score_summary.excluded_count);
    assert.equal(marked.score_summary.failed_count, cold.score_summary.failed_count - 1);
    assert.equal(marked.score_summary.scored_audit_count, cold.score_summary.scored_audit_count - 1);
    assert.equal(marked.score_summary.weighted_failed, cold.score_summary.weighted_failed - 10, "Label rule is removed from the existing weighted score");
    const markedGroups = await readMcpTool(client, "list_scan_issues", { scan_id: mcpScan.id });
    assert.equal(markedGroups.issues.find((group) => group.key === labeled.key).is_false_positive, true);
    await json(`${scanUrl(mcpScan.id)}/issues/${labeled.key}/false-positive`, { method: "DELETE" });
    assert.equal((await readMcpTool(client, "get_scan", { scan_id: mcpScan.id })).score_summary.score, cold.score_summary.score);
    // A targeted lookup must not be capped at the first 1,000 groups. Synthetic
    // read-only pagination rows exist only in the disposable verification DB.
    await verificationSql(`INSERT INTO issues (scan_id,violation_type,description,severity) SELECT '${mcpScan.id}', 'mcp-pagination-'||n, 'MCP pagination '||n, 'serious' FROM generate_series(1,1005) n`);
    try {
      const far = await readMcpTool(client, "list_scan_issues", { scan_id: mcpScan.id, limit: 5, offset: 1000 });
      assert.equal(far.total, total + 1005);
      assert.equal(far.issues.length, 5);
      for (const group of far.issues) {
        const data = await readMcpTool(client, "get_issue_detail", { scan_id: mcpScan.id, kind: group.kind, key: group.key });
        assert.equal(data.detail.summary.key, group.key);
      }
    } finally {
      await verificationSql(`DELETE FROM issues WHERE scan_id='${mcpScan.id}' AND violation_type LIKE 'mcp-pagination-%'`);
    }
    const metadata = await readMcpTool(client, "get_report_metadata", { scan_id: mcpScan.id });
    assert.deepEqual(metadata.availability, { pdf: true, csv: true, llm: true });
    for (const [format, reportPath] of Object.entries(metadata.reports)) {
      const report = await request(new URL(reportPath, baseUrl));
      const bytes = Buffer.from(await report.arrayBuffer());
      assert.ok(bytes.length > 100);
      if (format === "pdf") assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
      if (format === "csv") assert.match(bytes.toString(), /^item_type,rule_id,/);
      if (format === "llm") assert.ok(bytes.toString().includes("label"));
    }
    const settings = await json(`${baseUrl}/api/settings`);
    try {
      await json(`${baseUrl}/api/settings`, jsonOptions("PUT", { reporting: { pdfReportsEnabled: false, csvReportsEnabled: false, llmReportsEnabled: false } }));
      assert.deepEqual((await readMcpTool(client, "get_report_metadata", { scan_id: mcpScan.id })).availability, { pdf: false, csv: false, llm: false });
      for (const reportPath of Object.values(metadata.reports)) await request(new URL(reportPath, baseUrl), {}, 403);
    } finally {
      await json(`${baseUrl}/api/settings`, jsonOptions("PUT", { reporting: settings.reporting }));
    }
    const visible = await readMcpTool(client, "get_settings");
    assert.equal(visible.integrations.mcp_enabled, true);
    assert.ok(!JSON.stringify(visible).includes(mcpKey), "Read tools do not expose the bearer key");
    assert.ok(!JSON.stringify(visible).includes("mcp_key_hash"), "Read tools do not expose the hash");
    const smoke = await verifyMcpReadClient(`${baseUrl}/mcp`, mcpKey, mcpScan.id);
    assert.deepEqual([...smoke.checked].sort(), [...MCP_TOOL_NAMES].sort(), "The earlier pause/resume fixture already supplies saved companion results, so the smoke helper reads all twelve tools");
    mcpV2Evidence = await verifyMcpReadClient(`${baseUrl}/mcp`, mcpKey, mcpScan.id, { sdk: "v2" });
    assert.deepEqual([...mcpV2Evidence.checked].sort(), [...smoke.checked].sort(), "Both SDK generations exercise the same available data");
    assert.deepEqual(mcpV2Evidence.protocol, { era: "legacy", version: "2025-11-25" });
    mcpBridgeEvidence = await verifyMcpBridge(`${baseUrl}/mcp`, mcpKey, mcpScan.id);
    assert.deepEqual([...mcpBridgeEvidence.checked].sort(), [...smoke.checked].sort(), "Real stdio bridge reads all available saved-data tools");
  });

  await check("MCP protocol errors, read-only boundary, rotation and disable", async () => {
    const client = mcpConnection.client;
    for (const [name, args] of [
      ["get_scan", {}], ["get_scan", { scan_id: "invalid" }],
      ["list_scan_issues", { scan_id: single.id, limit: 1.5 }],
      ["list_scans", { limit: 101 }], ["list_scans", { offset: -1 }],
      ["get_issue_detail", { scan_id: single.id, kind: "invalid", key: issue.id }],
      ["get_scan", { scan_id: "00000000-0000-0000-0000-000000000000" }],
    ]) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true, `${name} rejects invalid arguments without DB errors`);
      assert.ok(result.content[0].text);
      assert.ok(!result.content[0].text.includes("SQLSTATE"));
    }
    for (const name of ["create_scan", "delete_scan", "save_settings", "mark_false_positive"]) {
      const data = await rpc("tools/call", { name, arguments: { scan_id: single.id } }, mcpKey);
      assert.equal(data.error.code, -32602, "MCP cannot invoke mutation tools");
    }
    const headers = { Authorization: `Bearer ${mcpKey}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" };
    for (const endpoint of [`${baseUrl}/mcp`, `${apiUrl}/mcp`]) {
      await request(endpoint, { headers }, 405);
      await request(endpoint, { method: "DELETE", headers }, 405);
      await request(endpoint, { method: "POST", headers: { ...headers, Origin: "https://untrusted.example" }, body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" }) }, 403);
      await request(endpoint, { method: "POST", headers: { ...headers, "MCP-Protocol-Version": "invalid" }, body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" }) }, 400);
      for (const body of ['{', '[]', '{"jsonrpc":"1.0","id":7,"method":"ping"}', '{"jsonrpc":"2.0","id":true,"method":"ping"}', '{"jsonrpc":"2.0","id":null,"method":"ping"}', '{"jsonrpc":"2.0","id":7,"method":"ping"}{}']) {
        const error = await json(endpoint, { method: "POST", headers, body }, 400);
        assert.ok(error.error.code < 0);
      }
      // Keep the JSON numeric spelling intact: JavaScript Number would round
      // these fractions/underflows before the server could validate them.
      for (const args of ['{"limit":1.0000000000000000001}', '{"limit":100.0000000000000000001}', '{"offset":1e-400}', '{"offset":1e-1000000000}']) {
        const rejected = await json(endpoint, { method: "POST", headers, body: `{"jsonrpc":"2.0","id":"exact-number","method":"tools/call","params":{"name":"list_scans","arguments":${args}}}` });
        assert.equal(rejected.result.isError, true, "Exact non-integer pagination must not reach a database read");
      }
      const nullArgs = await json(endpoint, { method: "POST", headers, body: '{"jsonrpc":"2.0","id":"null-args","method":"tools/call","params":{"name":"get_settings","arguments":null}}' });
      assert.equal(nullArgs.error.code, -32602, "Present arguments must be an object, not null");
      const integral = await json(endpoint, { method: "POST", headers, body: '{"jsonrpc":"2.0","id":"integral-number","method":"tools/call","params":{"name":"list_scans","arguments":{"limit":1.0,"offset":0e-1000000000}}}' });
      assert.ok(!integral.result.isError, "Exact integral JSON numbers remain supported");
      const notification = await request(endpoint, { method: "POST", headers, body: '{"jsonrpc":"2.0","method":"notifications/initialized"}' }, 202);
      assert.equal(await notification.text(), "", "Accepted notifications return an empty202");
      await request(endpoint, { method: "POST", headers, body: " ".repeat(1024 * 1024 + 1) }, 413);
      for (const version of ["2025-03-26", "2025-06-18", "2025-11-25"]) {
        const data = await rpc("initialize", { protocolVersion: version, capabilities: {}, clientInfo: { name: "lime-version-probe", version: "1" } }, mcpKey, 200, endpoint);
        assert.equal(data.result.protocolVersion, version);
      }
      const cors = await request(endpoint, { method: "POST", headers: { ...headers, Origin: "http://localhost:3002" }, body: JSON.stringify({ jsonrpc: "2.0", id: "cors", method: "tools/call", params: { name: "get_scan", arguments: { scan_id: mcpScan.id } } }) });
      assert.equal(cors.headers.get("access-control-allow-origin"), "http://localhost:3002", "Score enrichment preserves upstream CORS headers");
      const largeID = await request(endpoint, { method: "POST", headers, body: `{"jsonrpc":"2.0","id":9007199254740993,"method":"tools/call","params":{"name":"get_scan","arguments":{"scan_id":"${mcpScan.id}"}}}` });
      assert.match(await largeID.text(), /"id"\s*:\s*9007199254740993\s*[,}]/, "Score enrichment preserves large numeric JSON-RPC IDs exactly");
    }
    let dismissed = false;
    page.once("dialog", async (dialog) => { dismissed = true; await dialog.dismiss(); });
    await page.getByRole("button", { name: "Rotate MCP key", exact: true }).click();
    assert.equal(dismissed, true);
    await client.ping();
    page.once("dialog", (dialog) => dialog.accept());
    const [rotation] = await Promise.all([
      page.waitForResponse((response) => response.url().endsWith("/api/settings") && response.request().method() === "POST"),
      page.getByRole("button", { name: "Rotate MCP key", exact: true }).click(),
    ]);
    const rotated = await rotation.json();
    await rpc("ping", {}, mcpKey, 401);
    await assert.rejects(() => client.ping(), /401|Unauthorized|unauthorized/);
    const previousTrace = mcpConnection.trace;
    await client.close();
    mcpConnection = await connectMcp(`${baseUrl}/mcp`, rotated.mcpKey);
    await mcpConnection.client.ping();
    await navigate("/settings", "Settings");
    await page.getByLabel(/^Enable MCP/).locator("..").click();
    await page.getByRole("button", { name: "Save settings", exact: true }).click();
    await page.getByText(/Settings saved/i).waitFor();
    await rpc("ping", {}, rotated.mcpKey, 401);
    await assert.rejects(() => mcpConnection.client.ping(), /401|Unauthorized|unauthorized/);
    await writeFile(path.join(outputDir, "mcp-client-results.json"), JSON.stringify({ sdk: "@modelcontextprotocol/sdk@1.32.0", endpoint: `${baseUrl}/mcp`, tools: MCP_TOOL_NAMES, trace: [...previousTrace, ...mcpConnection.trace], v2: { sdk: "@modelcontextprotocol/client@2.3.0", ...mcpV2Evidence }, bridge: mcpBridgeEvidence }, null, 2));
    await mcpConnection.client.close();
    mcpConnection = undefined;
  });

  await check("rescan creates new ID, preserves viewport/tag; delete removes results", async () => {
    await json(`${scanUrl(single.id)}/issues/${issue.id}/false-positive`, { method: "POST" });
    await navigate(`/scans/${single.id}`);
    const [response] = await Promise.all([
      page.waitForResponse((response) => response.url().endsWith("/rescan")),
      page.getByRole("button", { name: "Rescan", exact: true }).click(),
    ]);
    const next = await response.json();
    assert.notEqual(next.id, single.id);
    assert.equal(next.viewport_preset, single.viewport_preset);
    assert.equal(next.tag, single.tag);
    await waitForScan(next.id);
    const inherited = (await json(`${scanUrl(next.id)}/issues`)).find((entry) => entry.issue.violation_type === "label");
    assert.equal(inherited.issue.is_false_positive, true, "Rescan inherits same-target triage");
    const screenshotParts = inherited.occurrences[0].element_screenshot_path.split("/").slice(-2);
    assert.equal(screenshotParts[0], next.id);
    const screenshotUrl = `${baseUrl}/api/screenshots/${screenshotParts.join("/")}`;
    await request(screenshotUrl);
    await json(`${scanUrl(single.id)}/issues/${issue.id}/false-positive`, { method: "DELETE" });
    assert.equal((await json(`${scanUrl(next.id)}/issues`)).find((entry) => entry.issue.id === inherited.issue.id).issue.is_false_positive, true, "Child triage is independent of later source changes");
    await navigate(`/scans/${next.id}`);
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.waitForURL("**/scans");
    await request(scanUrl(next.id), {}, 404);
    await request(`${scanUrl(next.id)}/issues`, {}, 404);
    await request(screenshotUrl, {}, 404);
  });

  const linkFixtures = await verifyLinkChecks({ baseUrl, fixtureOrigin, json, request, jsonOptions, page, navigate, check, requests, createFromForm, waitForScan, verificationSql, exec, repoRoot, outputDir, download, displayedScore, baselineScan: single });

  await check("Link Checker MCP SDK v1/v2, source pagination, CSV, companions and read-only bridge", async () => {
    const companionScan = await json(`${baseUrl}/api/scans`, jsonOptions("POST", {
      sitemap_url: fixtureOrigin + "/good", scan_type: "single", tag: "verification-mcp-links", include_link_check: true,
    }), 201);
    await waitForScan(companionScan.id);
    const companion = await json(`${scanUrl(companionScan.id)}/link-check`);
    await waitForLinkCheck(json, baseUrl, companion.id);
    const previousSettings = await json(`${baseUrl}/api/settings`);
    const generated = await json(`${baseUrl}/api/settings`, jsonOptions("POST", { action: "generate_mcp_key" }));
    const key = generated.mcpKey;
    assert.ok(key, "An ephemeral isolated MCP key is generated for saved link reads");
    const snapshot = () => verificationSql(`SELECT json_build_object(
      'checks',(SELECT coalesce(json_agg(j ORDER BY j.id),'[]'::json) FROM link_checks j),
      'results',(SELECT coalesce(json_agg(r ORDER BY r.id),'[]'::json) FROM link_check_results r),
      'scans',(SELECT coalesce(json_agg(s ORDER BY s.id),'[]'::json) FROM scans s),
      'settings',(SELECT coalesce(json_agg(to_jsonb(a)-'mcp_key_hash' ORDER BY a.key),'[]'::json) FROM app_settings a)
    )::text`);
    try {
      const sdk = await verifyLinkMcp({
        url: `${baseUrl}/mcp`, key, baseUrl, json,
        checkId: linkFixtures.single.id, otherCheckId: linkFixtures.crawl.id,
        sourceCheckId: linkFixtures.many.id, companionScanId: companionScan.id,
        noCompanionScanId: single.id, deletedCompanionScanId: linkFixtures.integrated.id,
        snapshot, requireHttp999: true,
      });
      const beforeBridge = await snapshot();
      const bridge = await verifyMcpBridge(`${baseUrl}/mcp`, key, mcpScan.id, {
        linkCheckId: linkFixtures.single.id, linkScanId: companionScan.id,
      });
      assert.deepEqual([...bridge.checked].sort(), [...MCP_TOOL_NAMES].sort(), "The real stdio bridge reads every one of the twelve saved-data tools");
      assert.equal(await snapshot(), beforeBridge, "Bridge reads do not change saved scans, link evidence or settings");
      await writeFile(path.join(outputDir, "link-mcp-client-results.json"), JSON.stringify({
        completedAt: new Date().toISOString(), tools: MCP_TOOL_NAMES, sdk, bridge,
        bridgeDataUnchanged: true,
      }, null, 2));
    } finally {
      await json(`${baseUrl}/api/settings`, jsonOptions("PUT", { integrations: { mcpEnabled: previousSettings.integrations.mcpEnabled } }));
    }
  });

  await check("desktop/tablet/mobile routes, navigation, search and screenshot layout", async () => {
    for (const width of [1440, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const route of ["/", "/scans", "/scans/new", "/links", "/settings", `/scans/${single.id}`, `/scans/${single.id}/issues`]) {
        await navigate(route);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.ok(overflow <= 1, `${width}px ${route} overflow ${overflow}`);
        assert.equal(await page.locator("main").count(), 1, "Single accessible main landmark");
        assert.ok((await page.locator("main").innerText()).length > 40);
      }
      await navigate("/links", "Link checker");
      await page.getByRole("button", { name: "Single page", exact: true }).click();
      await page.getByLabel("Page URL", { exact: true }).fill(fixtureOrigin + "/links/good");
      assert.equal(await page.getByRole("button", { name: "Start link check", exact: true }).isEnabled(), true);
      await page.screenshot({ path: path.join(outputDir, `link-checker-${width}.png`), fullPage: true });
    }
    await page.getByRole("button", { name: "Toggle Sidebar", exact: true }).click();
    const drawer = page.getByRole("dialog");
    await drawer.getByRole("link", { name: "New scan", exact: true }).click();
    await page.waitForURL("**/scans/new");
    await drawer.waitFor({ state: "hidden" });
    const search = page.getByRole("searchbox", { name: "Search scans" });
    await page.keyboard.press("Control+k");
    assert.ok(await search.evaluate((input) => document.activeElement === input));
    await search.fill("verification-single");
    await page.getByRole("button", { name: "Search scans", exact: true }).click();
    await page.waitForURL("**/scans?q=verification-single");
    assert.equal(await page.locator("tbody tr").count(), 1);
    await search.fill("no-matching-verification-scan");
    await search.press("Enter");
    await page.getByText(/No scans match/).waitFor();
    await page.getByRole("link", { name: "Clear search", exact: true }).click();
    await page.waitForURL("**/scans");
    assert.ok(await page.locator("tbody tr").count() > 1);
    await navigate(`/scans/${single.id}/issues`);
    const card = page.locator("[data-issue-card]").filter({ hasText: "Form elements must have labels" }).first();
    await card.locator(".issue-card-trigger").click();
    const thumbnail = card.locator('img[alt^="Screenshot of "]').first();
    await imageReady(thumbnail);
    await thumbnail.locator("..").click();
    await imageReady(page.getByRole("dialog").locator("img"));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
    await page.screenshot({ path: path.join(outputDir, "screenshot-mobile.png") });
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    assert.deepEqual(browserErrors, [], "Browser runtime errors");
  });
  console.log(`Existing-feature verification passed (${evidence.length} workflows).`);
} catch (error) {
  evidence.push({ name: "failure", status: "failed", message: error.message });
  if (page) await page.screenshot({ path: path.join(outputDir, "failure.png"), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await writeFile(path.join(outputDir, "results.json"), JSON.stringify({ completedAt: new Date().toISOString(), evidence, browserErrors }, null, 2));
  await mcpConnection?.client.close();
  await browser?.close();
  await new Promise((resolve) => fixtureServer.close(resolve));
}
