import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

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

async function createFromForm(target, type, preset, tag) {
  await navigate("/scans/new", "New scan");
  await page.getByRole("button", { name: type === "single" ? "Single page" : "Sitemap", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(preset, "i") }).click();
  await page.getByLabel(type === "single" ? "Page URL" : "Sitemap URL", { exact: true }).fill(fixtureOrigin + target);
  await page.getByLabel(/Tag/).fill(tag);
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

async function rpc(method, params = {}, key, status = 200) {
  const headers = { "Content-Type": "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;
  return json(`${apiUrl}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }, status);
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
    paused = await createFromForm("/sitemap.xml", "sitemap", "Desktop", "verification-pause");
    await waitForScan(paused.id, ["scanning"]);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    const state = await waitForScan(paused.id, ["paused"]);
    assert.equal(state.total_urls, 8);
    assert.ok(state.scanned_urls < state.total_urls, "Fixture must pause before completion");
    const recovery = await createFromForm("/sitemap.xml", "sitemap", "Tablet", "verification-recovery");
    await waitForScan(recovery.id, ["scanning"]);
    await navigate("/links");
    await exec("docker", ["compose", "-p", "lime-verification", "-f", "docker-compose.docs.yml", "restart", "shopkeeper"], { cwd: repoRoot });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (await fetch(`${apiUrl}/api/health`).then((response) => response.ok).catch(() => false)) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.equal((await waitForScan(paused.id, ["paused"])).scanned_urls, state.scanned_urls);
    assert.equal((await waitForScan(recovery.id)).scanned_urls, 8);
    await navigate(`/scans/${paused.id}`);
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    const completed = await waitForScan(paused.id);
    assert.equal(completed.total_urls, 8);
    assert.equal(completed.scanned_urls, 8);
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
    try {
      await probe.route("**/issues/details?**", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"Temporary verification failure"}' }));
      await probe.goto(`${baseUrl}/scans/${single.id}/issues`, { waitUntil: "domcontentloaded" });
      await probe.locator(".issue-card-trigger").first().click();
      await probe.getByText("Temporary verification failure", { exact: true }).waitFor();
      await probe.unroute("**/issues/details?**");
      await probe.getByRole("button", { name: "Retry loading details", exact: true }).click();
      await probe.getByText("Affected elements", { exact: true }).waitFor();
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

  await check("MCP enable, generated key, read tools, rotation and disable", async () => {
    await rpc("initialize", {}, undefined, 401);
    await navigate("/settings", "Settings");
    await page.getByLabel(/^Enable MCP/).locator("..").click();
    await page.getByRole("button", { name: "Save settings", exact: true }).click();
    await page.getByText(/Settings saved/i).waitFor();
    const [generated] = await Promise.all([
      page.waitForResponse((response) => response.url().endsWith("/api/settings") && response.request().method() === "POST"),
      page.getByRole("button", { name: "Generate MCP key", exact: true }).click(),
    ]);
    const result = await generated.json();
    const key = result.mcpKey;
    assert.ok(key, "Generated MCP key response");
    await page.getByText("New MCP key", { exact: true }).waitFor();
    assert.equal(await page.locator("code").last().innerText(), key);
    const initialized = await rpc("initialize", {}, key);
    const version = await json(`${baseUrl}/api/version`);
    assert.equal(initialized.result.serverInfo.version, version.version);
    const tools = (await rpc("tools/list", {}, key)).result.tools;
    assert.equal(tools.length, 6);
    for (const [name, argumentsValue] of [
      ["list_scans", {}], ["get_scan", { scan_id: single.id }],
      ["list_scan_issues", { scan_id: single.id }],
      ["get_issue_detail", { scan_id: single.id, kind: "failed", key: issue.id }],
      ["get_report_metadata", { scan_id: single.id }], ["get_settings", {}],
    ]) {
      const response = await rpc("tools/call", { name, arguments: argumentsValue }, key);
      assert.ok(response.result, `${name}: ${JSON.stringify(response.error)}`);
      assert.notEqual(response.result.isError, true, name);
      const content = response.result.structuredContent;
      if (name === "list_scans") assert.ok(content.scans.some((scan) => scan.id === single.id));
      if (name === "get_scan") {
        assert.equal(content.scan.id, single.id);
        assert.equal(content.progress.percent, 100);
        assert.ok(content.score_summary.has_score);
      }
      if (name === "list_scan_issues") assert.ok(content.issues.some((entry) => entry.issue_id === issue.id));
      if (name === "get_issue_detail") assert.equal(content.detail.summary.issue_id, issue.id);
      if (name === "get_report_metadata") assert.equal(content.reports.pdf, `/api/scans/${single.id}/issues/report.pdf`);
      if (name === "get_settings") {
        assert.equal(content.integrations.mcp_enabled, true);
        assert.ok(!JSON.stringify(content).includes(key), "MCP reads do not expose bearer key");
      }
    }
    const [rotation] = await Promise.all([
      page.waitForResponse((response) => response.url().endsWith("/api/settings") && response.request().method() === "POST"),
      page.getByRole("button", { name: "Generate MCP key", exact: true }).click(),
    ]);
    const rotated = await rotation.json();
    await rpc("initialize", {}, key, 401);
    await rpc("initialize", {}, rotated.mcpKey);
    await page.getByLabel(/^Enable MCP/).locator("..").click();
    await page.getByRole("button", { name: "Save settings", exact: true }).click();
    await page.getByText(/Settings saved/i).waitFor();
    await rpc("initialize", {}, rotated.mcpKey, 401);
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
      assert.equal(await page.getByRole("button", { name: "Start link check", exact: true }).isDisabled(), true);
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
  await browser?.close();
  await new Promise((resolve) => fixtureServer.close(resolve));
}
