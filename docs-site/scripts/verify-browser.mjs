import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function readArg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const explicitBaseUrl = readArg("--base-url", "");
const verificationPort = Number(readArg("--port", "3101"));
const configuredBasePath = (process.env.LIME_DOCS_BASE_PATH || "").trim().replace(/\/$/, "");
const defaultBasePath = configuredBasePath === "/" ? "" : configuredBasePath;
const baseUrl = (explicitBaseUrl || "http://127.0.0.1:" + verificationPort + defaultBasePath).replace(/\/$/, "");
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(scriptDir, "..", "out");
const artifactDir = path.join(scriptDir, "..", "..", ".artifacts", "verification");
const basePath = new URL(baseUrl).pathname.replace(/\/$/, "");
let staticServer;
function exportedDocRoutes(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return exportedDocRoutes(fullPath);
    return entry.name === "index.html"
      ? ["/" + path.relative(outDir, fullPath).replaceAll(path.sep, "/").replace(/index\.html$/, "")]
      : [];
  });
}
const routes = [...new Set([
  "/",
  "/docs/",
  "/docs/user/first-scan/",
  "/docs/user/link-checker/",
  "/docs/user/mcp/",
  "/docs/developer/",
  "/docs/reference/setup/",
  "/docs/reference/verification/",
  "/api/",
  "/screenshots/",
  "/roadmap/",
  "/get-started/",
  ...exportedDocRoutes(path.join(outDir, "docs")),
])];
const failures = [];
const checks = [];

async function waitForServer(url) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // The static server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for static docs at " + url);
}

async function auditRoute(browser, route, viewport, mobile = false) {
  const page = await browser.newPage({ viewport, isMobile: mobile });
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push("pageerror: " + error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      browserErrors.push("console: " + message.text());
    }
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      browserErrors.push("response: " + response.status() + " " + response.url());
    }
  });

  try {
    const response = await page.goto(baseUrl + route, { waitUntil: "networkidle", timeout: 30_000 });
    if (!response?.ok()) {
      failures.push(route + " returned HTTP " + (response?.status() ?? "no response"));
    }
    if ((await page.locator("body").innerText()).trim().length < 40) {
      failures.push(route + " rendered no meaningful content");
    }
    if (await page.locator("[data-nextjs-dialog], .vite-error-overlay, #webpack-dev-server-client-overlay").count()) {
      failures.push(route + " rendered a framework error overlay");
    }
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    if (overflow > 1) {
      failures.push(route + " overflows the " + viewport.width + "px viewport by " + overflow + "px");
    }
    failures.push(...browserErrors.map((error) => route + " " + error));
    checks.push({ route, width: viewport.width, status: response?.status(), overflow, browserErrors });
  } catch (error) {
    failures.push(route + " audit failed: " + error.message);
  } finally {
    await page.close();
  }
}

