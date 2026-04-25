import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const docsSiteRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(docsSiteRoot, "..");
const outputDir = path.join(docsSiteRoot, "public", "brand");

const assets = [
  ["assets/logo/lime.svg", "lime.svg"],
  ["assets/logo/lime.png", "lime.png"],
  ["assets/img/arch.png", "arch.png"],
];

await mkdir(outputDir, { recursive: true });

for (const [source, target] of assets) {
  await copyFile(path.join(repoRoot, source), path.join(outputDir, target));
}
