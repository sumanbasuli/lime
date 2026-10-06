import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import ts from "typescript";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const baseUrl = arg("--base-url", "http://localhost:3001").replace(/\/$/, "");
const baseline = process.argv.includes("--baseline");
const artifactDir = arg("--artifacts", "") || mkdtempSync(path.join(os.tmpdir(), "lime-api-roadmap-"));
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const catalog = readFileSync(path.join(scriptDir, "..", "content", "api.ts"), "utf8");
const compiledCatalog = ts.transpileModule(catalog, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { apiGroups } = await import("data:text/javascript;base64," + Buffer.from(compiledCatalog).toString("base64"));
const endpoints = apiGroups.flatMap((group) => group.endpoints);
const methodCounts = {};
for (const { method } of endpoints) {
  methodCounts[method] = (methodCounts[method] || 0) + 1;
}
const catalogCount = Object.values(methodCounts).reduce((sum, value) => sum + value, 0);
const report = { mode: baseline ? "baseline" : "verification", baseUrl, reducedMotion: "reduce", catalogCount, methodCounts, pages: [], interactions: [], failures: [] };
mkdirSync(artifactDir, { recursive: true });
let browser;

function check(condition, message) {
  if (!condition) report.failures.push(message);
}

async function protectReads(page) {
  await page.route("**/*", async (interception) => {
    const request = interception.request();
    const url = new URL(request.url());
    const safe = url.origin === new URL(baseUrl).origin
      && ["GET", "HEAD"].includes(request.method())
      && !/^\/(?:mcp(?:\/|$)|api\/(?:scans|settings|link-checks|screenshots)(?:\/|$))/.test(url.pathname);
    if (safe) await interception.continue();
    else {
      report.failures.push(`Blocked non-documentation request ${request.method()} ${url.origin}${url.pathname}`);
      await interception.abort();
    }
  });
}

async function prepareClipboard(page) {
  await page.addInitScript(() => {
    window.__copiedText = null;
    window.__denyClipboard = false;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text) => {
          if (window.__denyClipboard) throw new DOMException("Clipboard denied for verification", "NotAllowedError");
          window.__copiedText = text;
        },
      },
    });
  });
}

