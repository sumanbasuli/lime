import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverScript = resolve(siteRoot, "scripts/serve-static.mjs");

async function unusedLoopbackPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolveClose, rejectClose) =>
    server.close((error) => (error ? rejectClose(error) : resolveClose()))
  );
  return port;
}

function get(port, path) {
  return new Promise((resolveRequest, rejectRequest) => {
    const client = request({ hostname: "127.0.0.1", port, path, timeout: 3_000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolveRequest({ status: response.statusCode, body }));
    });
    client.on("timeout", () => client.destroy(new Error("Preview request timed out")));
    client.on("error", rejectRequest);
    client.end();
  });
}

for (const basePath of ["", "/lime"]) {
  test(`static preview survives malformed paths with base path ${basePath || "/"}`, { timeout: 10_000 }, async (t) => {
    assert.ok(existsSync(resolve(siteRoot, "out/index.html")), "Build the static docs before testing the preview");
    const port = await unusedLoopbackPort();
    const child = spawn(process.execPath, [serverScript, "--port", String(port), "--host", "127.0.0.1"], {
      cwd: siteRoot,
      env: { ...process.env, LIME_DOCS_BASE_PATH: basePath },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await once(child, "exit");
      }
    });

    await new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(() => rejectReady(new Error(`Preview did not start: ${stderr}`)), 5_000);
      child.stdout.on("data", (chunk) => {
        if (!String(chunk).includes("Serving docs-site/out")) return;
        clearTimeout(timer);
        resolveReady();
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        rejectReady(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        rejectReady(new Error(`Preview exited with ${code}: ${stderr}`));
      });
    });

    const homePath = `${basePath}/`;
    assert.equal((await get(port, homePath)).status, 200);
    assert.equal((await get(port, `${basePath}/missing-preview-page`)).status, 404);
    if (basePath) assert.equal((await get(port, "/")).status, 404);
    for (const malformed of ["%ZZ", "%E0%A4%A"]) {
      const response = await get(port, `${basePath}/${malformed}`);
      assert.equal(response.status, 400);
      assert.equal(response.body, "Bad request");
    }
    assert.equal(child.exitCode, null, "Malformed paths must not stop the preview");
    assert.equal((await get(port, homePath)).status, 200);
  });
}