let browser;
try {
  if (!explicitBaseUrl) {
    staticServer = spawn(
      process.execPath,
      [path.join(scriptDir, "serve-static.mjs"), "--port", String(verificationPort)],
      { stdio: "ignore" }
    );
    await waitForServer(baseUrl);
  }

  browser = await chromium.launch({ headless: true });
  for (const route of routes) {
    await auditRoute(browser, route, { width: 1440, height: 1000 });
  }
  for (const route of routes) {
    await auditRoute(browser, route, { width: 390, height: 844 }, true);
  }

  const interactionPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await interactionPage.goto(baseUrl + "/docs/", { waitUntil: "networkidle" });
  await interactionPage.getByRole("button", { name: /search docs/i }).click();
  await interactionPage.getByPlaceholder(/search partial retry/i).fill("link checker");
  await interactionPage.getByRole("link", { name: /link checker/i }).first().waitFor();
  const searchUrl = interactionPage.url();
  await interactionPage.getByRole("button", { name: "Close search" }).focus();
  await interactionPage.keyboard.press("Enter");
  if (await interactionPage.getByRole("dialog", { name: /search docs/i }).count()) {
    failures.push("Focused search close button did not close with Enter");
  }
  if (interactionPage.url() !== searchUrl) failures.push("Closing search with Enter opened an unrelated result");
  if (!await interactionPage.getByRole("button", { name: /search docs/i }).evaluate((element) => element === document.activeElement)) {
    failures.push("Closing search did not restore focus to its trigger");
  }
  await interactionPage.getByRole("button", { name: /search docs/i }).click();
  const searchDialog = interactionPage.getByRole("dialog", { name: /search docs/i });
  await searchDialog.getByRole("link", { name: /link checker/i }).first().waitFor();
  await interactionPage.getByRole("textbox", { name: "Search documentation" }).focus();
  await interactionPage.keyboard.press("Shift+Tab");
  const lastResult = searchDialog.getByRole("link").last();
  if (!await lastResult.evaluate((element) => element === document.activeElement)) failures.push("Search Tab focus escaped its dialog");
  const focusedHref = await lastResult.getAttribute("href");
  await interactionPage.keyboard.press("Enter");
  await interactionPage.waitForURL((url) => url.pathname.replace(/\/$/, "") === new URL(focusedHref, baseUrl).pathname.replace(/\/$/, ""));

  await interactionPage.goto(baseUrl + "/docs/reference/mcp/", { waitUntil: "networkidle" });
  const mcpContent = await interactionPage.locator("main").innerText();
  for (const expected of ["http://localhost:3000/mcp", "bearer_token_env_var", "Bearer ${LIME_MCP_KEY}", "Bearer ${env:LIME_MCP_KEY}", "Authorization:${LIME_MCP_AUTH_HEADER}", "LIME_MCP_SDK=v2", "verify:mcp", "mcp-remote@0.14.3", "lime-mcp-client.mts", "test:mcp-transport"]) {
    if (!mcpContent.includes(expected)) {
      failures.push("MCP documentation is missing or incorrectly expands " + expected);
    }
  }

  // Check the actual reading journey, not just that disconnected pages render.
  const readingRoutes = ["first-scan", "dashboard", "scan-detail", "issues", "reports", "settings", "mcp", "agent", "troubleshooting", "link-checker"];
  await interactionPage.goto(baseUrl + "/docs/user/" + readingRoutes[0] + "/", { waitUntil: "networkidle" });
  const activeGuide = interactionPage.getByRole("navigation", { name: "Documentation navigation" }).locator('[aria-current="page"]');
  if (await activeGuide.count() !== 1 || (await activeGuide.getAttribute("href"))?.replace(/\/$/, "") !== basePath + "/docs/user/first-scan") {
    failures.push("Documentation navigation does not identify the current guide");
  }
  if (!(await interactionPage.getByRole("navigation", { name: "breadcrumb" }).innerText()).includes("Create Your First Scan")) {
    failures.push("Breadcrumb does not display the current guide title");
  }
  for (const slug of readingRoutes.slice(1)) {
    const next = interactionPage.getByRole("navigation", { name: "Adjacent documentation" }).getByRole("link", { name: /next/i });
    if ((await next.getAttribute("href"))?.replace(/\/$/, "") !== basePath + "/docs/user/" + slug) {
      failures.push("User reading order does not lead to " + slug);
      break;
    }
    await next.click();
    await interactionPage.waitForURL((url) => url.pathname.replace(/\/$/, "") === basePath + "/docs/user/" + slug);
  }

  for (const [query, expected] of [["backup restore", /backup and restore/i], ["troubleshooting", /troubleshooting/i]]) {
    await interactionPage.getByRole("button", { name: /search docs/i }).click();
    await interactionPage.getByRole("textbox", { name: "Search documentation" }).fill(query);
    await interactionPage.getByRole("dialog", { name: /search docs/i }).getByRole("link", { name: expected }).first().waitFor();
    await interactionPage.keyboard.press("Escape");
  }

  await interactionPage.goto(baseUrl + "/screenshots/", { waitUntil: "networkidle" });
  await interactionPage.getByRole("button", { name: /dashboard/i }).first().click();
  await interactionPage.getByRole("dialog", { name: /dashboard/i }).waitFor();
  await interactionPage.getByRole("button", { name: /close screenshot/i }).click();

  await interactionPage.setViewportSize({ width: 390, height: 844 });
  await interactionPage.goto(baseUrl + "/docs/", { waitUntil: "networkidle" });
  await interactionPage.getByRole("button", { name: /open navigation/i }).click();
  await interactionPage.getByRole("dialog", { name: /mobile navigation/i }).waitFor();
  const mobileMenu = interactionPage.getByRole("dialog", { name: /mobile navigation/i });
  const firstScanLink = mobileMenu.getByRole("link", { name: /create your first scan/i });
  await firstScanLink.waitFor();
  if ((await firstScanLink.getAttribute("href"))?.replace(/\/$/, "") !== basePath + "/docs/user/first-scan") {
    failures.push("Mobile navigation lost the configured documentation base path");
  }
  await mobileMenu.getByRole("link").first().focus();
  await interactionPage.keyboard.press("Shift+Tab");
  if (!await mobileMenu.getByRole("link").last().evaluate((element) => element === document.activeElement)) failures.push("Mobile navigation focus escaped its dialog");
  await interactionPage.keyboard.press("Escape");
  if (await mobileMenu.count()) failures.push("Escape did not close mobile navigation");
  if (!await interactionPage.getByRole("button", { name: /open navigation/i }).evaluate((element) => element === document.activeElement)) failures.push("Mobile navigation did not restore focus");

  await interactionPage.goto(baseUrl + "/docs/user/mcp/", { waitUntil: "networkidle" });
  await interactionPage.locator("summary").filter({ hasText: "On this page" }).click();
  const sectionLink = interactionPage.getByRole("navigation", { name: "On this page" }).filter({ visible: true }).getByRole("link").first();
  const sectionHref = await sectionLink.getAttribute("href");
  await sectionLink.click();
  if (new URL(interactionPage.url()).hash !== sectionHref) {
    failures.push("Mobile section menu did not navigate to the selected heading");
  }
  await interactionPage.waitForFunction((href) => {
    const heading = document.getElementById(href.slice(1));
    const top = heading?.getBoundingClientRect().top ?? -1;
    return top >= 124 && top < window.innerHeight;
  }, sectionHref, { timeout: 5000 });

  mkdirSync(artifactDir, { recursive: true });
  for (const [route, name, viewport] of [
    ["/docs/", "docs-home-desktop", { width: 1440, height: 1000 }],
    ["/docs/user/first-scan/", "docs-first-scan-mobile", { width: 390, height: 844 }],
    ["/docs/reference/deployment/backup-restore/", "docs-backup-desktop", { width: 1440, height: 1000 }],
    ["/docs/user/mcp/", "docs-mcp-desktop", { width: 1440, height: 1000 }],
  ]) {
    await interactionPage.setViewportSize(viewport);
    await interactionPage.goto(baseUrl + route, { waitUntil: "networkidle" });
    await interactionPage.screenshot({ path: path.join(artifactDir, name + ".png"), fullPage: true });
  }
  await interactionPage.close();
} catch (error) {
  failures.push("Reader interactions failed: " + error.message);
} finally {
  await browser?.close();
  staticServer?.kill("SIGTERM");
}

mkdirSync(artifactDir, { recursive: true });
writeFileSync(path.join(artifactDir, "docs-refinement-results.json"), JSON.stringify({
  checkedAt: new Date().toISOString(), routes, checks, failures,
  interactions: ["search and keyboard focus/activation", "user reading sequence", "mobile navigation", "mobile section menu and visible target", "screenshot gallery", "literal MCP client examples"],
}, null, 2) + "\n");

if (failures.length) {
  console.error("Browser verification failed:");
  for (const failure of failures) {
    console.error("  - " + failure);
  }
  process.exit(1);
}

console.log("Browser verification passed for " + routes.length + " routes at desktop and mobile widths, search, reading order, section navigation, and screenshot interactions.");
