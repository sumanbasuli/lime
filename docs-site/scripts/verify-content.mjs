import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nodeRequire = createRequire(import.meta.url);
const modules = new Map();

// Execute the real build-time TS helpers without adding a second renderer.
function loadSource(relativePath) {
  const filename = path.join(siteRoot, relativePath);
  if (modules.has(filename)) return modules.get(filename);
  const exports = {};
  modules.set(filename, exports);
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filename,
  }).outputText;
  vm.runInNewContext(compiled, {
    exports, process, URL,
    require(specifier) {
      return specifier.startsWith("@/")
        ? loadSource(specifier.slice(2) + ".ts")
        : nodeRequire(specifier);
    },
  }, { filename });
  return exports;
}

const { renderMarkdown } = loadSource("lib/markdown.ts");
const { getAllDocPages, getAdjacentDocPages } = loadSource("lib/docs.ts");
const { navigationGroups } = loadSource("content/navigation.ts");
const { productDocs } = loadSource("content/product-docs.ts");
const previousBasePath = process.env.LIME_DOCS_BASE_PATH;
process.env.LIME_DOCS_BASE_PATH = "";
try {
  assert.equal(renderMarkdown("`[literal](https://example.com)`"), "<p><code>[literal](https://example.com)</code></p>");
  assert.match(renderMarkdown("[query](https://example.com/?a=1&b=2)"), /href="https:\/\/example\.com\/\?a=1&amp;b=2"/);
  assert.doesNotMatch(renderMarkdown("[query](https://example.com/?a=1&b=2)"), /amp;amp/);
  assert.match(renderMarkdown("[home](index.md)", ["reference", "setup"]), /href="\/docs\/reference"/);
  assert.match(renderMarkdown("[setup](..\/setup.md)", ["reference", "deployment", "docker"]), /href="\/docs\/reference\/setup"/);
  assert.match(renderMarkdown("[user](https://lime.heysuman.com/docs/user/)"), /href="\/docs\/user\/"/);
  assert.match(renderMarkdown("# Test\n\n```json\n{ \"Authorization\": \"Bearer ${LIME_MCP_KEY}\" }\n```"), /Bearer \$\{LIME_MCP_KEY\}/);
  const headings = renderMarkdown("## Same\n\n## Same\n\n## Same-2");
  const ids = [...headings.matchAll(/id="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(renderMarkdown("- Parent\n  - Child\n- Sibling"), "<ul><li>Parent<ul><li>Child</li></ul></li><li>Sibling</li></ul>");
  process.env.LIME_DOCS_BASE_PATH = "/lime";
  assert.match(renderMarkdown("[user](https://lime.heysuman.com/docs/user/)"), /href="\/lime\/docs\/user\/"/);
  process.env.LIME_DOCS_BASE_PATH = "";

  const pages = getAllDocPages();
  const links = navigationGroups.flatMap((group) => [group.href, ...group.items.map((item) => item.href)]);
  assert.equal(new Set(pages.map((page) => page.href)).size, pages.length, "Duplicate documentation route");
  for (const page of pages) assert.ok(links.includes(page.href), "Page missing from navigation: " + page.href);
  for (const href of links.filter((value) => value.startsWith("/docs"))) {
    assert.ok(pages.some((page) => page.href === href), "Navigation points to missing page: " + href);
  }
  for (const doc of productDocs) {
    assert.equal(doc.markdown.split("\n").filter((line) => line.startsWith("```")).length % 2, 0, "Unclosed code example: " + doc.title);
    assert.equal([...renderMarkdown(doc.markdown, doc.slug).matchAll(/<h1(?:\s|>)/g)].length, 1, "Expected one page title: " + doc.title);
    for (const source of doc.sourceFiles ?? []) {
      assert.ok(existsSync(path.join(siteRoot, "..", source)), "Missing source reference: " + source);
    }
  }
  let exampleCount = 0;
  for (const page of pages) {
    const markdown = page.sourcePath.endsWith("product-docs.ts")
      ? productDocs.find((doc) => doc.slug.join("/") === page.slug.join("/")).markdown
      : readFileSync(page.sourcePath, "utf8");
    assert.equal(markdown.split("\n").filter((line) => line.startsWith("```")).length % 2, 0, "Unclosed code example: " + page.title);
    for (const match of markdown.matchAll(/```(json|bash)\n([\s\S]*?)```/g)) {
      if (match[1] === "json") {
        assert.doesNotThrow(() => JSON.parse(match[2]), "Invalid JSON example: " + page.title);
      } else {
        const syntax = spawnSync("bash", ["-n"], { input: match[2], encoding: "utf8" });
        assert.equal(syntax.status, 0, "Invalid shell example in " + page.title + ": " + syntax.stderr);
      }
      exampleCount += 1;
    }
  }
  const firstScan = pages.find((page) => page.href === "/docs/user/first-scan");
  assert.equal(getAdjacentDocPages(firstScan).nextPage.href, "/docs/user/dashboard");
  const lastUser = pages.find((page) => page.href === "/docs/user/link-checker");
  assert.equal(getAdjacentDocPages(lastUser).nextPage, null, "User reading path must not jump to operator internals");
  console.log("Docs content verified: " + pages.length + " guides, " + exampleCount + " JSON/shell examples, complete navigation, audience reading order, and Markdown regressions.");
} finally {
  if (previousBasePath === undefined) delete process.env.LIME_DOCS_BASE_PATH;
  else process.env.LIME_DOCS_BASE_PATH = previousBasePath;
}