async function verifyApi(page, width) {
  const navigation = page.getByRole("navigation", { name: "API methods" });
  for (const [method, count] of Object.entries(methodCounts)) {
    const link = navigation.locator(`a[href='#${method.toLowerCase()}']`);
    assert.equal(await link.count(), 1, `${method} count does not match catalog`);
    assert.match(await link.innerText(), new RegExp(`\\b${method}\\b`));
    assert.match(await link.innerText(), new RegExp(`\\b${count}\\b`));
    await link.click();
    assert.equal(new URL(page.url()).hash, "#" + method.toLowerCase());
    assert.equal(await page.locator(`#${method.toLowerCase()} article`).count(), count);
  }

  const cards = page.locator("main article");
  assert.equal(await cards.count(), catalogCount, "Endpoint cards do not match the complete catalog");
  let requests = 0;
  let notes = 0;
  for (const endpoint of endpoints) {
    const card = page.getByRole("article", { name: endpoint.title, exact: true });
    assert.equal(await card.count(), 1, `Missing/duplicate endpoint ${endpoint.method} ${endpoint.path}`);
    assert.equal(await card.getByText(endpoint.path, { exact: true }).count(), 1);
    const paragraphs = await card.locator("p").allTextContents();
    for (const field of ["description", "auth", "response", "query"]) {
      if (endpoint[field]) assert(paragraphs.includes(endpoint[field]), `Catalog ${field} was changed/omitted for ${endpoint.title}`);
    }
    const json = card.getByRole("region", { name: /JSON code$/ });
    if (endpoint.body) {
      assert.equal(await json.count(), 1, `Missing JSON request panel for ${endpoint.title}`);
      const shown = await json.locator("code").textContent();
      assert.deepEqual(JSON.parse(shown), JSON.parse(endpoint.body));
      assert.equal(shown, JSON.stringify(JSON.parse(endpoint.body), null, 2), `Request JSON is not consistently formatted: ${endpoint.title}`);
      requests += 1;
    } else {
      assert.equal(await json.count(), 0, `Non-request response was presented as fabricated JSON: ${endpoint.title}`);
    }
    const fields = card.getByRole("region", { name: /Fields code$/ });
    const shapes = [...endpoint.response.matchAll(/\{([^{}]+)\}/g)]
      .map((match) => match[1].split(",").map((field) => field.trim()))
      .filter((names) => names.every((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)));
    const expectedFields = shapes.map((names, index) => [
      ...(shapes.length > 1 ? [`// Documented shape ${index + 1}`] : []),
      "{", ...names.map((name, position) => `  ${name}${position < names.length - 1 ? "," : ""}`), "}",
    ].join("\n")).join("\n\n");
    assert.equal(await fields.count(), expectedFields ? 1 : 0, `Response field panels differ from catalog for ${endpoint.title}`);
    for (const panel of await fields.all()) {
      assert.match(await panel.getAttribute("aria-label"), /response|field/i);
      assert.equal(await panel.locator("code").textContent(), expectedFields, `Invented/changed response fields for ${endpoint.title}`);
      assert.equal(await card.getByText(/field names are shown without values/i).count(), 1);
    }
    const curl = await card.getByRole("region", { name: /Bash code$/ }).locator("code").textContent();
    const syntax = spawnSync("bash", ["-n"], { input: curl, encoding: "utf8" });
    assert.equal(syntax.status, 0, `Displayed cURL shell syntax failed for ${endpoint.title}: ${syntax.stderr}`);
    assert.match(curl, new RegExp(`curl -fSs -X ${endpoint.method} `));
    assert.doesNotMatch(curl, /\{(?:id|scanId|issueId|resultId|filename)\}/, `Unsubstituted cURL path in ${endpoint.title}`);
    if (endpoint.path.startsWith("/api/link-checks/") && endpoint.path.includes("{id}")) assert(curl.includes("$LINK_CHECK_ID"));
    if (endpoint.path.includes("{resultId}")) assert(curl.includes("$RESULT_ID"));
    const anchor = await card.getAttribute("id");
    const permalink = card.getByRole("link", { name: "Link to " + endpoint.title, exact: true });
    assert.equal(await permalink.getAttribute("href"), "#" + anchor);
    if (endpoint.notes?.length) {
      assert.equal(await card.locator("details").count(), 1, `Notes must use native details for ${endpoint.title}`);
      for (const note of endpoint.notes) assert.equal(await card.getByText(note, { exact: true }).count(), 1, `Catalog note was changed/omitted for ${endpoint.title}`);
      notes += 1;
    }
  }

  const panels = page.locator("main pre[role='region']");
  assert(await panels.count() >= catalogCount, "Not all endpoint examples have code panels");
  for (const pre of await panels.all()) {
    const shown = await pre.locator("code").textContent();
    const panel = pre.locator("..");
    const button = panel.getByRole("button", { name: /^Copy / });
    assert.equal(await button.count(), 1, "Every code panel needs an accessible copy control");
    await button.click();
    await page.waitForFunction((expected) => window.__copiedText === expected, shown);
    assert.equal(await page.evaluate(() => window.__copiedText), shown, "Clipboard did not match displayed code exactly");
    assert.match(await panel.getByRole("status").textContent(), /copied to clipboard\.$/i);
  }
  assert.equal(await page.locator("main button").count(), await panels.count(), "API docs contain an unexpected actionable button beyond copy");

  const detail = page.locator("main details").first();
  assert.equal(await detail.getAttribute("open"), null, "Notes should initially be collapsed");
  await detail.locator("summary").focus();
  await page.keyboard.press("Enter");
  assert.notEqual(await detail.getAttribute("open"), null, "Native notes did not expand with Enter");
  assert(await detail.locator("li").first().isVisible(), "Expanded note content is not visible");
  await detail.locator("summary").press("Enter");
  assert.equal(await detail.getAttribute("open"), null, "Native notes did not collapse with Enter");

  const mcp = cards.filter({ has: page.getByText("MCP workflow transport", { exact: true }) });
  await mcp.locator("summary").click();
  assert.notEqual(await mcp.locator("details").getAttribute("open"), null);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(overflow <= 1, `API expanded notes overflow ${width}px viewport by ${overflow}px`);
  await mcp.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(artifactDir, `after-api-mcp-notes-${width}.png`) });

  const first = panels.first();
  const firstPanel = first.locator("..");
  await page.evaluate(() => { window.__denyClipboard = true; window.__copiedText = null; });
  await firstPanel.getByRole("button", { name: /^Copy / }).click();
  const status = firstPanel.getByRole("status");
  await page.waitForFunction((id) => document.getElementById(id)?.textContent.includes("Could not copy automatically"), await status.getAttribute("id"));
  assert(await status.isVisible(), "Clipboard-denial guidance is hidden");
  assert.doesNotMatch(await status.getAttribute("class"), /sr-only/, "Clipboard denial is only screen-reader feedback");
  assert.match(await status.textContent(), /select the code and copy it manually/i);
  assert.equal(await page.evaluate(() => window.__copiedText), null);
  check(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1, `Clipboard denial overflow at ${width}px`);
  if (width === 320) {
    await cards.filter({ has: page.getByText("List link targets", { exact: true }) }).screenshot({ path: path.join(artifactDir, "after-api-link-target-card-320.png") });
  }
  report.interactions.push({ route: "/api/", width, endpoints: catalogCount, formattedJsonRequests: requests, notes, copiedPanels: await panels.count(), deniedClipboard: true, nativeKeyboardNotes: true });
}

