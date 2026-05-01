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
  return productDocs
    .filter((doc) => doc.category === category && doc.slug.length > 1)
    .map((doc) => ({
      title: doc.title,
      href: hrefForSlug(doc.slug),
      description: doc.description,
    }));
}

const referenceItems = [
  { title: "Setup", href: "/docs/reference/setup", description: "Install and run LIME from the repo docs." },
  { title: "Docs Site", href: "/docs/reference/docs-site", description: "Static docs architecture, screenshots, search, and GitHub Pages." },
  { title: "MCP Integration", href: "/docs/reference/mcp", description: "Connect AI tools to LIME through the read-only MCP interface." },
  { title: "Database", href: "/docs/reference/database", description: "PostgreSQL schema and migration notes." },
  { title: "Performance", href: "/docs/reference/performance", description: "Optimization and cache strategy." },
  { title: "Docker Deploy", href: "/docs/reference/deployment/docker", description: "Docker-based deployment guide." },
  { title: "Debian Deploy", href: "/docs/reference/deployment/debian", description: "Native systemd install for Debian-family Linux." },
  { title: "Fly.io Deploy", href: "/docs/reference/deployment/fly", description: "Fly launch and deploy notes." },
  { title: "Updates", href: "/docs/reference/deployment/updates", description: "Release update and upgrade process." },
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
    title: "Developer Docs",
    href: "/docs/developer",
    items: docsForCategory("Developer Docs"),
  },
  {
    title: "API",
    href: "/api",
    items: [
      {
        title: "API Reference",
        href: "/api",
        description: "Full method-grouped endpoint reference.",
      },
    ],
  },
  {
    title: "Reference",
    href: "/docs/reference",
    items: referenceItems,
  },
];
