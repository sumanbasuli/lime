import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import http2 from "node:http2";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import tls from "node:tls";
import { promisify } from "node:util";
import vm from "node:vm";

const run = promisify(execFile);
const nginx = process.env.LIME_TEST_NGINX;
const deadlineMs = 3_000;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quote = (value) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

async function originGuard() {
  const require = createRequire(new URL("../package.json", import.meta.url));
  const ts = require("typescript");
  const source = await readFile(new URL("../src/lib/ordinary-api-origin.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, URL, Response });
  return exports.rejectCrossOriginWrite;
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function freePort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function rawRequest(port, secure, { method = "GET", target = "/fixture", version = "HTTP/1.1", headers = ["Host: lime.example.com"] } = {}) {
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host: "127.0.0.1", port, servername: "lime.example.com", rejectUnauthorized: false, ALPNProtocols: ["http/1.1"] })
      : net.connect({ host: "127.0.0.1", port });
    const chunks = [];
    const timer = setTimeout(() => socket.destroy(new Error("HTTP fixture request timed out")), deadlineMs);
    socket.once(secure ? "secureConnect" : "connect", () => {
      socket.write(`${method} ${target} ${version}\r\n${[...headers, "Connection: close", "Content-Length: 0"].join("\r\n")}\r\n\r\n`);
    });
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", (error) => {
      if (error.code !== "ECONNRESET") reject(error);
    });
    socket.on("close", () => {
      clearTimeout(timer);
      const response = Buffer.concat(chunks).toString();
      const status = /^HTTP\/1\.[01] (\d+)/.exec(response)?.[1];
      resolve({ status: status && Number(status), body: response.split("\r\n\r\n").slice(1).join("\r\n\r\n") });
    });
  });
}

function h2Request(port, headers) {
  return new Promise((resolve, reject) => {
    const client = http2.connect(`https://127.0.0.1:${port}`, { servername: "lime.example.com", rejectUnauthorized: false });
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error("HTTP/2 fixture request timed out"));
    }, deadlineMs);
    client.once("error", reject);
    client.once("connect", () => {
      if (client.alpnProtocol !== "h2") {
        client.destroy();
        reject(new Error("Fixture did not negotiate HTTP/2"));
        return;
      }
      const request = client.request({ ":method": "GET", ":path": "/fixture", ...headers });
      let status;
      const chunks = [];
      request.on("response", (response) => { status = response[":status"]; });
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("error", (error) => {
        if (error.code !== "ERR_HTTP2_STREAM_ERROR") reject(error);
      });
      request.once("close", () => {
        clearTimeout(timer);
        client.destroy();
        resolve({ status, body: Buffer.concat(chunks).toString() });
      });
      request.end();
    });
    client.once("close", () => clearTimeout(timer));
  });
}

async function ready(child, pidPath, port) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    assert.equal(child.exitCode, null, "owned nginx exited before readiness");
    assert.equal(child.signalCode, null, "owned nginx was signaled before readiness");
    try {
      assert.equal(Number((await readFile(pidPath, "utf8")).trim()), child.pid, "nginx pid file must identify the owned child");
      await new Promise((resolve, reject) => {
        const socket = net.connect({ host: "127.0.0.1", port });
        socket.setTimeout(100, () => socket.destroy(new Error("Listener not ready")));
        socket.once("error", reject);
        socket.once("connect", () => { socket.destroy(); resolve(); });
      });
      return;
    } catch {
      await wait(25);
    }
  }
  throw new Error("Owned nginx pid/listener did not become ready");
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  const timer = setTimeout(() => child.kill("SIGKILL"), deadlineMs);
  child.kill("SIGTERM");
  try { await exited; } finally { clearTimeout(timer); }
}

