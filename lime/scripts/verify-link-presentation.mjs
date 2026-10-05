import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(new URL("../package.json", import.meta.url));
const ts = require("typescript");
const source = await readFile(new URL("../src/lib/link-presentation.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const exports = {};
// Type-only icon imports disappear: this exercises the actual helper with no React or network.
vm.runInNewContext(compiled, { exports, URL });
const { getLinkPresentation } = exports;

const iconSource = await readFile(new URL("../src/components/bootstrap-icon.tsx", import.meta.url), "utf8");
const iconCompiled = ts.transpileModule(iconSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const iconExports = {};
vm.runInNewContext(iconCompiled, { exports: iconExports, require });
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

test("local Bootstrap SVGs are decorative, scalable, and require no remote assets", () => {
  for (const name of ["linkedin", "github", "wordpress", "twitter-x", "facebook", "instagram", "youtube", "globe2", "image", "code-slash", "chevron-down", "shield-lock"]) {
    const html = renderToStaticMarkup(createElement(iconExports.BootstrapIcon, { name, size: 24, className: "destination-icon" }));
    assert.match(html, /<svg\b/);
    assert.match(html, /width="24" height="24"/);
    assert.match(html, /viewBox="0 0 16 16"/);
    assert.match(html, /fill="currentColor"/);
    assert.match(html, /class="destination-icon"/);
    assert.match(html, /aria-hidden="true" focusable="false"/);
    assert.match(html, /<path\b/);
    assert.doesNotMatch(html, /<(?:img|image|use|foreignObject|script)\b|href=|onload=/);
  }
});

test("recognized social destinations use selected Bootstrap brand icons", () => {
  for (const [url, icon, label] of [
    ["https://www.linkedin.com/in/user", "linkedin", "LinkedIn"],
    ["https://gist.github.com/user/example", "github", "GitHub"],
    ["https://developer.wordpress.org/reference/", "wordpress", "WordPress"],
    ["https://example.wordpress.com/", "wordpress", "WordPress"],
    ["https://x.com/user", "twitter-x", "X / Twitter"],
    ["https://twitter.com/user", "twitter-x", "X / Twitter"],
    ["https://www.facebook.com/page", "facebook", "Facebook"],
    ["https://www.instagram.com/user/", "instagram", "Instagram"],
    ["https://youtu.be/123", "youtube", "YouTube"],
  ]) {
    const result = getLinkPresentation(url);
    assert.equal(result.icon, icon);
    assert.equal(result.label, label);
    assert.equal(result.brand, true);
  }
});

test("host matching is exact or dot-delimited, not substring or userinfo", () => {
  for (const url of [
    "https://linkedin.com.evil.test/in/user",
    "https://notlinkedin.com/",
    "https://github.com.evil.test/",
    "https://x.company.test/",
    "https://wordpress.example.test/",
    "https://linkedin.com@evil.test/",
    "https://evil.test/?redirect=https://linkedin.com/",
    "https://evil.test/#https://github.com",
  ]) {
    const result = getLinkPresentation(url);
    assert.equal(result.brand, false, url);
    assert.equal(result.icon, "globe2", url);
  }
  assert.equal(getLinkPresentation("https://WWW.LINKEDIN.COM.:443/in/user").icon, "linkedin");
  assert.equal(getLinkPresentation("https://evil.test@linkedin.com/in/user").hostname, "linkedin.com");
});

test("generic hosts, IPv6, and localhost are retained without inventing brands", () => {
  for (const [url, hostname] of [
    ["https://www.example.com/page", "www.example.com"],
    ["http://localhost:3000/", "localhost"],
    ["http://[::1]:8080/path", "[::1]"],
    ["https://user.github.io/", "user.github.io"],
  ]) {
    const result = getLinkPresentation(url);
    assert.equal(result.hostname, hostname);
    assert.equal(result.label, hostname);
    assert.equal(result.brand, false);
  }
});

test("paths preserve full long queries, repeated parameters, encoding, and fragments", () => {
  const suffix = `/download/%E2%9C%93?item=first&item=second&token=${"a".repeat(4096)}#details`;
  const result = getLinkPresentation(`https://example.com${suffix}`);
  assert.equal(result.path, suffix);
  assert.equal(getLinkPresentation("https://example.com").path, "/");
});

test("invalid and non-HTTP URLs remain plain generic presentation", () => {
  for (const rawUrl of ["", "not a url", "/relative/path", "mailto:hello@example.com", "tel:123", "javascript:alert(1)", "data:image/png;base64,AAA", "ftp://linkedin.com/file"]) {
    const result = getLinkPresentation(rawUrl, "media");
    assert.equal(result.hostname, "");
    assert.equal(result.label, "Link");
    assert.equal(result.path, rawUrl);
    assert.equal(result.brand, false);
    assert.equal(result.icon, "link-45deg");
  }
});

test("resource fallbacks distinguish code, images, PDFs, and other media", () => {
  for (const [pathname, type, icon] of [
    ["/assets/style.CSS?v=123", "media", "code-slash"],
    ["/script.mjs?module=1", "media", "code-slash"],
    ["/image.webp?size=100", "media", "image"],
    ["/manual.PDF#page=2", "document", "file-earmark-pdf"],
    ["/font.woff2", "media", "file-earmark-text"],
    ["/video.mp4", "media", "file-earmark-text"],
    ["/download", "document", "file-earmark-text"],
    ["/page?file=cover.png", "external", "globe2"],
  ]) assert.equal(getLinkPresentation(`https://example.com${pathname}`, type).icon, icon, pathname);
});
