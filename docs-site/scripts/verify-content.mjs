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
const { siteConfig } = loadSource("lib/site.ts");
const previousBasePath = process.env.LIME_DOCS_BASE_PATH;
process.env.LIME_DOCS_BASE_PATH = "";
try {
  const currentCopyFiles = [
    "app/page.tsx", "app/get-started/page.tsx", "app/roadmap/page.tsx", "app/screenshots/page.tsx",
    "content/api.ts", "content/product-docs.ts", "lib/site.ts", "components/site-footer.tsx",
    "../docs/roadmap.md", "../docs/setup.md", "../docs/database.md", "../docs/architecture/link-checker.md",
  ];
  for (const source of currentCopyFiles) {
    assert.doesNotMatch(readFileSync(path.join(siteRoot, source), "utf8"), /New\s*·\s*unreleased|2\.0\s*·\s*UNRELEASED|current unreleased source|this unreleased source|unreleased source changes|full axe-core ruleset/i, "Stale availability or audit claim: " + source);
  }
  assert.match(siteConfig.description, /broken links/);
  assert.match(siteConfig.description, /AI assistant/);
  const mcpGuide = productDocs.find((doc) => doc.slug.join("/") === "user/mcp");
  for (const client of ["Codex", "Claude Code", "OpenCode 2.x", "OpenCode 1.x (legacy)"]) {
    assert.ok(mcpGuide.markdown.includes(client), "Missing documented MCP client: " + client);
  }
  const mcpTools = [
    "list_scans", "get_scan", "list_scan_issues", "get_issue_detail", "get_report_metadata", "get_settings",
    "list_link_checks", "get_link_check", "get_link_check_stats", "get_scan_link_check", "list_link_check_results", "list_link_check_sources",
    "get_capabilities", "get_workspace_stats", "get_report", "get_screenshot", "get_link_check_export",
    "create_scan", "pause_scan", "resume_scan", "retry_failed_pages", "rescan_scan", "delete_scan", "mark_issue_false_positive",
    "create_link_check", "cancel_link_check", "recheck_link_check", "delete_link_check", "update_settings",
  ];
  assert.equal(mcpTools.length, 29);
  for (const tool of mcpTools) {
    assert.ok(mcpGuide.markdown.includes("`" + tool + "`"), "Missing documented MCP operation: " + tool);
  }
  assert.match(mcpGuide.markdown, /Read-only access is the default, including after an upgrade/);
  assert.match(mcpGuide.markdown, /17 read tools, or 29 tools/);
  assert.match(mcpGuide.markdown, /4 MiB/);
  assert.match(mcpGuide.markdown, /confirm: true/);
  assert.match(mcpGuide.markdown, /request_id/);
  assert.match(mcpGuide.markdown, /reuse that ID with the same arguments/);
  assert.match(mcpGuide.markdown, /outcome is uncertain/);
  const openCodeExamples = [...mcpGuide.markdown.matchAll(/```json\n([\s\S]*?)```/g)]
    .map((match) => JSON.parse(match[1])).filter((example) => example.mcp?.servers?.lime || example.mcp?.lime);
  assert.equal(openCodeExamples.length, 2, "Document both OpenCode configuration generations");
  for (const example of openCodeExamples) {
    const v2 = Boolean(example.mcp.servers);
    const server = v2 ? example.mcp.servers.lime : example.mcp.lime;
    assert.equal(server.type, "remote");
    assert.equal(server.url, "http://localhost:3000/mcp");
    assert.equal(server.headers.Authorization, "Bearer {env:LIME_MCP_KEY}");
    assert.equal(server.oauth, false);
    assert.equal(server[v2 ? "disabled" : "enabled"], !v2);
    assert.equal(v2 ? "enabled" in server : "disabled" in server, false, "Do not mix OpenCode version fields");
  }
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
  assert.ok(pages.every((page) => !page.slug.includes("internal")), "Internal handoff records must not be published");
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
