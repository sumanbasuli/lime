import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const baseUrl = arg("--base-url", "http://localhost:3001").replace(/\/$/, "");
const baseline = process.argv.includes("--baseline");
const artifactDir = path.resolve(arg("--artifacts", ".artifacts/verification/marketing"));
const base = new URL(baseUrl);
const routes = ["/", "/get-started/", "/screenshots/", "/roadmap/", "/api/", "/docs/user/link-checker/", "/docs/user/mcp/"];
const stale = /New\s*·\s*unreleased|2\.0\s*(?:·\s*)?unreleased|source candidate|In source versions with link checking|Unreleased source (?:features|work|changes)[^.]*\.?/gi;
const report = { mode: baseline ? "baseline" : "acceptance", baseUrl, reducedMotion: "reduce", pages: [], interactions: [], findings: [], imageReadinessWaits: [], linkChecks: [], failures: [] };
const links = new Map();
mkdirSync(artifactDir, { recursive: true });
let browser;

function isSafeUrl(url) {
  return ["http:", "https:"].includes(url.protocol)
    && !url.username && !url.password
    && !/^\/mcp(?:\/|$)/.test(url.pathname)
    && !(url.pathname.startsWith("/api/") && url.pathname !== "/api/")
    && (url.origin === base.origin || ["github.com", "lime.heysuman.com", "developers.openai.com", "learn.chatgpt.com", "code.claude.com", "cursor.com", "code.visualstudio.com", "opencode.ai"].includes(url.hostname));
}

async function protect(page) {
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === base.origin && isSafeUrl(url) && ["GET", "HEAD"].includes(request.method())) await route.continue();
    else {
      report.failures.push(`Blocked non-documentation browser request: ${request.method()} ${url.origin}${url.pathname}`);
      await route.abort();
    }
  });
}

async function clipboard(page) {
  await page.addInitScript(() => {
    window.__copiedText = null;
    window.__denyClipboard = false;
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text) => {
      if (window.__denyClipboard) throw new DOMException("Clipboard denied for verification", "NotAllowedError");
      window.__copiedText = text;
    } } });
  });
}

async function collectLinks(page) {
  for (const link of await page.locator("a[href]").evaluateAll((elements) => elements.map((element) => ({ text: element.textContent.trim() || element.getAttribute("aria-label"), href: element.href })))) {
    const url = new URL(link.href);
    if (url.origin === base.origin && url.pathname === new URL(page.url()).pathname && url.hash) {
      const id = decodeURIComponent(url.hash.slice(1));
      if (!await page.evaluate((target) => Boolean(document.getElementById(target)), id)) report.failures.push(`Missing on-page anchor ${link.href}`);
    }
    url.hash = "";
    const record = links.get(url.href) || { url: url.href, labels: new Set() };
    record.labels.add(link.text);
    links.set(url.href, record);
  }
}

async function decodedImage(page, image, message, intendedSrc) {
  // Native lazy-loading and a newly mounted next/image can settle after the
  // dialog becomes visible. Wait for an actual successful request before
  // decoding; a broken response still fails this bounded readiness check.
  const before = await image.evaluate((element) => ({ src: element.src, currentSrc: element.currentSrc, complete: element.complete, naturalWidth: element.naturalWidth }));
  const expectedSrc = intendedSrc || before.currentSrc || before.src;
  const pending = !before.complete || !before.naturalWidth || (before.currentSrc || before.src) !== expectedSrc;
  await page.waitForFunction(({ element, src }) => element.complete && element.naturalWidth > 0 && (element.currentSrc || element.src) === src, { element: await image.elementHandle(), src: expectedSrc }, { timeout: 5_000 });
  assert(await image.evaluate((element) => element.decode().then(() => true, () => false)), message);
  if (pending) report.imageReadinessWaits.push({ route: new URL(page.url()).pathname, width: page.viewportSize().width, expectedSrc, before, after: await image.evaluate((element) => ({ src: element.src, currentSrc: element.currentSrc, complete: element.complete, naturalWidth: element.naturalWidth })), verifiedDecode: true });
}

