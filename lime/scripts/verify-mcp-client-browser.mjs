import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Use the repository's existing browser dependency; do not install or launch
// any MCP client. This check only reads settings and copies placeholder text.
const require = createRequire(new URL("../../docs-site/package.json", import.meta.url));
const { chromium } = require("playwright");
const args = process.argv.slice(2);
const readArg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || fallback : fallback;
};
const base = new URL(readArg("--base-url", "http://127.0.0.1:15000"));
assert.ok(["http:", "https:"].includes(base.protocol), "Use an HTTP dashboard URL");
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(base.hostname), "Only an isolated loopback dashboard is supported");
assert.equal(base.pathname, "/", "Use the dashboard origin without a path");
assert.equal(base.username + base.password + base.search + base.hash, "", "Do not pass credentials or query strings");
const artifactDir = path.resolve(readArg("--output-dir", fileURLToPath(new URL("../../.artifacts/verification", import.meta.url))));
const endpoint = new URL("/mcp", base).href;
const checks = [];
const mutations = [];
const browserErrors = [];
const options = [
  { value: "codex", label: "Codex", format: "TOML", docs: "https://learn.chatgpt.com/docs/extend/mcp?surface=cli" },
  { value: "claude-code", label: "Claude Code", format: "POSIX shell", docs: "https://code.claude.com/docs/en/mcp#option-1-add-a-remote-http-server" },
  { value: "opencode", label: "OpenCode 2.x", format: "JSON", docs: "https://opencode.ai/v2/docs/mcp-servers" },
  { value: "opencode-legacy", label: "OpenCode 1.x", format: "JSON", docs: "https://opencode.ai/docs/mcp-servers/" },
];
async function readSettings() {
  const response = await fetch(new URL("/api/settings", base), { signal: AbortSignal.timeout(10_000) });
  assert.ok(response.ok, `Settings read returned HTTP ${response.status}`);
  return response.json();
}
function verifyConfiguration(option, text) {
  assert.ok(text.includes(endpoint), `${option.label} uses the dashboard's canonical endpoint`);
  if (option.value === "codex") {
    assert.ok(text.includes("[mcp_servers.lime]"));
    assert.ok(text.includes('bearer_token_env_var = "LIME_MCP_KEY"'));
    assert.ok(!text.includes("<YOUR_MCP_KEY>"), "Codex TOML keeps the key in the environment");
  } else if (option.value === "claude-code") {
    assert.ok(text.startsWith("claude mcp add --transport http lime "));
    assert.ok(text.includes("--header 'Authorization: Bearer <YOUR_MCP_KEY>'"));
  } else {
    const config = JSON.parse(text);
    const legacy = option.value === "opencode-legacy";
    const server = legacy ? config.mcp.lime : config.mcp.servers.lime;
    assert.equal(server.type, "remote");
    assert.equal(server.url, endpoint);
    assert.equal(server.headers.Authorization, "Bearer <YOUR_MCP_KEY>");
    assert.equal(server.oauth, false);
    assert.equal(legacy ? server.enabled : server.disabled, legacy);
    assert.equal(config.$schema, legacy ? "https://opencode.ai/config.json" : undefined);
  }
}
let browser;
let context;
let page;
let initialSettings;
let failure;
try {
  await mkdir(artifactDir, { recursive: true });
  initialSettings = await readSettings();
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, permissions: ["clipboard-read", "clipboard-write"] });
  // Prevent accidental settings saves/key generation even if the UI regresses.
  await context.route("**/*", async (route) => {
    const request = route.request();
    if (!["GET", "HEAD"].includes(request.method())) {
      mutations.push({ method: request.method(), path: new URL(request.url()).pathname });
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  page = await context.newPage();
  page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400) browserErrors.push(`HTTP ${response.status()}: ${new URL(response.url()).pathname}`);
  });
  const response = await page.goto(new URL("/settings", base).href, { waitUntil: "networkidle", timeout: 30_000 });
  assert.ok(response?.ok(), "Settings page loads successfully");
  await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
  assert.ok((await page.locator("body").innerText()).trim().length > 100, "Settings has meaningful content");
  assert.equal(await page.locator("[data-nextjs-dialog], .vite-error-overlay, #webpack-dev-server-client-overlay").count(), 0);
  const selector = page.getByRole("combobox", { name: "MCP client configuration" });
  await selector.waitFor();
  assert.deepEqual(await selector.locator("option").evaluateAll((elements) => elements.map((element) => element.value)), options.map((option) => option.value));
  assert.equal(await selector.getAttribute("aria-describedby"), "mcp-client-instructions mcp-client-key-note");
  await selector.focus();
  assert.equal(await selector.evaluate((element) => document.activeElement === element), true, "Selector is keyboard-focusable");
  for (const option of options) {
    await selector.selectOption(option.value);
    const pre = page.locator(`pre[aria-label="${option.label} ${option.format} configuration"]`);
    const config = await pre.innerText();
    verifyConfiguration(option, config);
    assert.equal(await page.getByRole("link", { name: "Official client instructions" }).getAttribute("href"), option.docs);
    const button = page.getByRole("button", { name: `Copy ${option.label} config`, exact: true });
    await button.click();
    await page.getByRole("status").filter({ hasText: `${option.label} config copied.` }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), config, `${option.label} copies precisely the displayed config`);
    if (option.value === "codex") {
      const command = await page.locator('pre[aria-label="Codex key environment command"]').innerText();
      assert.equal(command, "export LIME_MCP_KEY='<YOUR_MCP_KEY>'");
      await page.getByRole("button", { name: "Copy key environment command", exact: true }).click();
      await page.getByRole("status").filter({ hasText: "Key environment command copied." }).waitFor();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), command);
    }
    checks.push({ client: option.value, copiedDisplayedConfig: true, officialDocsLinked: true });
  }
  await selector.selectOption("opencode");
  const card = selector.locator("..");
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1100 });
    await card.scrollIntoViewIfNeeded();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `Settings has no horizontal overflow at ${width}px (actual ${overflow}px)`);
    const box = await page.getByRole("button", { name: "Copy OpenCode 2.x config", exact: true }).boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1, `Copy control is within the ${width}px viewport`);
    await card.screenshot({ path: path.join(artifactDir, `mcp-client-config-${width}.png`) });
    checks.push({ width, overflow, copyControlInViewport: true });
  }
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: async () => { throw new DOMException("Clipboard access denied", "NotAllowedError"); },
    });
  });
  await page.getByRole("button", { name: "Copy OpenCode 2.x config", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Copy failed. Select the displayed text and copy it manually." }).waitFor();
  checks.push({ clipboardDeniedManualCopyFeedback: true });
  assert.deepEqual(mutations, [], "Choosing and copying clients never sends a write request");
  assert.deepEqual(browserErrors, [], "No rendering, console, or HTTP errors");
} catch (error) {
  failure = error;
  if (page) await page.screenshot({ path: path.join(artifactDir, "mcp-client-config-failure.png") }).catch(() => {});
} finally {
  if (initialSettings) {
    try {
      assert.deepEqual(await readSettings(), initialSettings, "Saved settings remain unchanged");
      checks.push({ savedSettingsUnchanged: true, mutationRequests: mutations.length });
    } catch (error) {
      failure ||= error;
    }
  }
  await context?.close();
  await browser?.close();
  await writeFile(path.join(artifactDir, "mcp-client-config-browser-results.json"), JSON.stringify({ passed: !failure, checks, mutations, browserErrors, error: failure?.message || null }, null, 2) + "\n");
}
if (failure) throw failure;
console.log(`MCP client browser verification passed: ${checks.length} checks, zero write requests, settings unchanged.`);
