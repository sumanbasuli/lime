import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { READ_TOOLS, WRITE_TOOLS } from "../scripts/openclaw-config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../workspace");
async function files(directory) {
  return (await Promise.all((await readdir(directory, { withFileTypes: true })).map(async (entry) => entry.isDirectory()
    ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]))).flat();
}

test("all three skill entrypoints have valid discriminating frontmatter and resolve local references", async () => {
  const names = ["lime-audit", "lime-operations", "lime-evidence"];
  for (const name of names) {
    const directory = path.join(root, "skills", name);
    const content = await readFile(path.join(directory, "SKILL.md"), "utf8");
    assert.match(content, new RegExp(`^---\\nname: ${name}\\ndescription: .{50,}\\n---\\n`));
    assert.ok(content.length < 12_000, "Entrypoint remains concise");
    for (const match of content.matchAll(/\]\((references\/[^)]+)\)/g)) {
      const target = path.resolve(directory, match[1]);
      assert.ok(target.startsWith(directory + path.sep));
      assert.ok((await stat(target)).isFile());
    }
  }
});

test("workflow skills cover all known MCP operations without credential literals", async () => {
  const skillFiles = await files(path.join(root, "skills"));
  const content = (await Promise.all(skillFiles.map((file) => readFile(file, "utf8")))).join("\n");
  for (const name of [...READ_TOOLS, ...WRITE_TOOLS]) assert.ok(content.includes("`" + name + "`"), `Missing workflow guidance: ${name}`);
  assert.match(content, /request_id/);
  assert.match(content, /same-ID recovery/);
  assert.match(content, /confirm: true/);
  assert.match(content, /untrusted evidence/);
  assert.match(content, /4 MiB/);
  assert.match(content, /no generator is exposed/);
  assert.doesNotMatch(content, /lime_mcp_[a-zA-Z0-9]{12,}|Bearer [a-zA-Z0-9_-]{12,}/);
});

test("template has no mutable auth/session data or symlink-dependent skill roots", async () => {
  const all = await files(root);
  assert.ok(all.every((file) => /\.md$/.test(file)), "Only plain workspace and skill instructions ship");
  assert.ok(all.every((file) => !/auth-profiles|models\.json|sessions\/|node_modules\//.test(file)));
  assert.ok((await readFile(path.join(root, "AGENTS.md"), "utf8")).includes("No autonomous heartbeat"));
});
