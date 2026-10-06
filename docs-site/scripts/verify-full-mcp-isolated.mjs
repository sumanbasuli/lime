import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { assertInstalledClientWorkflows, handleFullMcpFixture, verifyFullMcp } from "./verify-full-mcp.mjs";
import { handleLinkFixture } from "./verify-links.mjs";
import { verifyInstalledMcpClients } from "./verify-mcp-installed-clients.mjs";
import { verifyMcpSettingsLock } from "./verify-mcp-settings-lock.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const exec = promisify(execFile);
const arg = (name, fallback) => { const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1]; };
const baseUrl = arg("--base-url", "http://127.0.0.1:14000");
const apiUrl = arg("--api-url", "http://127.0.0.1:19080");
const fixturePort = Number(process.env.LIME_VERIFY_FIXTURE_PORT || 19090);
const installedOnly = process.argv.includes("--installed-only");
const settingsLockOnly = process.argv.includes("--settings-lock-only");
assert.ok(!(installedOnly && settingsLockOnly), "Choose only one focused verification mode");
const fixtureOrigin = process.env.LIME_VERIFY_FIXTURE_ORIGIN || `http://host.docker.internal:${fixturePort}`;
const artifactRoot = path.join(repoRoot, ".artifacts/verification");
const outputDir = path.resolve(arg("--output-dir", path.join(artifactRoot, settingsLockOnly ? "settings-lock-focused" : "full-mcp-focused")));
assert.ok(!path.relative(artifactRoot, outputDir).startsWith(".."), "Focused test evidence stays in the repository's verification artifact folder");
assert.ok(Number.isInteger(fixturePort) && fixturePort >= 1 && fixturePort <= 65535, "Fixture port is valid");
for (const [label, origin, forbidden] of [["dashboard", baseUrl, ["3000", "3001"]], ["backend", apiUrl, ["8080", "8081"]]]) {
  const endpoint = new URL(origin);
  assert.ok(["127.0.0.1", "localhost"].includes(endpoint.hostname) && endpoint.port && !forbidden.includes(endpoint.port), `${label} must use disposable instance ports on loopback`);
}
if (settingsLockOnly) {
  assert.equal(new URL(baseUrl).port, "14000", "Settings lock mode requires the known disposable dashboard port before generating a key");
  assert.equal(new URL(apiUrl).port, "19080", "Settings lock mode requires the known disposable backend port");
}

// Identical axe/manual-review fixture to the complete product runner. Keep four
// unlabeled text inputs and the gradient so scoped failed/review exports are real.
function fixturePage(url) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>LIME verification ${url}</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font:18px sans-serif;line-height:1.6;max-width:800px;margin:48px auto;padding:16px;color:#111;background:#fff}button,input,select{padding:12px;margin:12px;min-width:70px}img{width:80px;height:60px}.fixture-case{margin:20px 0;padding:12px;border:1px solid #ddd}</style></head><body><main>
<h1>LIME verification fixture</h1><p>Controlled test page with known accessibility failures.</p>
${Array.from({ length: 4 }, (_, index) => `<input id="missing-label-${index}">`).join("")}
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

async function request(url, options = {}, expected = 200) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(120_000) });
  assert.equal(response.status, expected, `${options.method || "GET"} ${url}: ${await response.clone().text().then((text) => text.slice(0, 300))}`);
  return response;
}
const json = async (url, options = {}, expected = 200) => (await request(url, options, expected)).json();
const verificationSql = async (statement) => (await exec("docker", ["compose", "-p", "lime-verification", "-f", "docker-compose.docs.yml", "exec", "-T", "db", "psql", "-U", "lime", "-d", "lime_docs_db", "-Atc", statement], { cwd: repoRoot })).stdout.trim();
const requests = new Map();
const fixtureServer = createServer((incoming, response) => {
  const pathname = new URL(incoming.url, fixtureOrigin).pathname;
  requests.set(pathname, (requests.get(pathname) || 0) + 1);
  if (handleLinkFixture(incoming, response, { origin: fixtureOrigin, requests })) return;
  if (handleFullMcpFixture(incoming, response, { origin: fixtureOrigin, renderPage: fixturePage })) return;
  if (pathname === "/pixel.svg") {
    response.writeHead(200, { "Content-Type": "image/svg+xml" });
    response.end('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="#ffed00"/></svg>');
  } else {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(fixturePage(pathname));
  }
});

