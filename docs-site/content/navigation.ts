import type { ProductDoc } from "@/content/product-docs";
import { productDocs } from "@/content/product-docs";

export interface NavigationGroup {
  title: string;
  href: string;
  items: Array<{
    title: string;
    href: string;
    description?: string;
  }>;
}

export function hrefForSlug(slug: string[]): string {
  return slug.length === 0 ? "/docs" : `/docs/${slug.join("/")}`;
}

function docsForCategory(category: ProductDoc["category"]) {
  const userReadingOrder = ["first-scan", "dashboard", "scan-detail", "issues", "reports", "settings", "mcp", "agent", "troubleshooting", "link-checker"];
  function readingIndex(doc: ProductDoc) {
    const index = userReadingOrder.indexOf(doc.slug[1]);
    return index < 0 ? userReadingOrder.length : index;
  }
  return productDocs
    .filter((doc) => doc.category === category && doc.slug.length > 1)
    .sort((left, right) => category === "User Docs"
      ? readingIndex(left) - readingIndex(right)
      : 0)
    .map((doc) => ({
      title: doc.title,
      href: hrefForSlug(doc.slug),
      description: doc.description,
    }));
}

const operatorItems = [
  { title: "Setup", href: "/docs/reference/setup", description: "Install and run LIME." },
  { title: "Docker Deploy", href: "/docs/reference/deployment/docker", description: "Pinned images, release bundles, and persistence." },
  { title: "Debian Deploy", href: "/docs/reference/deployment/debian", description: "Native systemd install for Debian-family Linux." },
  { title: "Fly.io Deploy", href: "/docs/reference/deployment/fly", description: "Separate UI and backend apps with persistent storage." },
  { title: "Backup And Restore", href: "/docs/reference/deployment/backup-restore", description: "Protect PostgreSQL data and screenshot evidence." },
  { title: "Updates", href: "/docs/reference/deployment/updates", description: "Upgrade steps, rollback limits, and update notices." },
  { title: "Operational Troubleshooting", href: "/docs/reference/deployment/troubleshooting", description: "Diagnose service, scan, screenshot, and report problems." },
];

const contributorItems = [
  { title: "Testing LIME", href: "/docs/reference/verification", description: "Run product, integration, and documentation tests." },
  { title: "Docs Site Reference", href: "/docs/reference/docs-site", description: "Static docs architecture, screenshots, search, and GitHub Pages." },
];

const referenceItems = [
  { title: "Database", href: "/docs/reference/database", description: "PostgreSQL schema and migration notes." },
  { title: "Performance", href: "/docs/reference/performance", description: "Optimization and cache strategy." },
  { title: "Shopkeeper Architecture", href: "/docs/reference/architecture/shopkeeper", description: "HTTP API, orchestration, persistence, and background work." },
  { title: "Profiler Architecture", href: "/docs/reference/architecture/profiler", description: "Sitemap discovery, validation, and URL collection." },
  { title: "Juicer Architecture", href: "/docs/reference/architecture/juicer", description: "Chromium workers, axe-core audits, and screenshots." },
  { title: "Sweetner Architecture", href: "/docs/reference/architecture/sweetner", description: "Issue normalization, grouping, and persistence." },
  { title: "Link Checker Architecture", href: "/docs/reference/architecture/link-checker", description: "Standalone checks, scan companions, network policy, and saved destinations." },
  { title: "UI Architecture", href: "/docs/reference/architecture/ui", description: "Next.js dashboard routes, data loading, and reports." },
  { title: "MCP Protocol Reference", href: "/docs/reference/mcp", description: "Transport, authentication, schemas, and integration checks." },
  { title: "LIME Agent Reference", href: "/docs/reference/agent", description: "Configure and maintain the LIME agent and its OpenClaw skills." },
  { title: "Roadmap Reference", href: "/docs/reference/roadmap", description: "Released features, current priorities, and future plans." },
];

export const navigationGroups: NavigationGroup[] = [
  {
    title: "Product",
    href: "/",
    items: [
      { title: "Overview", href: "/" },
      { title: "Docs Home", href: "/docs" },
      { title: "Screenshots", href: "/screenshots" },
    ],
  },
  {
    title: "User Docs",
    href: "/docs/user",
    items: docsForCategory("User Docs"),
  },
  {
    title: "Operator Guides",
    href: "/docs/reference/setup",
    items: operatorItems,
  },
  {
    title: "Developer Docs",
    href: "/docs/developer",
    items: [...docsForCategory("Developer Docs"), ...contributorItems],
  },
  {
    title: "API",
    href: "/api",
    items: [
      {
        title: "API Reference",
        href: "/api",
        description: "Endpoints, request examples, and response formats.",
      },
      ...docsForCategory("API"),
    ],
  },
  {
    title: "Technical Reference",
    href: "/docs/reference",
    items: referenceItems,
  },
];

// Reading order belongs to the audience navigation, not alphabetized filenames.
export function documentationSequence(href: string): string[] {
  const group = navigationGroups.find((candidate) =>
    candidate.title !== "Product" &&
    (candidate.href === href || candidate.items.some((item) => item.href === href))
  );
  return group ? [...new Set([group.href, ...group.items.map((item) => item.href)])] : [];
}

export function documentationCategory(href: string): string {
  return navigationGroups.find((group) =>
    group.title !== "Product" &&
    (group.href === href || group.items.some((item) => item.href === href))
  )?.title ?? "Technical Reference";
}
