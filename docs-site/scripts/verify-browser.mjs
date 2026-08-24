import { chromium } from "playwright";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

function readArg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const explicitBaseUrl = readArg("--base-url", "");
const verificationPort = Number(readArg("--port", "3101"));
const baseUrl = (explicitBaseUrl || "http://127.0.0.1:" + verificationPort).replace(/\/$/, "");
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
let staticServer;
const routes = [
  "/",
  "/docs/",
  "/docs/user/first-scan/",
  "/docs/user/link-checker/",
  "/docs/developer/",
  "/docs/reference/setup/",
  "/api/",
  "/screenshots/",
  "/roadmap/",
  "/get-started/",
];
const failures = [];

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

if (!explicitBaseUrl) {
  staticServer = spawn(
    process.execPath,
    [path.join(scriptDir, "serve-static.mjs"), "--port", String(verificationPort)],
    { stdio: "ignore" }
  );
  await waitForServer(baseUrl);
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
  } catch (error) {
    failures.push(route + " audit failed: " + error.message);
  } finally {
    await page.close();
  }
}

const browser = await chromium.launch({ headless: true });
try {
  for (const route of routes) {
    await auditRoute(browser, route, { width: 1440, height: 1000 });
  }
  for (const route of ["/", "/docs/", "/api/", "/screenshots/"]) {
    await auditRoute(browser, route, { width: 390, height: 844 }, true);
  }

  const interactionPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await interactionPage.goto(baseUrl + "/docs/", { waitUntil: "networkidle" });
  await interactionPage.getByRole("button", { name: /search docs/i }).click();
  await interactionPage.getByPlaceholder(/search partial retry/i).fill("link checker");
  await interactionPage.getByRole("link", { name: /link checker preview/i }).first().waitFor();
  await interactionPage.keyboard.press("Escape");
  if (await interactionPage.getByRole("dialog", { name: /search docs/i }).count()) {
    failures.push("Docs search dialog did not close with Escape");
  }

  await interactionPage.goto(baseUrl + "/screenshots/", { waitUntil: "networkidle" });
  await interactionPage.getByRole("button", { name: /dashboard/i }).first().click();
  await interactionPage.getByRole("dialog", { name: /dashboard/i }).waitFor();
  await interactionPage.getByRole("button", { name: /close screenshot/i }).click();

  await interactionPage.setViewportSize({ width: 390, height: 844 });
  await interactionPage.goto(baseUrl + "/docs/", { waitUntil: "networkidle" });
  await interactionPage.getByRole("button", { name: /open navigation/i }).click();
  await interactionPage.getByRole("dialog", { name: /mobile navigation/i }).waitFor();
  await interactionPage.getByRole("link", { name: /create your first scan/i }).waitFor();
  await interactionPage.getByRole("button", { name: /close navigation/i }).click();
  await interactionPage.close();
} finally {
  await browser.close();
  staticServer?.kill("SIGTERM");
}

if (failures.length) {
  console.error("Browser verification failed:");
  for (const failure of failures) {
    console.error("  - " + failure);
  }
  process.exit(1);
}

console.log("Browser verification passed for desktop, mobile, search, navigation, and screenshot interactions.");
