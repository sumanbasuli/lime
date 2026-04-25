import type { NextConfig } from "next";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const docsSiteRoot = dirname(fileURLToPath(import.meta.url));

const basePath = process.env.LIME_DOCS_BASE_PATH?.trim() || "";

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  basePath,
  assetPrefix: basePath || undefined,
  turbopack: {
    root: docsSiteRoot,
  },
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