test("isolated nginx Host/Origin regression suite", {
  skip: !nginx && "Set LIME_TEST_NGINX to an absolute nginx binary path to run live fixtures",
  timeout: 90_000,
}, async (t) => {
  assert.ok(isAbsolute(nginx), "LIME_TEST_NGINX must be an absolute binary path");
  await access(nginx);
  const { stderr: version } = await run(nginx, ["-V"], { timeout: deadlineMs });
  assert.match(version, /--with-http_ssl_module\b/, "Live suite requires nginx's SSL module");
  const hasHttp2 = /--with-http_v2_module\b/.test(version);
  t.diagnostic(version.trim());
  const rejectWrite = await originGuard();
  const sample = await readFile(new URL("../../deploy/debian/nginx.conf.example", import.meta.url), "utf8");
  const prefix = await mkdtemp(join(tmpdir(), "lime-nginx-"));
  const fixtureId = randomUUID();
  let upstreamCount = 0;
  const upstream = http.createServer((req, res) => {
    upstreamCount++;
    req.resume();
    const headers = new Headers(Object.entries(req.headers).filter(([, value]) => typeof value === "string"));
    const rejection = rejectWrite(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers }));
    const body = JSON.stringify({ fixtureId, host: req.headers.host, proto: req.headers["x-forwarded-proto"], origin: req.headers.origin });
    res.writeHead(rejection?.status ?? 200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
    res.end(body);
  });
  try {
    const upstreamPort = await listen(upstream);
    await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(prefix, "key.pem"), "-out", join(prefix, "cert.pem"), "-days", "1", "-subj", "/CN=lime.example.com"], { timeout: 15_000 });
    for (const secure of [false, true]) {
      await t.test(secure ? "HTTPS" : "HTTP", async (suite) => {
        const port = await freePort();
        const scheme = secure ? "https" : "http";
        const configPath = join(prefix, `${scheme}.conf`);
        const pidPath = join(prefix, `${scheme}.pid`);
        const logPath = join(prefix, `${scheme}.log`);
        const replaceOnce = (source, from, to) => {
          assert.equal(source.split(from).length, 2, `Expected one fixture substitution: ${from}`);
          return source.replace(from, to);
        };
        // The listen parameter also supports maintained nginx builds older than 1.25.1.
        let server = replaceOnce(sample, "    listen 80;", `    listen 127.0.0.1:${port}${secure ? ` ssl${hasHttp2 ? " http2" : ""}` : ""};`);
        server = replaceOnce(server, "http://127.0.0.1:3000", `http://127.0.0.1:${upstreamPort}`);
        if (secure) server = replaceOnce(server, "    server_name lime.example.com;", `    server_name lime.example.com;\n    ssl_certificate ${quote(join(prefix, "cert.pem"))};\n    ssl_certificate_key ${quote(join(prefix, "key.pem"))};`);
        await writeFile(configPath, `pid ${quote(pidPath)};\nerror_log ${quote(logPath)} notice;\nevents {}\nhttp { access_log off;\n${server}\n}\n`, { mode: 0o600 });
        const args = ["-p", `${prefix}/`, "-c", configPath, "-e", logPath, "-g", "daemon off; master_process off;"];
        suite.diagnostic((await run(nginx, [...args, "-t"], { timeout: deadlineMs })).stderr.trim());
        const child = spawn(nginx, args, { stdio: ["ignore", "ignore", "pipe"] });
        let childOutput = "";
        child.stderr.on("data", (chunk) => { childOutput += chunk; });
        const childFailure = new Promise((_, reject) => child.once("error", reject));
        try {
          await Promise.race([ready(child, pidPath, port), childFailure]);
          const probe = async (options, expected = 200) => {
            const before = upstreamCount;
            const response = await rawRequest(port, secure, options);
            assert.equal(child.exitCode, null, "Owned nginx must remain running");
            assert.equal(child.signalCode, null);
            if (expected === "blocked") {
              assert.ok(response.status === undefined || [400, 421].includes(response.status), `Expected nginx rejection, got ${response.status}`);
              assert.equal(upstreamCount, before, "Rejected Host must never reach upstream");
            } else {
              assert.equal(response.status, expected);
              assert.equal(upstreamCount, before + 1);
              const echo = JSON.parse(response.body);
              assert.equal(echo.fixtureId, fixtureId, "Response must come from this fixture");
              assert.equal(echo.proto, scheme, "nginx must replace client protocol metadata");
              return echo;
            }
          };
          for (const host of ["lime.example.com", "LIME.EXAMPLE.COM", `lime.example.com:${port}`]) {
            await suite.test(`preserves allowed raw Host ${host}`, async () => {
              assert.equal((await probe({ headers: [`Host: ${host}`] })).host, host);
            });
          }
          for (const host of ["foreign.test", "lime.example.com.evil.test", "evil.lime.example.com", "limeXexampleYcom", "lime.example.com.", "lime.example.com:word", "lime.example.com:", "lime.example.com@evil.test"]) {
            await suite.test(`blocks Host ${host}`, () => probe({ headers: [`Host: ${host}`] }, "blocked"));
          }
          for (const [name, options] of [
            ["missing HTTP/1.0 Host", { version: "HTTP/1.0", headers: [] }],
            ["missing HTTP/1.1 Host", { headers: [] }],
            ["empty Host", { headers: ["Host:"] }],
            ["duplicate Host", { headers: ["Host: lime.example.com", "Host: foreign.test"] }],
            ["duplicate identical Host", { headers: ["Host: lime.example.com", "Host: lime.example.com"] }],
            ["foreign absolute-form target", { target: "http://foreign.test/fixture" }],
            ["foreign raw Host with allowed absolute target", { target: "http://lime.example.com/fixture", headers: ["Host: foreign.test"] }],
            ["allowed absolute target without Host", { target: "http://lime.example.com/fixture", version: "HTTP/1.0", headers: [] }],
          ]) await suite.test(`blocks ${name}`, () => probe(options, "blocked"));
          await suite.test("allows same-host absolute-form target", () => probe({ target: "http://lime.example.com/fixture" }));
          const write = (host, extra = []) => ({ method: "POST", headers: [`Host: ${host}`, ...extra] });
          for (const [name, options, status] of [
            ["same-origin write", write("lime.example.com", [`Origin: ${scheme}://lime.example.com`, "Sec-Fetch-Site: same-origin"]), 200],
            ["custom-port write", write(`lime.example.com:${port}`, [`Origin: ${scheme}://lime.example.com:${port}`]), 200],
            ["explicit default-port write", write(`lime.example.com:${secure ? 443 : 80}`, [`Origin: ${scheme}://lime.example.com`]), 200],
            ["Origin-free CLI write", write("lime.example.com"), 200],
            ["foreign Origin", write("lime.example.com", ["Origin: https://foreign.test"]), 403],
            ["null Origin", write("lime.example.com", ["Origin: null"]), 403],
            ["empty Origin", write("lime.example.com", ["Origin:"]), 403],
            ["wrong Origin scheme", write("lime.example.com", [`Origin: ${secure ? "http" : "https"}://lime.example.com`]), 403],
            ["wrong Origin port", write(`lime.example.com:${port}`, [`Origin: ${scheme}://lime.example.com`]), 403],
            ["cross-site metadata", write("lime.example.com", [`Origin: ${scheme}://lime.example.com`, "Sec-Fetch-Site: cross-site"]), 403],
            ["cross-site without Origin", write("lime.example.com", ["Sec-Fetch-Site: cross-site"]), 403],
            ["same-site without Origin", write("lime.example.com", ["Sec-Fetch-Site: same-site"]), 403],
            ["spoofed proxy protocol", write("lime.example.com", [`Origin: ${scheme}://lime.example.com`, `X-Forwarded-Proto: ${secure ? "http" : "https"}`]), 200],
            ["foreign-Origin read", { headers: ["Host: lime.example.com", "Origin: https://foreign.test"] }, 200],
          ]) await suite.test(name, () => probe(options, status));
          if (secure) await suite.test("HTTP/2 authority", { skip: !hasHttp2 && "nginx lacks --with-http_v2_module" }, async (h2) => {
            for (const [name, headers, expected] of [
              ["allowed authority", { ":authority": "lime.example.com" }, 200],
              ["custom-port same-origin write", { ":method": "POST", ":authority": `lime.example.com:${port}`, origin: `https://lime.example.com:${port}` }, 200],
              ["foreign authority", { ":authority": "foreign.test" }, "blocked"],
              ["mismatched authority and Host", { ":authority": "lime.example.com", host: "foreign.test" }, "blocked"],
            ]) await h2.test(name, async () => {
              const before = upstreamCount;
              const response = await h2Request(port, headers);
              assert.equal(child.exitCode, null);
              assert.equal(child.signalCode, null);
              if (expected === "blocked") {
                assert.ok(response.status === undefined || [400, 421].includes(response.status));
                assert.equal(upstreamCount, before, "Rejected HTTP/2 authority must never reach upstream");
              } else {
                assert.equal(response.status, expected);
                assert.equal(upstreamCount, before + 1);
                const echo = JSON.parse(response.body);
                assert.equal(echo.fixtureId, fixtureId);
                assert.equal(echo.host, headers[":authority"]);
                assert.equal(echo.proto, "https");
              }
            });
          });
        } catch (error) {
          suite.diagnostic(`${childOutput}\n${await readFile(logPath, "utf8").catch(() => "")}`);
          throw error;
        } finally {
          await stop(child);
        }
      });
    }
  } finally {
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(prefix, { recursive: true, force: true });
  }
});
