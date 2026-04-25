import type { ProductDoc } from "@/content/product-docs";
import { productDocs } from "@/content/product-docs";

export interface NavigationGroup {
  title: string;
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
    .filter((doc) => doc.category === category && doc.slug.length > 0)
    .map((doc) => ({
      title: doc.title,
      href: hrefForSlug(doc.slug),
      description: doc.description,
    }));
}

const referenceItems = [
  { title: "Setup", href: "/docs/reference/setup", description: "Install and run LIME from the repo docs." },
  { title: "Database", href: "/docs/reference/database", description: "PostgreSQL schema and migration notes." },
  { title: "Performance", href: "/docs/reference/performance", description: "Optimization and cache strategy." },
  { title: "Docker Deploy", href: "/docs/reference/deployment/docker", description: "Docker-based deployment guide." },
  { title: "Fly.io Deploy", href: "/docs/reference/deployment/fly", description: "Fly launch and deploy notes." },
  { title: "Updates", href: "/docs/reference/deployment/updates", description: "Release update and upgrade process." },
];

export const navigationGroups: NavigationGroup[] = [
  {
    title: "Product",
    items: [
      { title: "Overview", href: "/" },
      { title: "Docs Home", href: "/docs" },
      { title: "Screenshots", href: "/screenshots" },
    ],
  },
  {
    title: "User Docs",
    items: docsForCategory("User Docs"),
  },
  {
    title: "Developer Docs",
    items: docsForCategory("Developer Docs"),
  },
  {
    title: "API",
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
    items: referenceItems,
  },
];