async function waitForScan(id, statuses = ["completed"], timeout = 180_000) {
  const deadline = Date.now() + timeout;
  let scan;
  while (Date.now() < deadline) {
    scan = await json(`${baseUrl}/api/scans/${id}`);
    if (statuses.includes(scan.status)) return scan;
    assert.notEqual(scan.status, "failed", `Controlled scan unexpectedly failed: ${JSON.stringify(scan)}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Controlled scan timed out: ${JSON.stringify(scan)}`);
}

let browser;
let page;
let fixtureStarted = false;
let outputReady = false;
const browserErrors = [];
let evidence;
try {
  // This focused runner deliberately never starts/stops/cleans a Compose stack.
  // It attaches to the already-running disposable product-verification instance.
  assert.equal(await verificationSql("SELECT current_database()"), "lime_docs_db");
  assert.equal((await json(`${apiUrl}/api/health`)).status, "ok");
  assert.equal((await json(`${baseUrl}/api/health`)).status, "ok");
  await mkdir(outputDir, { recursive: true });
  outputReady = true;
  if (!settingsLockOnly) {
    await new Promise((resolve, reject) => fixtureServer.once("error", reject).listen(fixturePort, "0.0.0.0", resolve));
    fixtureStarted = true;
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(20_000);
    page.on("pageerror", (error) => browserErrors.push(`${page.url()} | ${error.message}`));
    page.on("console", (message) => { if (message.type() === "error") browserErrors.push(`${page.url()} | ${message.text()}`); });
  }
  const navigate = async (route, heading) => {
    assert.equal((await page.goto(baseUrl + route, { waitUntil: "domcontentloaded" }))?.status(), 200);
    if (heading) await page.getByRole("heading", { name: heading, exact: true }).waitFor();
  };
  const restartBackend = !process.argv.includes("--restart-backend") ? undefined : async () => {
    // Explicit operator opt-in; targets only the guarded disposable project.
    await exec("docker", ["compose", "-p", "lime-verification", "-f", "docker-compose.docs.yml", "restart", "shopkeeper"], { cwd: repoRoot });
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (await fetch(`${apiUrl}/api/health`).then((response) => response.ok).catch(() => false)) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("Disposable backend did not recover after the explicitly requested restart");
  };
  if (installedOnly || settingsLockOnly) {
    const previous = await json(`${baseUrl}/api/settings`);
    const settingsOptions = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    try {
      const { mcpKey } = await json(`${baseUrl}/api/settings`, settingsOptions("POST", { action: "generate_mcp_key" }));
      assert.ok(mcpKey, "Focused verification uses a disposable instance key");
      await json(`${baseUrl}/api/settings`, settingsOptions("PUT", { integrations: { mcpEnabled: true, mcpAllowWrites: true } }));
      if (settingsLockOnly) {
        console.log("Checking real PostgreSQL settings contention through canonical MCP...");
        evidence = await verifyMcpSettingsLock({ baseUrl, key: mcpKey });
      } else {
        console.log("Checking installed Codex and OpenCode workflows on the disposable instance...");
        evidence = await verifyInstalledMcpClients({ baseUrl, fixtureOrigin, key: mcpKey, outputDir });
        try {
          assertInstalledClientWorkflows(evidence);
          evidence.status = "passed";
        } catch (error) {
          evidence.status = "incomplete";
          evidence.validationError = error.message;
          process.exitCode = 1;
        }
      }
    } finally {
      await json(`${baseUrl}/api/settings`, settingsOptions("PUT", {
        ...(settingsLockOnly ? { reporting: previous.reporting, performance: previous.performance } : {}),
        integrations: { mcpEnabled: previous.integrations.mcpEnabled, mcpAllowWrites: previous.integrations.mcpAllowWrites },
      }));
    }
  } else {
    evidence = await verifyFullMcp({
      baseUrl, apiUrl, fixtureOrigin, verificationSql, json, request, page, navigate,
      waitForScan, outputDir, requests, restartBackend,
      verifyInstalledClients: process.env.LIME_VERIFY_INSTALLED_CLIENTS === "1" ? verifyInstalledMcpClients : undefined,
    });
  }
  assert.deepEqual(browserErrors, [], "Focused MCP browser journeys have no runtime errors");
  console.log(settingsLockOnly
    ? `Canonical settings lock verification passed. Evidence: ${outputDir}`
    : installedOnly
    ? `Installed-client verification ${evidence.status}. Evidence: ${outputDir}`
    : `Focused full-MCP SDK verification passed (${evidence.evidence.length} phases; inspect installed-client outcomes separately). Evidence: ${outputDir}`);
} catch (error) {
  evidence = { completedAt: new Date().toISOString(), status: "failed", message: error.message };
  if (page) await page.screenshot({ path: path.join(outputDir, "failure.png"), fullPage: true }).catch(() => {});
  throw error;
} finally {
  if (evidence && outputReady) await writeFile(path.join(outputDir, "focused-results.json"), JSON.stringify({ ...evidence, browserErrors }, null, 2));
  await browser?.close();
  if (fixtureStarted) await new Promise((resolve) => fixtureServer.close(resolve));
}