async function verifyHome(page, width) {
  const hero = page.locator("main > section").first();
  assert.equal(await hero.getByText(/v?2\.0\.0/i).count(), 0, "Homepage release badge remains");
  const download = hero.getByRole("link", { name: /download latest release/i });
  assert.equal(await download.count(), 1, "Latest release download CTA was removed");
  assert.equal(await download.getAttribute("href"), "https://github.com/sumanbasuli/lime/releases");
  report.interactions.push({ route: "/", width, releaseBadgeRemoved: true, latestDownloadRetained: true });
}

async function verifyRoadmap(page, width) {
  const text = await page.locator("main").innerText();
  for (const term of [/2\.0/, /available/i, /link check/i, /MCP/, /install/i, /future/i, /next priorities/i]) assert.match(text, term);
  assert.doesNotMatch(text, /2\.0\s*(?:·\s*)?unreleased|source candidate/i, "Available roadmap features still have preview labels");
  assert.doesNotMatch(text, /current 1\.x codebase/i, "Roadmap still describes the old codebase as current");
  const sections = page.locator("main section");
  assert(await sections.count() >= 4, "Roadmap lacks status-separated work sections");
  assert.match(await page.locator("#shipped").innerText(), /available|LIME 2\.0/i);
  const current = await page.locator("#current").innerText();
  assert.match(current, /available.*LIME 2\.0/i);
  assert.match(current, /More you can do with MCP/);
  assert.match(current, /Connections start read-only; enable write access to manage scans, findings, and settings/s);
  assert.match(await page.locator("#validation").innerText(), /first-time setup.*fresh macOS and Linux systems, including Docker setup/is);
  assert.match(await page.locator("#future").innerText(), /not available yet.*do not have release dates.*Explore OAuth/is);
  for (const id of ["shipped", "current", "validation", "future"]) {
    await page.getByRole("navigation", { name: "Roadmap status legend" }).locator(`a[href='#${id}']`).click();
    assert.equal(new URL(page.url()).hash, "#" + id);
  }
  const links = await page.locator("main a[href]").evaluateAll((elements) => elements.map((element) => ({ text: element.textContent.trim(), href: element.getAttribute("href") })));
  assert(links.length >= 2, "Roadmap needs evidence/documentation links");
  for (const link of links) {
    const url = new URL(link.href, baseUrl);
    assert(link.text, "Roadmap evidence link has no meaningful label");
    assert(["http:", "https:"].includes(url.protocol), "Unsafe roadmap link protocol");
    if (url.origin !== new URL(baseUrl).origin) assert.equal(url.hostname, "github.com", "Unexpected external roadmap destination");
    if (width === 1440 && url.origin === new URL(baseUrl).origin && url.pathname.includes("/docs/")) {
      const reader = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: "reduce" });
      const errors = [];
      reader.on("pageerror", (error) => errors.push(error.message));
      reader.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
      reader.on("response", (response) => { if (response.status() >= 500) errors.push(`${response.status()} ${response.url()}`); });
      await protectReads(reader);
      try {
        const response = await reader.goto(url.href, { waitUntil: "networkidle" });
        assert(response?.ok(), `Roadmap documentation link failed: ${link.href}`);
        assert((await reader.locator("main").innerText()).trim().length > 40);
        assert.equal(errors.length, 0, `Roadmap documentation link has browser errors: ${errors.join("; ")}`);
      } finally {
        await reader.close();
      }
    }
  }
  report.interactions.push({ route: "/roadmap/", width, sections: await sections.count(), sourceAndDocumentationLinks: links });
  if (width === 320) {
    await page.locator("#current").screenshot({ path: path.join(artifactDir, "after-roadmap-current-card-320.png") });
  }
}

async function settleScroll(page) {
  await page.waitForFunction(() => {
    const position = `${window.scrollX},${window.scrollY}`;
    const now = performance.now();
    if (window.__verificationScroll?.position !== position) {
      window.__verificationScroll = { position, since: now };
      return false;
    }
    return now - window.__verificationScroll.since >= 250;
  }, null, { polling: "raf", timeout: 10_000 });
}