async function audit(page, route, width) {
  const errors = [];
  page.on("pageerror", (error) => errors.push("pageerror: " + error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push("console: " + message.text()); });
  page.on("response", (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  const response = await page.goto(baseUrl + route, { waitUntil: "networkidle" });
  assert(response?.ok(), `${route} returned ${response?.status()}`);
  await page.locator("footer").scrollIntoViewIfNeeded();
  for (const image of await page.locator("img").all()) {
    await image.scrollIntoViewIfNeeded();
    await decodedImage(page, image, `Image failed to decode on ${route}`);
  }
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  const body = await page.locator("main").innerText();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const images = await page.locator("img").evaluateAll((elements) => elements.map((image) => ({ src: image.currentSrc || image.src, alt: image.alt, width: image.naturalWidth, loaded: image.complete })));
  const outdated = [...body.matchAll(stale)].map((match) => match[0]);
  const screenshot = `${baseline ? "before" : "after"}-${route === "/" ? "home" : route.replaceAll("/", "")}-${width}.png`;
  await page.screenshot({ path: path.join(artifactDir, screenshot) });
  report.pages.push({ route, width, status: response.status(), overflow, images, errors, staleLabels: outdated, screenshot });
  assert(body.trim().length > 40, `${route} was blank`);
  assert(overflow <= 1, `${route} ${width}px document overflow: ${overflow}`);
  assert.equal(errors.length, 0, `${route} ${width}px errors: ${errors.join("; ")}`);
  assert(images.every((image) => image.loaded && image.width > 0), `${route} ${width}px has a broken/unloaded image`);
  await collectLinks(page);
  if (!baseline) assert.equal(outdated.length, 0, `${route} still mislabels available features: ${outdated.join("; ")}`);
  if (!baseline) await currentAvailability(page, route, width, body);
  return errors;
}

async function currentAvailability(page, route, width, body) {
  if (route === "/") {
    const hero = page.locator("main > section").first();
    assert.equal(await hero.getByText(/v?2\.0\.0|2\.0\s*[·-]\s*(?:current|release)/i).count(), 0, "Release badge was reintroduced in homepage hero");
    assert.equal(await hero.getByRole("link", { name: /download latest release/i }).getAttribute("href"), "https://github.com/sumanbasuli/lime/releases");
    const features = ["See the issue in context", "Retry failed pages", "Review large reports", "Share your findings", "Run LIME your way", "Link Checker", "MCP for AI tools", "Make informed decisions"];
    for (const title of features) assert.equal(await page.getByRole("heading", { name: title, exact: true }).count(), 1, `Missing current feature: ${title}`);
    await page.getByRole("heading", { name: "Link Checker", exact: true }).locator("..").screenshot({ path: path.join(artifactDir, `after-home-link-checker-feature-${width}.png`) });
    assert.equal(await page.getByRole("img", { name: /illustrative LIME dashboard with sample/i }).count(), 1, "Illustrated scores are not identified as samples");
    assert.match(body, /Link Checker reads links from page HTML within the limits you set/);
    assert.match(body, /does not run JavaScript or check links to sections within a page/);
    assert.match(body, /Enable write access when you want it to run scans, check links, or manage findings and settings/);
    assert.match(body, /AI connections start with read-only access/);
    const shown = await page.locator("code[aria-label='One-line install command']").textContent();
    const command = "curl -fsSL https://lime.heysuman.com/install.sh | bash";
    assert.equal(shown, command);
    await page.getByRole("button", { name: "Copy install command", exact: true }).click();
    await page.waitForFunction((expected) => window.__copiedText === expected, shown);
    assert.match(await page.locator("#install-copy-status").textContent(), /command copied/i);
    await page.evaluate(() => { window.__denyClipboard = true; window.__copiedText = null; });
    await page.getByRole("button", { name: "Copy install command", exact: true }).click();
    await page.waitForFunction(() => document.getElementById("install-copy-status")?.textContent.includes("Select the command"));
    assert.match(await page.locator("#install-copy-status").textContent(), /copy it manually/i);
    assert.equal(await page.evaluate(() => window.__copiedText), null);
    assert.equal(await page.getByRole("link", { name: /view install script/i }).getAttribute("href"), "/install.sh");
    assert.equal(await page.getByRole("link", { name: /setup and help/i }).getAttribute("href"), "/docs/reference/setup/");
    assert(body.includes(command + " -s -- --help"), "Installer help invocation is not displayed literally");
    assert.match(body, /LIME runs with Docker Compose/);
    await page.getByRole("heading", { name: "Your next audit starts here.", exact: true }).locator("..").screenshot({ path: path.join(artifactDir, `after-home-install-card-${width}.png`) });
    const url = "https://lime.heysuman.com/install.sh";
    links.set(url, { url, labels: new Set(["Displayed install command target; GET only, never execute"]) });
    report.interactions.push({ name: "current homepage and installer copy/help", width, features: features.length, exactClipboard: true, clipboardDenied: true, commandNeverExecuted: true });
  } else if (route === "/get-started/") {
    assert.match(body, /LIME 2\.0|current version/i);
    assert.match(body, /Include link check/);
    for (const client of ["Codex", "Claude Code", "OpenCode"]) assert(body.includes(client));
    assert.equal(await page.getByRole("button", { name: "Copy install command", exact: true }).count(), 0, "One-line installer should stay on homepage");
    assert.match(body, /backup|backups/i);
  } else if (route === "/roadmap/") {
    assert.match(await page.locator("#current").innerText(), /available.*LIME 2\.0/i);
    assert.match(await page.locator("#validation").innerText(), /next priorities.*installation, reliable backups, larger sites, and compatibility with more AI clients/is);
    assert.match(await page.locator("#future").innerText(), /not.*commit|not.*available|deferred/is);
  } else if (route === "/screenshots/") {
    assert.match(body, /Screenshots show example results from completed scans/i);
    assert.match(body, /Link Checker/);
  } else if (route === "/docs/user/link-checker/") {
    assert.match(body, /Include link check/i);
    assert.match(body, /HTTP|HTML/);
    assert.match(body, /does not.*JavaScript|without.*JavaScript/is);
  } else if (route === "/docs/user/mcp/") {
    for (const client of ["Codex", "Claude Code", "OpenCode"]) assert(body.includes(client), `Current user MCP chooser guide omits ${client}`);
    assert.match(body, /2\.x/);
    assert.match(body, /1\.x/);
    assert.match(body, /17 read tools, or 29 tools/);
    assert.match(body, /Allow MCP write actions/);
    assert.match(body, /4 MiB/);
    for (const tool of ["get_capabilities", "get_report", "get_screenshot", "create_scan", "rescan_scan", "create_link_check", "recheck_link_check", "delete_scan", "mark_issue_false_positive", "update_settings"]) {
      assert(body.includes(tool), `Current user MCP workflow guide omits ${tool}`);
    }
    assert.match(body, /read-only(?: access)? is the default/i);
    assert.match(body, /request_id/);
    assert.match(body, /confirm: true/);
  }
}

async function sharedNavigation(page, width) {
  const primary = [["Product", "/"], ["Docs", "/docs/"], ["API", "/api/"], ["Screenshots", "/screenshots/"], ["Roadmap", "/roadmap/"]];
  if (width === 1440) {
    for (const [name, route] of primary) {
      const navigation = page.getByRole("navigation", { name: "Primary navigation" });
      await navigation.getByRole("link", { name, exact: true }).click();
      await page.waitForURL((url) => url.pathname === route);
      await page.waitForFunction((expected) => document.querySelector('nav[aria-label="Primary navigation"] a[aria-current="page"]')?.getAttribute("href") === expected, route);
      await page.locator("main h1").waitFor({ state: "visible" });
      assert((await page.locator("main").innerText()).trim().length > 40);
    }
  } else {
    const trigger = page.getByRole("button", { name: "Open navigation", exact: true });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Mobile navigation" });
    await dialog.waitFor();
    await collectLinks(page);
    await page.screenshot({ path: path.join(artifactDir, `${baseline ? "before" : "after"}-mobile-navigation-${width}.png`) });
    const controls = dialog.locator("a[href], button");
    await controls.first().focus();
    await page.keyboard.press("Shift+Tab");
    assert(await controls.last().evaluate((element) => element === document.activeElement), "Mobile menu focus escaped");
    await page.keyboard.press("Escape");
    assert.equal(await dialog.count(), 0, "Escape did not close mobile menu");
    assert(await trigger.evaluate((element) => element === document.activeElement), "Mobile menu did not restore focus");
    for (const [name, route] of primary) {
      await page.getByRole("button", { name: "Open navigation", exact: true }).click();
      await page.getByRole("dialog", { name: "Mobile navigation" }).getByRole("link", { name, exact: true }).first().click();
      await page.waitForURL((url) => url.pathname === route);
      await page.waitForFunction((expected) => document.querySelector('nav[aria-label="Primary navigation"] a[aria-current="page"]')?.getAttribute("href") === expected, route);
      await page.locator("main h1").waitFor({ state: "visible" });
      assert.equal(await page.getByRole("dialog", { name: "Mobile navigation" }).count(), 0, "Navigation selection did not close mobile menu");
    }
  }
  report.interactions.push({ name: "shared marketing navigation", width, routes: primary.map(([, route]) => route), mobileFocusAndEscape: width < 1440 });
}

async function screenshotGallery(page, width) {
  const cards = page.locator("main button");
  const count = await cards.count();
  assert(count >= 10, "Screenshot gallery lost product screens");
  for (const index of [0, count - 1]) {
    const trigger = cards.nth(index);
    await trigger.scrollIntoViewIfNeeded();
    const previousOverflow = await page.evaluate(() => document.body.style.overflow);
    const previousScroll = await page.evaluate(() => window.scrollY);
    const intendedSrc = await trigger.locator("img").evaluate((image) => image.currentSrc || image.src);
    await trigger.click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    await decodedImage(page, dialog.locator("img"), "Expanded screenshot failed to load", intendedSrc);
    assert(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1);
    const focusedInside = await dialog.evaluate((element) => element.contains(document.activeElement));
    if (!baseline) {
      assert(focusedInside, "Expanded screenshot did not receive keyboard focus");
      assert.equal(await dialog.getAttribute("open"), "", "Screenshot viewer is not an open native modal dialog");
      const close = dialog.getByRole("button", { name: "Close screenshot", exact: true });
      const viewer = dialog.getByRole("region", { name: /screenshot viewer$/ });
      assert(await close.evaluate((element) => element === document.activeElement), "Screenshot close button did not receive initial focus");
      assert.equal(await page.evaluate(() => document.body.style.overflow), "hidden", "Screenshot modal did not lock background scroll");
      await page.keyboard.press("Tab");
      assert(await viewer.evaluate((element) => element === document.activeElement), "Screenshot image viewer cannot receive keyboard focus");
      if (await viewer.evaluate((element) => element.scrollHeight > element.clientHeight + 1)) {
        await page.keyboard.press("End");
        await page.waitForFunction((element) => element.scrollTop > 0, await viewer.elementHandle(), { timeout: 5_000 });
        assert(await viewer.evaluate((element) => element.scrollTop > 0), "Overflowing screenshot viewer cannot scroll by keyboard");
        assert(Math.abs(await page.evaluate(() => window.scrollY) - previousScroll) <= 1, "Screenshot viewer keyboard scroll moved its background");
      }
      await page.keyboard.press("Tab");
      assert(await close.evaluate((element) => element === document.activeElement), "Screenshot Tab focus escaped its modal");
      await page.keyboard.press("Shift+Tab");
      assert(await viewer.evaluate((element) => element === document.activeElement), "Screenshot Shift+Tab focus escaped its modal");
      await viewer.click({ position: { x: 6, y: 6 } });
      assert(await dialog.isVisible(), "Clicking inside the screenshot viewer dismissed its modal");
      await page.screenshot({ path: path.join(artifactDir, `after-gallery-${index === 0 ? "first" : "last"}-${width}.png`) });
    }
    await page.keyboard.press("Escape");
    const escapeClosed = !await dialog.isVisible();
    if (baseline && (!focusedInside || !escapeClosed)) report.findings.push({ route: "/screenshots/", width, screenshotIndex: index, issue: "Expanded gallery lacks focus handoff and/or Escape dismissal", focusedInside, escapeClosed });
    if (!baseline) {
      assert(escapeClosed, "Escape did not close expanded screenshot");
      assert(await trigger.evaluate((element) => element === document.activeElement), "Screenshot Escape did not restore thumbnail focus");
      assert.equal(await page.evaluate(() => document.body.style.overflow), previousOverflow, "Screenshot Escape did not restore background scroll state");
      assert(Math.abs(await page.evaluate(() => window.scrollY) - previousScroll) <= 1, "Screenshot Escape scrolled away from its thumbnail");
      for (const method of ["button", "backdrop"]) {
        await trigger.click();
        await dialog.waitFor();
        if (method === "button") await dialog.getByRole("button", { name: "Close screenshot", exact: true }).click();
        else {
          // The outside-card area is deliberately clicked, not the screenshot.
          const viewport = page.viewportSize();
          await page.mouse.click(viewport.width - 1, 1);
        }
        await dialog.waitFor({ state: "hidden" });
        assert(await trigger.evaluate((element) => element === document.activeElement), `Screenshot ${method} dismissal did not restore thumbnail focus`);
        assert.equal(await page.evaluate(() => document.body.style.overflow), previousOverflow, `Screenshot ${method} dismissal did not restore scroll state`);
        assert(Math.abs(await page.evaluate(() => window.scrollY) - previousScroll) <= 1, `Screenshot ${method} dismissal scrolled away from its thumbnail`);
      }
    }
    if (!escapeClosed) await dialog.getByRole("button", { name: "Close screenshot" }).click();
    assert(!await dialog.isVisible(), "Screenshot dialog remained visible after dismissal");
  }
  report.interactions.push({ name: "screenshot gallery", width, screens: count, expandedFirstAndLast: true, ...(baseline ? {} : { nativeModal: true, focusAndScrollRestored: true, keyboardFocusTrapped: true, escapeButtonAndBackdropClose: true }) });
}

async function readLink(url) {
  // Validate every redirect before following; never fall through to an app API
  // or execute any of the installation/API examples shown by the documentation.
  for (let redirects = 0; redirects < 8; redirects += 1) {
    assert(isSafeUrl(url), `Unsafe documentation redirect: ${url.origin}${url.pathname}`);
    const response = await fetch(url.href, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(15_000) });
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (response.status >= 300 && response.status < 400 && location) url = new URL(location, url);
    else return { status: response.status, finalUrl: url.href, ok: response.ok };
  }
  throw new Error("Documentation redirect limit exceeded");
}

async function linkStatuses() {
  for (const link of links.values()) {
    const url = new URL(link.url);
    const result = { url: url.href, scope: url.origin === base.origin ? "local" : "public", labels: [...link.labels] };
    if (!isSafeUrl(url)) {
      result.error = "Skipped unsafe/non-documentation destination";
      report.failures.push(result.error + ": " + url.href);
    } else {
      try {
        const response = await readLink(url);
        result.status = response.status;
        result.finalUrl = response.finalUrl;
        if (!response.ok) report.failures.push(`Marketing link ${response.status}: ${url.href}`);
      } catch (error) {
        result.error = error.message;
        report.failures.push(`Marketing link unverified: ${url.href}: ${error.message}`);
      }
    }
    report.linkChecks.push(result);
  }
}

try {
  browser = await chromium.launch({ headless: true });
  for (const width of [1440, 390, 320]) {
    for (const route of routes) {
      const page = await browser.newPage({ viewport: { width, height: width === 1440 ? 1000 : 844 }, reducedMotion: "reduce" });
      await protect(page);
      await clipboard(page);
      try {
        const errors = await audit(page, route, width);
        if (route === "/") await sharedNavigation(page, width);
        if (route === "/screenshots/") await screenshotGallery(page, width);
        assert.equal(errors.length, 0, `${route} ${width}px interaction errors: ${errors.join("; ")}`);
      } catch (error) {
        report.failures.push(`${route} ${width}px: ${error.stack || error.message}`);
        await page.screenshot({ path: path.join(artifactDir, `error-${route === "/" ? "home" : route.replaceAll("/", "")}-${width}.png`) });
      } finally {
        await page.close();
      }
    }
  }
  await linkStatuses();
} catch (error) {
  report.failures.push(error.stack || error.message);
} finally {
  await browser?.close();
  report.checkedAt = new Date().toISOString();
  report.localFailures = report.failures.filter((failure) => !failure.startsWith("Marketing link") && !failure.startsWith("Skipped unsafe/non-documentation"));
  report.localLinkFailures = report.linkChecks.filter((link) => link.scope === "local" && (link.error || link.status >= 400));
  report.externalStatusFailures = report.linkChecks.filter((link) => link.scope === "public" && link.status >= 400);
  report.externalUnverified = report.linkChecks.filter((link) => link.scope === "public" && link.error);
  writeFileSync(path.join(artifactDir, "results.json"), JSON.stringify(report, null, 2) + "\n");
}
console.log(JSON.stringify({ mode: report.mode, checkedAt: report.checkedAt, pages: report.pages.length, links: report.linkChecks.length, stale: report.pages.filter((page) => page.staleLabels.length).map(({ route, width, staleLabels }) => ({ route, width, staleLabels })), localFailures: report.localFailures, localLinkFailures: report.localLinkFailures, externalStatusFailures: report.externalStatusFailures, externalUnverified: report.externalUnverified, failures: report.failures, artifactDir }, null, 2));
if (report.failures.length) process.exitCode = 1;
