import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = resolve(fileURLToPath(import.meta.url), "..");
const siteRoot = resolve(scriptDir, "..");
const outDir = resolve(siteRoot, "out");

const args = process.argv.slice(2);
const portArgIndex = args.indexOf("--port");
const port =
  Number(portArgIndex >= 0 ? args[portArgIndex + 1] : process.env.PORT) || 3001;

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function resolveStaticPath(urlPath) {
  const decodedPath = decodeURIComponent(urlPath.split("?")[0] || "/");
  const normalizedPath = normalize(decodedPath).replace(/^(\.\.[/\\])+/, "");
  const cleanPath = normalizedPath === "/" ? "/index.html" : normalizedPath;
  const directPath = resolve(join(outDir, cleanPath));

  if (relative(outDir, directPath).startsWith("..")) {
    return null;
  }

  if (existsSync(directPath) && statSync(directPath).isFile()) {
    return directPath;
  }

  const indexPath = resolve(join(outDir, cleanPath, "index.html"));
  if (
    !relative(outDir, indexPath).startsWith("..") &&
    existsSync(indexPath) &&
    statSync(indexPath).isFile()
  ) {
    return indexPath;
  }

  const htmlPath = resolve(join(outDir, `${cleanPath}.html`));
  if (
    !relative(outDir, htmlPath).startsWith("..") &&
    existsSync(htmlPath) &&
    statSync(htmlPath).isFile()
  ) {
    return htmlPath;
  }

  return resolve(join(outDir, "404.html"));
}

if (!existsSync(outDir)) {
  console.error("docs-site/out does not exist. Run `make docs-build` first.");
  process.exit(1);
}

const server = createServer((request, response) => {
  const filePath = resolveStaticPath(request.url ?? "/");
  if (!filePath || !existsSync(filePath)) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  const extension = extname(filePath);
  response.writeHead(filePath.endsWith("404.html") ? 404 : 200, {
    "Cache-Control": extension === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
    "Content-Type": contentTypes.get(extension) ?? "application/octet-stream",
  });
  createReadStream(filePath).pipe(response);
});

server.listen(port, () => {
  console.log(`Serving docs-site/out at http://localhost:${port}`);
});