async function normalMotionSmoke() {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "no-preference" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("response", (response) => { if (response.status() >= 500) errors.push(`${response.status()} ${response.url()}`); });
  await protectReads(page);
  await prepareClipboard(page);
  try {
    const response = await page.goto(baseUrl + "/api/", { waitUntil: "networkidle" });
    assert(response?.ok());
    const method = page.getByRole("navigation", { name: "API methods" }).locator("a[href='#get']");
    await method.scrollIntoViewIfNeeded();
    await settleScroll(page);
    await method.click();
    await settleScroll(page);
    assert.equal(new URL(page.url()).hash, "#get");
    const card = page.getByRole("article", { name: "List link targets", exact: true });
    const permalink = card.getByRole("link", { name: "Link to List link targets", exact: true });
    await permalink.scrollIntoViewIfNeeded();
    await settleScroll(page);
    await permalink.click();
    await settleScroll(page);
    assert.equal(new URL(page.url()).hash, "#" + await card.getAttribute("id"));
    const summary = card.locator("summary");
    await summary.scrollIntoViewIfNeeded();
    await settleScroll(page);
    await summary.click();
    await settleScroll(page);
    assert.notEqual(await card.locator("details").getAttribute("open"), null);
    assert(await card.locator("details li").first().isVisible());
    const copy = card.getByRole("button", { name: "Copy cURL · List link targets", exact: true });
    await copy.scrollIntoViewIfNeeded();
    await settleScroll(page);
    await copy.click();
    const code = await card.getByRole("region", { name: /Bash code$/ }).locator("code").textContent();
    await page.waitForFunction((expected) => window.__copiedText === expected, code);
    assert.equal(errors.length, 0, `Normal-motion smoke browser errors: ${errors.join("; ")}`);
    assert(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1);
    report.interactions.push({ route: "/api/", width: 390, reducedMotion: "no-preference", sequentialSettledMethodPermalinkNotesAndCopy: true, errors });
  } finally {
    await page.close();
  }
}

async function inspect(page, route, width) {
  const errors = [];
  const requests = [];
  page.on("pageerror", (error) => errors.push("pageerror: " + error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push("console: " + message.text());
  });
  page.on("response", (response) => {
    if (response.status() >= 500) errors.push("response: " + response.status() + " " + response.url());
  });
  page.on("request", (request) => requests.push({ method: request.method(), url: request.url() }));
  const response = await page.goto(baseUrl + route, { waitUntil: "networkidle", timeout: 30_000 });
  const body = await page.locator("body").innerText();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const overlay = await page.locator("[data-nextjs-dialog], .vite-error-overlay, #webpack-dev-server-client-overlay").count();
  const screenshot = `${baseline ? "before" : "after"}-${route === "/" ? "home" : route.replaceAll("/", "")}-${width}.png`;
  await page.screenshot({ path: path.join(artifactDir, screenshot), fullPage: route === "/roadmap/" });
  report.pages.push({ route, width, status: response?.status(), overflow, errors, requests, screenshot });
  check(response?.ok(), `${route} ${width}px did not load successfully`);
  check(body.trim().length > 40, `${route} ${width}px rendered no meaningful content`);
  check(!overlay, `${route} ${width}px has an error overlay`);
  check(overflow <= 1, `${route} ${width}px overflows the document by ${overflow}px`);
  check(!errors.length, `${route} ${width}px browser errors: ${errors.join("; ")}`);
  if (!baseline && !report.failures.length) {
    if (route === "/api/") await verifyApi(page, width);
    if (route === "/") await verifyHome(page, width);
    if (route === "/roadmap/") await verifyRoadmap(page, width);
    check(!errors.length, `${route} ${width}px interaction browser errors: ${errors.join("; ")}`);
  }
  return body;
}

try {
  browser = await chromium.launch({ headless: true });
  for (const width of [1440, 390, 320]) {
    for (const route of ["/", "/api/", "/roadmap/"]) {
      const page = await browser.newPage({ viewport: { width, height: width === 1440 ? 1000 : 844 }, reducedMotion: "reduce" });
      // Documentation may display write examples, but verification never executes
      // them or permits requests to the application/backend or another origin.
      await protectReads(page);
      await prepareClipboard(page);
      try {
        await inspect(page, route, width);
      } finally {
        await page.close();
      }
    }
  }
  if (!baseline) {
    assert(catalogCount > 0, "API catalog was empty");
    if (!report.failures.length) await normalMotionSmoke();
  }
} catch (error) {
  report.failures.push(error.stack || error.message);
} finally {
  await browser?.close();
  report.checkedAt = new Date().toISOString();
  writeFileSync(path.join(artifactDir, "results.json"), JSON.stringify(report, null, 2) + "\n");
}

console.log(JSON.stringify({ mode: report.mode, pages: report.pages.length, catalogCount, failures: report.failures, artifactDir }, null, 2));
if (report.failures.length) process.exitCode = 1;
