const docsUrl = process.env.NEXT_PUBLIC_LIME_DOCS_URL?.trim() || "https://lime.heysuman.com/";

export const siteConfig = {
  name: "LIME",
  title: "LIME accessibility scanner",
  description:
    "Self-hosted accessibility scans with screenshots, ACT guidance, partial retry, and fast reports.",
  docsUrl,
  repoUrl: "https://github.com/sumanbasuli/lime",
  releasesUrl: "https://github.com/sumanbasuli/lime/releases",
};

export function withBasePath(path: string): string {
  const configuredBasePath = process.env.LIME_DOCS_BASE_PATH?.trim() || "";
  const basePath = configuredBasePath === "/" ? "" : configuredBasePath;
  if (!basePath) {
    return path;
  }

  return `${basePath}${path.startsWith("/") ? path : `/${path}`}`;
}

export function assetPath(path: string): string {
  return withBasePath(path);
}
