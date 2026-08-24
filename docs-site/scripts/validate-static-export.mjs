import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const siteRoot = path.resolve(scriptDir, "..");
const outDir = path.join(siteRoot, "out");
const configuredBasePath = (process.env.LIME_DOCS_BASE_PATH || "").trim().replace(/\/$/, "");
const basePath = configuredBasePath === "/" ? "" : configuredBasePath;
const failures = [];

function walk(directory, extension) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return walk(fullPath, extension);
    }
    return !extension || entry.name.endsWith(extension) ? [fullPath] : [];
  });
}

function targetFileForPathname(pathname) {
  let relativePath = decodeURIComponent(pathname);
  if (basePath && relativePath.startsWith(basePath + "/")) {
    relativePath = relativePath.slice(basePath.length);
  } else if (basePath && relativePath === basePath) {
    relativePath = "/";
  }
  relativePath = relativePath.replace(/^\/+/, "");
  if (!relativePath || relativePath.endsWith("/")) {
    return path.join(outDir, relativePath, "index.html");
  }
  if (path.extname(relativePath)) {
    return path.join(outDir, relativePath);
  }
  return path.join(outDir, relativePath, "index.html");
}

if (!existsSync(outDir)) {
  console.error("Static export validation failed: docs-site/out does not exist.");
  process.exit(1);
}

const requiredRoutes = ["/", "/docs/", "/api/", "/screenshots/", "/roadmap/", "/get-started/"];
for (const route of requiredRoutes) {
  const target = targetFileForPathname((basePath || "") + route);
  if (!existsSync(target)) {
    failures.push("Missing required route: " + route);
  }
}

const htmlFiles = walk(outDir, ".html");
for (const htmlFile of htmlFiles) {
  const html = readFileSync(htmlFile, "utf8");
  const relativeHtml = path.relative(outDir, htmlFile);
  const pagePath = relativeHtml === "index.html"
    ? "/"
    : "/" + relativeHtml.replace(/index\.html$/, "").replaceAll(path.sep, "/");
  const pageUrl = new URL((basePath || "") + pagePath, "https://lime.local");
  const attributes = html.matchAll(/\b(?:href|src)="([^"]+)"/g);

  for (const match of attributes) {
    const value = match[1];
    if (!value || /^(?:https?:|mailto:|tel:|data:|javascript:|#)/.test(value)) {
      continue;
    }
    const resolved = new URL(value, pageUrl);
    if (resolved.origin !== "https://lime.local") {
      continue;
    }
    const target = targetFileForPathname(resolved.pathname);
    if (!existsSync(target)) {
      failures.push(relativeHtml + " -> missing " + value);
    }
  }
}

const screenshotNames = [
  "dashboard.png",
  "new-scan.png",
  "scan-detail.png",
  "partial-retry.png",
  "issues.png",
  "expanded-issue.png",
  "reports.png",
  "settings.png",
  "link-checker.png",
];
for (const name of screenshotNames) {
  const screenshotPath = path.join(outDir, "product-screenshots", name);
  if (!existsSync(screenshotPath)) {
    failures.push("Missing product screenshot: " + name);
    continue;
  }
  if (statSync(screenshotPath).size < 10_000) {
    failures.push("Product screenshot is unexpectedly small: " + name);
  }
}

if (failures.length) {
  console.error("Static export validation failed:");
  for (const failure of [...new Set(failures)]) {
    console.error("  - " + failure);
  }
  process.exit(1);
}

console.log("Static export validated: " + htmlFiles.length + " HTML pages, internal assets, and product screenshots.");
