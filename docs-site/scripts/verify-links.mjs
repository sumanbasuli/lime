import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";

function html(body, base = "") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Link verification</title>${base ? `<base href="${base}">` : ""}</head><body><main><h1>Link verification</h1>${body}</main></body></html>`;
}

// Real HTTP fixtures, served only by the isolated product verifier.
export function handleLinkFixture(request, response, { origin, requests }) {
  const url = new URL(request.url, origin);
  const pathname = url.pathname;
  if (!pathname.startsWith("/links/")) return false;
  const methodKey = `${request.method} ${pathname}`;
  requests.set(methodKey, (requests.get(methodKey) || 0) + 1);
  const port = new URL(origin).port;
  const send = (status, body = "", type = "text/html") => {
    if (response.destroyed) return;
    response.writeHead(status, { "Content-Type": type });
    response.end(body);
  };
  const delayed = (duration) => {
    const timer = setTimeout(() => send(200, "late response", "text/plain"), duration);
    timer.unref();
    response.once("close", () => clearTimeout(timer));
  };
  if (pathname === "/links/site") {
    send(200, html(`
      <a href="/links/good">Healthy</a>
      <a href="/links/missing">Broken target</a>
      <a href="/links/missing#section">Duplicate broken reference</a>
      <a href="/links/nonstandard999">Non-standard HTTP response</a>
      <a href="/links/redirect">Redirect</a>
      <a href="/links/chain">Redirect chain</a>
      <a href="/links/head-fallback">HEAD fallback</a>
      <a href="/links/document.pdf">Document</a>
      <img alt="Fixture" src="/links/image.svg">
      <a href="/links/loop">Redirect loop</a>
      <a href="/links/timeout">Slow target</a>
      <a href="/links/unsafe-redirect">Unsafe redirect</a>
      <a href="http://localhost:${port}/links/private">Private external target</a>
      <a href="/links/good?a=1&amp;b=2#fragment">Query target</a>
      <a href="/links/crawl-a">Crawl A</a>
      <a href="/links/crawl-b">Crawl B</a>
      <a href="/links/base">Base URL source</a>
      <a href="/links/missing">=1+1</a>
      <a href="mailto:test@example.invalid">Email</a>
      <a href="tel:123">Phone</a>
      <a href="javascript:void(0)">Script</a>
      <a href="#local-fragment">Fragment</a>
    `));
  } else if (pathname === "/links/good") {
    send(200, html('<p id="fragment">Healthy page</p>'));
  } else if (pathname === "/links/many-sources") {
    send(200, html(Array.from({ length: 45 }, (_, index) => `<a href="/links/missing">Reference ${index + 1}</a>`).join("")));
  } else if (pathname === "/links/crawl-a" || pathname === "/links/crawl-b") {
    send(200, html(`<a href="/links/missing">Broken from ${pathname}</a><a href="/links/site">Back to start</a>`));
  } else if (pathname === "/links/base") {
    send(200, html('<a href="document.pdf?keep=1">Base-relative document</a>', "/links/assets/"));
  } else if (pathname === "/links/missing") {
    send(404, "Missing", "text/plain");
  } else if (pathname === "/links/nonstandard999") {
    send(999, "Verify availability manually", "text/plain");
  } else if (pathname === "/links/redirect" || pathname === "/links/chain") {
    response.writeHead(302, { Location: pathname === "/links/chain" ? "/links/redirect" : "/links/good" });
    response.end();
  } else if (pathname === "/links/loop") {
    response.writeHead(302, { Location: "/links/loop" });
    response.end();
  } else if (pathname === "/links/unsafe-redirect") {
    response.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" });
    response.end();
  } else if (pathname === "/links/head-fallback") {
    send(request.method === "HEAD" ? 405 : 200, "GET is supported", "text/plain");
  } else if (pathname === "/links/document.pdf" || pathname === "/links/assets/document.pdf") {
    send(200, "%PDF-1.4 verification fixture", "application/pdf");
  } else if (pathname === "/links/image.svg") {
    send(200, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>', "image/svg+xml");
  } else if (pathname === "/links/timeout") {
    delayed(15_000);
  } else if (pathname === "/links/cancel" || pathname === "/links/recovery") {
    send(200, html(`<a href="${pathname}-target">Slow link</a>`));
  } else if (pathname === "/links/cancel-target") {
    delayed(15_000);
  } else if (pathname === "/links/recovery-target") {
    if ((requests.get(pathname) || 0) > 1) send(200, "Recovered", "text/plain");
    else delayed(15_000);
  } else if (pathname === "/links/private") {
    send(200, "This private external target must never be requested", "text/plain");
  } else {
    send(404, "Unknown link fixture", "text/plain");
  }
  return true;
}

export async function waitForLinkCheck(json, baseUrl, id, expected = ["completed"], timeout = 90_000) {
  const deadline = Date.now() + timeout;
  let job;
  while (Date.now() < deadline) {
    job = await json(`${baseUrl}/api/link-checks/${id}`);
    if (expected.includes(job.status)) return job;
    assert.ok(!["failed", "cancelled"].includes(job.status), `Unexpected link state: ${JSON.stringify(job)}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Link check timed out: ${JSON.stringify(job)}`);
}

async function allResults(json, baseUrl, id, status) {
  const items = [];
  let offset = 0;
  for (;;) {
    const result = await json(`${baseUrl}/api/link-checks/${id}/results?limit=3&offset=${offset}${status ? `&status=${status}` : ""}`);
    assert.equal(result.offset, offset);
    assert.equal(result.limit, 3);
    assert.ok(result.items.length <= 3);
    items.push(...result.items);
    if (!result.has_more) {
      assert.equal(items.length, result.total, "Pagination must return every saved target");
      break;
    }
    assert.ok(result.items.length, "A non-terminal results page must advance");
    offset += result.items.length;
  }
  assert.equal(new Set(items.map((item) => item.id)).size, items.length, "No repeated targets across pages");
  return items;
}

// Presentation regression cases use only intercepted GET responses on a fresh
// browser page. No saved job, scan, settings, or public destination is mutated.
export async function verifyLinkCheckPresentation({ page, navigate, outputDir }) {
  await navigate("/links");
  const origin = new URL(page.url()).origin;
  const browser = page.context().browser();
  assert.ok(browser, "Presentation verification requires a managed browser");
  const probeContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const probe = await probeContext.newPage();
  probe.setDefaultTimeout(20_000);
  const checkId = "00000000-0000-4000-8000-000000000099";
  const apiPath = `/api/link-checks/${checkId}`;
  const destination = `https://www.linkedin.com/in/verification?tracking=${"long-query-value-".repeat(150)}`;
  const sources = Array.from({ length: 45 }, (_, index) => ({
    page_url: `https://source.example.test/reference-page?reference=${index + 1}`,
    element: index === 2 ? "page" : "a",
    attribute: index === 2 ? "url" : "href",
    text: index === 1 ? "" : `captured-${index + 1}`,
  }));
  const target = (id, target_url, status, overrides = {}) => ({
    id, target_url, status, status_code: status === "healthy" || status === "redirected" ? 200 : null,
    final_url: target_url, redirect_count: 0, link_type: "external", occurrence_count: 1,
    sources: [{ page_url: "https://source.example.test/", element: "a", attribute: "href", text: `captured-${id}` }],
    error: null, error_kind: null, ...overrides,
  });
  const targets = [
    target("target-linkedin", destination, "broken", { status_code: 999, occurrence_count: sources.length, sources: sources.slice(0, 5) }),
    target("target-github", "https://github.com/twbs/icons", "healthy"),
    target("target-wordpress", "https://wordpress.org/documentation/", "redirected", { redirect_count: 1, final_url: "https://wordpress.org/documentation/article/" }),
    target("target-x", "https://x.com/verification", "healthy"),
    target("target-lookalike", "https://linkedin.com.evil.test/in/verification", "blocked", { error_kind: "blocked" }),
    target("target-timeout", "https://timeout.example.test/", "error", { error_kind: "timeout" }),
    target("target-unchecked", "https://unchecked.example.test/", "unchecked"),
  ];
  const summary = { healthy: 2, redirected: 1, broken: 1, error: 1, blocked: 1, unchecked: 1, timeout: 1 };
  const check = {
    id: checkId, scan_id: null, url: "https://source.example.test/", check_type: "single", status: "completed",
    max_pages: 1, pages_checked: 1, pages_failed: 0, links_checked: 6, total_links: targets.length,
    truncated: true, error: null, summary,
    created_at: "2026-10-05T09:00:00.000Z", updated_at: "2026-10-05T09:00:10.000Z", completed_at: "2026-10-05T09:00:10.000Z",
  };
  const unexpectedErrors = [];
  const sourceRequests = [];
  const evidence = [];
  let injectedFailure = false;
  let injectedResponses = 0;
  const intercepted = `**${apiPath}**`;
  const pageJson = (items, limit, offset) => ({ items: items.slice(offset, offset + limit), total: items.length, limit, offset, has_more: offset + limit < items.length });
  const localOnly = async (route) => {
    const url = new URL(route.request().url());
    if (["http:", "https:"].includes(url.protocol) && url.origin !== origin) {
      unexpectedErrors.push(`Unexpected external request: ${url}`);
      await route.abort();
      return;
    }
    await route.continue();
  };
  const mock = async (route) => {
    assert.equal(route.request().method(), "GET", "Presentation probes must not write to the API");
    const url = new URL(route.request().url());
    let body;
    if (url.pathname === apiPath) body = check;
    else if (url.pathname === `${apiPath}/results`) {
      const status = url.searchParams.get("status");
      const filtered = status ? targets.filter((entry) => entry.status === status) : targets;
      body = pageJson(filtered, Number(url.searchParams.get("limit")), Number(url.searchParams.get("offset")));
    } else if (url.pathname === `${apiPath}/results/target-linkedin/sources`) {
      const limit = Number(url.searchParams.get("limit"));
      const offset = Number(url.searchParams.get("offset"));
      assert.equal(limit, 20);
      sourceRequests.push(offset);
      if (offset === 20 && !injectedFailure) {
        injectedFailure = true;
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Temporary source-page verification failure" }) });
        return;
      }
      body = pageJson(sources, limit, offset);
    } else {
      throw new Error(`Unexpected presentation request: ${url}`);
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  };
  probe.on("pageerror", (error) => unexpectedErrors.push(error.message));
  probe.on("console", (message) => {
    if (message.type() === "error" && !(injectedFailure && /^Failed to load resource: the server responded with a status of 503/.test(message.text()))) unexpectedErrors.push(message.text());
  });
  probe.on("response", (response) => {
    if (response.status() === 503 && new URL(response.url()).pathname === `${apiPath}/results/target-linkedin/sources`) injectedResponses += 1;
    else if (response.status() >= 500) unexpectedErrors.push(`${response.status()} ${response.url()}`);
  });
  const targetSection = probe.locator('section[aria-labelledby="link-target-title"]');
  const waitForTargets = async () => {
    await targetSection.waitFor();
    await probe.waitForFunction(() => document.querySelector('section[aria-labelledby="link-target-title"]')?.getAttribute("aria-busy") === "false");
  };
  const measure = async (label, width) => {
    await probe.evaluate(() => document.fonts.ready);
    const overflow = await probe.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `${width}px ${label} overflow ${overflow}`);
    evidence.push({ label, width, overflow });
  };
  try {
    await probe.route("**/*", localOnly);
    await probe.route(intercepted, mock);
    const response = await probe.goto(`${origin}/links/${checkId}`, { waitUntil: "domcontentloaded" });
    assert.equal(response?.status(), 200);
    await waitForTargets();
    assert.equal(await targetSection.locator("article").count(), targets.length);
    for (const [id, icon] of [["target-linkedin", "linkedin"], ["target-github", "github"], ["target-wordpress", "wordpress"], ["target-x", "twitter-x"], ["target-lookalike", "globe2"]]) {
      const savedTarget = targets.find((entry) => entry.id === id);
      const row = targetSection.locator("article").filter({ has: probe.locator(`p[title=${JSON.stringify(savedTarget.target_url)}]`) });
      assert.equal(await row.locator("[data-destination-icon]").getAttribute("data-destination-icon"), icon, `${id} uses the expected Bootstrap destination icon`);
      assert.equal(await row.locator("[data-destination-icon] svg").count(), 1);
    }
    const chips = probe.getByRole("group", { name: "Filter by outcome", exact: true });
    for (const [status, label] of [["broken", "broken"], ["redirected", "redirected"], ["error", "errors"], ["blocked", "blocked"], ["healthy", "healthy"], ["unchecked", "unchecked"]]) {
      const button = chips.getByRole("button", { name: `Show ${label} targets`, exact: true });
      assert.match(await button.innerText(), new RegExp(`\\b${summary[status]}$`), `The ${status} chip includes its saved summary count`);
      await button.click();
      await waitForTargets();
      assert.equal(await probe.getByLabel("Status", { exact: true }).inputValue(), status);
      assert.equal(await button.getAttribute("aria-pressed"), "true");
      assert.equal(await targetSection.locator("article").count(), summary[status], `The ${status} outcome chip filters saved targets`);
    }
    await probe.getByLabel("Status", { exact: true }).selectOption("all");
    await waitForTargets();
    const row = targetSection.locator("article").filter({ has: probe.locator('[data-destination-icon="linkedin"]') });
    await row.getByText("Broken", { exact: true }).waitFor();
    await row.getByText("Non-standard HTTP response", { exact: true }).waitFor();
    assert.match(await row.innerText(), /HTTP 999\. Open this destination to verify availability manually/);
    assert.doesNotMatch(await row.innerText(), /profile (?:is )?(?:missing|not found|does not exist)/i, "HTTP 999 does not establish that a LinkedIn profile is missing");
    await probe.setViewportSize({ width: 320, height: 1000 });
    const truncated = await row.locator("p[title]").evaluate((element) => ({ title: element.title, text: element.textContent, ellipsis: getComputedStyle(element).textOverflow, clipped: element.scrollWidth > element.clientWidth }));
    assert.equal(truncated.title, destination);
    assert.equal(truncated.text, destination);
    assert.equal(truncated.ellipsis, "ellipsis");
    assert.ok(truncated.clipped, "Long destination queries are truncated in the collapsed row");
    await measure("collapsed long destination", 320);
    await row.getByRole("button", { name: "Show sources (45)", exact: true }).click();
    await row.getByText("captured-1", { exact: true }).waitFor();
    assert.equal(await row.getByRole("button", { name: "Hide sources (45)", exact: true }).getAttribute("aria-expanded"), "true");
    await row.getByRole("heading", { name: "Referenced from", exact: true }).waitFor();
    assert.equal(await row.locator("code").filter({ hasText: destination }).textContent(), destination, "The expanded panel retains the full destination URL");
    const firstSource = row.locator("li").first();
    for (const field of ["Found on", "Element", "Attribute", "Captured text"]) await firstSource.getByText(field, { exact: true }).waitFor();
    await firstSource.getByText("Occurrence 1", { exact: true }).waitFor();
    await firstSource.getByText("<a>", { exact: true }).waitFor();
    await firstSource.getByText("href", { exact: true }).waitFor();
    await row.getByText("No text captured for this reference.", { exact: true }).waitFor();
    assert.doesNotMatch(await row.innerText(), /no accessible name/i, "Empty extracted text is not an accessibility-name verdict");
    await row.getByText("Source page request", { exact: true }).waitFor();
    await row.getByText("This is the source-page inventory entry, not an extracted HTML link.", { exact: true }).waitFor();
    assert.equal(await row.locator("li").count(), 20);
    const sourcePages = row.getByRole("group", { name: `Source reference pages for ${destination}`, exact: true });
    const controlsFit = await sourcePages.evaluate((group) => {
      const bounds = group.getBoundingClientRect();
      return [...group.querySelectorAll("button")].every((button) => {
        const rect = button.getBoundingClientRect();
        return rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1;
      });
    });
    assert.ok(controlsFit, "320px source pagination controls remain inside the expanded panel");
    await measure("expanded structured source references", 320);
    await firstSource.scrollIntoViewIfNeeded();
    await probe.screenshot({ path: path.join(outputDir, "link-check-presentation-sources-320.png") });
    const [failure] = await Promise.all([
      probe.waitForResponse((response) => response.status() === 503 && new URL(response.url()).pathname.endsWith("/target-linkedin/sources")),
      sourcePages.getByRole("button", { name: "Next", exact: true }).click(),
    ]);
    assert.equal(failure.status(), 503);
    await row.getByRole("button", { name: "Retry sources", exact: true }).waitFor();
    assert.equal(await row.locator("li").count(), 0, "A failed second source page hides the first page's stale rows");
    assert.equal(await row.getByText("captured-1", { exact: true }).count(), 0);
    assert.equal(await row.getByText("Occurrence 1", { exact: true }).count(), 0);
    await row.getByRole("button", { name: "Retry sources", exact: true }).click();
    await row.getByText("captured-21", { exact: true }).waitFor();
    await row.getByText("Occurrence 21", { exact: true }).waitFor();
    assert.equal(await row.locator("li").count(), 20, "Retry loads the selected second page, not page one");
    assert.equal(await row.getByText("captured-1", { exact: true }).count(), 0);
    await sourcePages.getByRole("button", { name: "Next", exact: true }).click();
    await row.getByText("captured-41", { exact: true }).waitFor();
    assert.equal(await row.locator("li").count(), 5);
    await row.getByText("Occurrence 45", { exact: true }).waitFor();
    assert.equal(await sourcePages.getByRole("button", { name: "Next", exact: true }).isDisabled(), true);
    assert.deepEqual(sourceRequests, [0, 20, 20, 40], "45 references page 20/20/5 and retry the failed selected offset");
    assert.equal(injectedResponses, 1, "Exactly one controlled source-page 503 was exercised");
    await measure("recovered final source page", 320);
    await row.scrollIntoViewIfNeeded();
    await probe.screenshot({ path: path.join(outputDir, "link-check-presentation-retry-320.png") });
    await row.getByRole("button", { name: "Hide sources (45)", exact: true }).click();
    assert.equal(await row.getByRole("button", { name: "Show sources (45)", exact: true }).getAttribute("aria-expanded"), "false");
    assert.equal(await row.getByRole("heading", { name: "Referenced from", exact: true }).count(), 0);
    await probe.setViewportSize({ width: 1440, height: 1000 });
    await measure("destination icons and outcome filters", 1440);
    await probe.screenshot({ path: path.join(outputDir, "link-check-presentation-desktop.png"), fullPage: true });
    assert.deepEqual(unexpectedErrors, [], "Presentation probes have no unexpected browser errors or external requests");
    await writeFile(path.join(outputDir, "link-check-presentation-results.json"), JSON.stringify({ completedAt: new Date().toISOString(), evidence, sourceRequests, injectedResponses, unexpectedErrors }, null, 2));
    return evidence;
  } catch (error) {
    await probe.screenshot({ path: path.join(outputDir, "link-check-presentation-failure.png"), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await probe.unroute(intercepted, mock);
    await probe.unroute("**/*", localOnly);
    await probeContext.close();
  }
}

// Wait for saved data, not just the shell/loader, before measuring layouts.
// Also inspect expanded source references at every supported review width.
export async function verifyLinkCheckLayouts({ page, navigate, outputDir, single, crawl, integrated, expectMissingCompanion = false }) {
  const evidence = [];
  const ready = async (route) => {
    if (route === "/links") {
      await page.locator('section[aria-label="Link checker summary"]').waitFor();
      await page.locator('section[aria-labelledby="link-history-title"] article').first().waitFor();
    } else if (route.startsWith("/links/")) {
      await page.getByRole("heading", { name: "Link check details", exact: true }).waitFor();
      await page.locator('section[aria-labelledby="link-target-title"] article').first().waitFor();
    } else if (route === "/scans/new") {
      await page.getByLabel("Include link check", { exact: true }).waitFor();
    } else {
      if (expectMissingCompanion) await page.getByText(/No associated link check is available/).waitFor();
      else await page.getByRole("link", { name: "View link results", exact: true }).waitFor();
    }
    await page.evaluate(() => document.fonts.ready);
  };
  const measure = async (route, width, expanded = false) => {
    assert.equal(await page.locator("main").count(), 1);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `${width}px ${route} ${expanded ? "expanded sources " : ""}overflow ${overflow}`);
    evidence.push({ route, width, expanded, overflow, ready: "loaded" });
  };
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const route of ["/links", `/links/${single.id}`, `/links/${crawl.id}`, `/scans/${integrated.id}`, "/scans/new"]) {
      await navigate(route);
      await ready(route);
      await measure(route, width);
    }
    const detailRoute = `/links/${single.id}`;
    await navigate(detailRoute);
    await ready(detailRoute);
    await page.screenshot({ path: path.join(outputDir, `link-check-detail-${width}.png`), fullPage: true });
    const row = page.locator('section[aria-labelledby="link-target-title"] article').first();
    await row.getByRole("button", { name: /show sources/i }).click();
    await row.locator("li").first().waitFor();
    const sourceControlsFit = await row.getByRole("group", { name: /Source reference pages/ }).evaluate((group) => {
      const bounds = group.getBoundingClientRect();
      return [...group.querySelectorAll("button")].every((button) => {
        const rect = button.getBoundingClientRect();
        return rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1;
      });
    });
    assert.ok(sourceControlsFit, `${width}px expanded source pagination must fit inside its panel`);
    await measure(detailRoute, width, true);
    await row.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(outputDir, `link-check-sources-${width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  return evidence;
}

export async function verifyLinkChecks(context) {
  const { baseUrl, fixtureOrigin, json, request, jsonOptions, page, navigate, check, requests, createFromForm, waitForScan, verificationSql, exec, repoRoot, outputDir, download, displayedScore, baselineScan } = context;
  const endpoint = `${baseUrl}/api/link-checks`;
  const create = (url, check_type = "single", max_pages = 20) => json(endpoint, jsonOptions("POST", { url, check_type, max_pages }), 201);
  const wait = (id, expected) => waitForLinkCheck(json, baseUrl, id, expected);
  let single;
  let crawl;
  let capped;
  let integrated;
  let many;

  await check("link checker single-page browser creation, HTTP outcomes, sources and CSV", async () => {
    for (const payload of [
      { url: "not-a-url", check_type: "single" },
      { url: "file:///tmp/private", check_type: "single" },
      { url: fixtureOrigin + "/links/site", check_type: "invalid" },
      { url: fixtureOrigin + "/links/site", check_type: "crawl", max_pages: 501 },
    ]) await json(endpoint, jsonOptions("POST", payload), 400);
    await navigate("/links", "Link checker");
    await page.getByRole("button", { name: "Single page", exact: true }).click();
    await page.getByLabel("Page URL", { exact: true }).fill(fixtureOrigin + "/links/site");
    const [response] = await Promise.all([
      page.waitForResponse((response) => response.url().endsWith("/api/link-checks") && response.request().method() === "POST"),
      page.getByRole("button", { name: "Start link check", exact: true }).click(),
    ]);
    assert.equal(response.status(), 201);
    single = await response.json();
    await page.waitForURL(`**/links/${single.id}`);
    const completed = await wait(single.id);
    assert.equal(completed.pages_checked, 1);
    assert.equal(completed.pages_failed, 0);
    assert.equal(completed.scan_id, null);
    assert.ok(completed.summary.broken > 0);
    assert.ok(completed.summary.redirected > 0);
    assert.ok(completed.summary.timeout > 0);
    assert.ok(completed.summary.blocked > 0);
    const results = await allResults(json, baseUrl, single.id);
    const target = (suffix) => results.find((item) => item.target_url === fixtureOrigin + suffix);
    assert.equal(target("/links/good").status, "healthy");
    assert.equal(target("/links/missing").status, "broken");
    assert.equal(target("/links/missing").status_code, 404);
    assert.equal(target("/links/nonstandard999").status, "broken");
    assert.equal(target("/links/nonstandard999").status_code, 999);
    assert.equal(target("/links/missing").occurrence_count, 3);
    assert.equal(target("/links/redirect").status, "redirected");
    assert.equal(target("/links/chain").redirect_count, 2);
    assert.equal(target("/links/chain").final_url, fixtureOrigin + "/links/good");
    assert.equal(target("/links/head-fallback").status, "healthy");
    assert.ok(requests.get("HEAD /links/head-fallback") > 0 && requests.get("GET /links/head-fallback") > 0);
    assert.equal(target("/links/document.pdf").link_type, "document");
    assert.equal(target("/links/image.svg").link_type, "media");
    assert.equal(target("/links/loop").error_kind, "redirect_loop");
    assert.equal(target("/links/timeout").error_kind, "timeout");
    assert.equal(target("/links/unsafe-redirect").status, "blocked");
    assert.equal(results.find((item) => item.target_url.startsWith("http://localhost:")).status, "blocked");
    assert.equal(requests.get("/links/private") || 0, 0);
    assert.ok(target("/links/good?a=1&b=2"), "Query strings are retained and fragments normalized");
    assert.ok(results.every((item) => /^https?:/.test(item.target_url)), "Non-HTTP protocols are not fetched");
    const broken = target("/links/missing");
    const firstSources = await json(`${endpoint}/${single.id}/results/${broken.id}/sources?limit=2&offset=0`);
    const lastSources = await json(`${endpoint}/${single.id}/results/${broken.id}/sources?limit=2&offset=2`);
    assert.equal(firstSources.total, 3);
    assert.equal(firstSources.has_more, true);
    assert.equal(lastSources.has_more, false);
    assert.equal(firstSources.items.length + lastSources.items.length, 3);
    assert.ok(firstSources.items.every((source) => source.page_url === fixtureOrigin + "/links/site"));
    await json(`${endpoint}/${single.id}/results?status=invalid`, {}, 400);
    const csv = await (await request(`${endpoint}/${single.id}/export.csv`)).text();
    assert.ok(csv.includes(fixtureOrigin + "/links/missing"));
    assert.ok(csv.includes(fixtureOrigin + "/links/site"));
    assert.ok(!/(^|[,\r\n])"?=1\+1(?:"|,|\r|\n)/.test(csv), "Spreadsheet formulas must not be executable CSV cells");
    await writeFile(path.join(outputDir, "link-check-results.csv"), csv);
    await navigate(`/links/${single.id}`);
    await page.getByLabel("Status", { exact: true }).selectOption("broken");
    const brokenRow = page.locator("article").filter({ hasText: fixtureOrigin + "/links/missing" });
    await brokenRow.getByRole("button", { name: "Show sources (3)", exact: true }).click();
    await brokenRow.getByText("=1+1", { exact: true }).waitFor();
    assert.equal(await page.locator('section[aria-labelledby="link-target-title"] article').count(), 2, "The status filter shows only broken targets, preserving raw HTTP 999");
    await page.getByLabel("Status", { exact: true }).selectOption("all");
    await download(page.getByRole("button", { name: /export csv/i }), "csv");
    await page.screenshot({ path: path.join(outputDir, "link-check-results-desktop.png"), fullPage: true });
  });

  await check("link checker same-origin crawl, grouping, base URLs, limits and history", async () => {
    crawl = await create(fixtureOrigin + "/links/site", "crawl");
    const completed = await wait(crawl.id);
    assert.ok(completed.pages_checked > 1);
    const results = await allResults(json, baseUrl, crawl.id);
    const broken = results.find((item) => item.target_url === fixtureOrigin + "/links/missing");
    assert.ok(broken.occurrence_count >= 5);
    const sources = await json(`${endpoint}/${crawl.id}/results/${broken.id}/sources?limit=100&offset=0`);
    const sourcePages = new Set(sources.items.map((source) => source.page_url));
    for (const route of ["/links/site", "/links/crawl-a", "/links/crawl-b"]) assert.ok(sourcePages.has(fixtureOrigin + route));
    assert.ok(results.some((item) => item.target_url === fixtureOrigin + "/links/assets/document.pdf?keep=1"), "HTML base URLs resolve relative document targets");
    capped = await create(fixtureOrigin + "/links/crawl-a", "crawl", 1);
    const limited = await wait(capped.id);
    assert.equal(limited.pages_checked, 1);
    assert.equal(limited.truncated, true, "A bounded crawl must not claim exhaustive coverage");
    const history = await json(`${endpoint}?limit=2&offset=0`);
    assert.equal(history.items.length, 2);
    assert.equal(history.has_more, true);
    const aggregate = await json(`${endpoint}/stats`);
    assert.ok(aggregate.total_checks >= 3);
    assert.ok(aggregate.links_checked >= completed.links_checked);
    await navigate("/links", "Link checker");
    await page.getByRole("link", { name: /view link check for/i }).first().waitFor();
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("link", { name: /view link check for/i }).first().waitFor();
    await navigate(`/links/${capped.id}`);
    const [recheckResponse] = await Promise.all([
      page.waitForResponse((response) => response.url().endsWith(`/${capped.id}/recheck`) && response.request().method() === "POST"),
      page.getByRole("button", { name: "Recheck", exact: true }).click(),
    ]);
    assert.equal(recheckResponse.status(), 201);
    const recheck = await recheckResponse.json();
    assert.notEqual(recheck.id, capped.id);
    assert.equal(recheck.max_pages, 1);
    await wait(recheck.id);
    assert.equal((await json(`${endpoint}/${capped.id}`)).status, "completed", "Rechecking preserves the original snapshot");
    many = await create(fixtureOrigin + "/links/many-sources");
    await wait(many.id);
    await navigate(`/links/${many.id}`);
    await page.getByLabel("Status", { exact: true }).selectOption("broken");
    const row = page.locator("article").filter({ hasText: fixtureOrigin + "/links/missing" });
    await row.getByRole("button", { name: "Show sources (45)", exact: true }).click();
    await row.getByText("Reference 1", { exact: true }).waitFor();
    const sourcePagination = row.getByRole("group", { name: `Source reference pages for ${fixtureOrigin}/links/missing`, exact: true });
    await sourcePagination.getByRole("button", { name: /next/i }).click();
    await row.getByText("Reference 21", { exact: true }).waitFor();
    await sourcePagination.getByRole("button", { name: /next/i }).click();
    await row.getByText("Reference 45", { exact: true }).waitFor();
    assert.equal(await sourcePagination.getByRole("button", { name: /next/i }).isDisabled(), true);
  });

  await check("optional scan link checker, scoring isolation, rescan and cascade deletion", async () => {
    assert.equal((await json(`${baseUrl}/api/scans/${baselineScan.id}`)).include_link_check, false);
    assert.equal(await json(`${baseUrl}/api/scans/${baselineScan.id}/link-check`), null);
    integrated = await createFromForm("/good", "single", "Mobile", "verification-links-integrated", true);
    assert.equal(integrated.include_link_check, true);
    const queued = await json(`${baseUrl}/api/scans/${integrated.id}/link-check`);
    assert.equal(queued.scan_id, integrated.id);
    assert.equal(queued.check_type, "scan");
    await waitForScan(integrated.id);
    const completed = await wait(queued.id);
    assert.equal(completed.pages_checked, 1);
    assert.equal(completed.pages_failed, 0);
    const originalIssues = await json(`${baseUrl}/api/scans/${baselineScan.id}/issues`);
    const newIssues = await json(`${baseUrl}/api/scans/${integrated.id}/issues`);
    const ruleInventory = (items) => items.map((item) => [item.issue.violation_type, item.occurrences.length]).sort((left, right) => left[0].localeCompare(right[0]));
    assert.deepEqual(ruleInventory(newIssues), ruleInventory(originalIssues), "Link checks do not add accessibility issues or alter audit evidence");
    assert.equal(await displayedScore(integrated.id), await displayedScore(baselineScan.id), "Opting into link checking leaves the accessibility score unchanged");
    await navigate(`/scans/${integrated.id}`);
    await page.getByRole("link", { name: /view link.*results/i }).waitFor();
    const fresh = await json(`${baseUrl}/api/scans/${integrated.id}/rescan`, { method: "POST" }, 201);
    assert.equal(fresh.include_link_check, true);
    assert.notEqual(fresh.id, integrated.id);
    await waitForScan(fresh.id);
    const freshJob = await json(`${baseUrl}/api/scans/${fresh.id}/link-check`);
    assert.notEqual(freshJob.id, queued.id);
    await wait(freshJob.id);
    const detached = await json(`${endpoint}/${freshJob.id}/recheck`, { method: "POST" }, 201);
    assert.equal(detached.scan_id, null);
    assert.equal(detached.check_type, "scan");
    await wait(detached.id);
    await request(`${baseUrl}/api/scans/${fresh.id}`, { method: "DELETE" }, 204);
    await request(`${endpoint}/${freshJob.id}`, {}, 404);
    assert.equal((await json(`${endpoint}/${queued.id}`)).status, "completed");
    assert.equal(await verificationSql(`SELECT count(*) FROM link_check_results WHERE link_check_id='${freshJob.id}'`), "0");
    assert.equal((await json(`${endpoint}/${detached.id}`)).status, "completed", "A detached recheck survives deletion of the parent scan");
    await navigate(`/links/${queued.id}`);
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Delete check", exact: true }).click();
    await page.waitForURL("**/links");
    assert.equal(await json(`${baseUrl}/api/scans/${integrated.id}/link-check`), null);
    assert.equal((await json(`${baseUrl}/api/scans/${integrated.id}`)).include_link_check, true);
    await navigate(`/scans/${integrated.id}`);
    await page.getByText(/No associated link check is available/).waitFor();
    assert.deepEqual(ruleInventory(await json(`${baseUrl}/api/scans/${integrated.id}/issues`)), ruleInventory(newIssues), "Deleting a companion preserves accessibility evidence");
  });

  await check("link checker cancellation and backend restart recovery", async () => {
    const cancelled = await create(fixtureOrigin + "/links/cancel");
    const deadline = Date.now() + 20_000;
    while (!(requests.get("/links/cancel-target") > 0)) {
      assert.ok(Date.now() < deadline, "The cancel fixture request must begin");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await navigate(`/links/${cancelled.id}`);
    await page.getByRole("button", { name: /cancel check/i }).click();
    await wait(cancelled.id, ["cancelled"]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal((await json(`${endpoint}/${cancelled.id}`)).status, "cancelled", "Late worker completion cannot overwrite cancellation");
    const recovery = await create(fixtureOrigin + "/links/recovery");
    const recoveryDeadline = Date.now() + 20_000;
    while (!(requests.get("/links/recovery-target") > 0)) {
      assert.ok(Date.now() < recoveryDeadline, "The recovery fixture request must begin");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await navigate("/scans/new", "New scan");
    await exec("docker", ["compose", "-p", "lime-verification", "-f", "docker-compose.docs.yml", "restart", "shopkeeper"], { cwd: repoRoot });
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try { if ((await json(`${baseUrl}/api/health`)).status === "ok") break; } catch { /* restarting */ }
      assert.ok(attempt < 59, "Backend must recover after restart");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const recovered = await wait(recovery.id);
    assert.equal(recovered.status, "completed");
    assert.equal(recovered.id, recovery.id);
    const results = await allResults(json, baseUrl, recovery.id);
    assert.equal(results.find((item) => item.target_url.endsWith("/links/recovery-target")).status, "healthy");
    await navigate(`/links/${cancelled.id}`);
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: /delete check/i }).click();
    await page.waitForURL("**/links");
    await request(`${endpoint}/${cancelled.id}`, {}, 404);
    const parent = await createFromForm("/sitemap.xml", "sitemap", "Desktop", "verification-cancelled-companion", true);
    const companion = await json(`${baseUrl}/api/scans/${parent.id}/link-check`);
    assert.equal(companion.status, "queued");
    await json(`${endpoint}/${companion.id}/cancel`, { method: "POST" });
    await json(`${endpoint}/${companion.id}/recheck`, { method: "POST" }, 409);
    await waitForScan(parent.id);
    assert.equal((await json(`${endpoint}/${companion.id}`)).status, "cancelled", "Completing a parent must honor explicit companion cancellation");
    const failed = await create(fixtureOrigin + "/links/missing");
    const failure = await wait(failed.id, ["failed"]);
    assert.equal(failure.pages_checked, 0);
    assert.equal(failure.pages_failed, 1);
    assert.ok(failure.error);
    await navigate(`/links/${failed.id}`);
    await page.getByText(/This check failed/).waitFor();
  });

  await check("link checker responsive saved results and scan integration", async () => {
    await verifyLinkCheckPresentation({ page, navigate, outputDir });
    await verifyLinkCheckLayouts({ page, navigate, outputDir, single, crawl, integrated, expectMissingCompanion: true });
  });
  return { single, crawl, capped, integrated, many };
}
