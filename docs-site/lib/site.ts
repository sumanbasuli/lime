export const siteConfig = {
  name: "LIME",
  title: "LIME accessibility scanner",
  description:
    "Self-hosted accessibility scans with screenshots, ACT guidance, partial retry, and fast reports.",
  docsUrl: "https://sumanbasuli.github.io/lime/",
  repoUrl: "https://github.com/sumanbasuli/lime",
  releasesUrl: "https://github.com/sumanbasuli/lime/releases",
};

export function withBasePath(path: string): string {
  const basePath = process.env.LIME_DOCS_BASE_PATH?.trim() || "";
  if (!basePath) {
    return path;
  }

  return `${basePath}${path.startsWith("/") ? path : `/${path}`}`;
}

export function assetPath(path: string): string {
  return withBasePath(path);
}
