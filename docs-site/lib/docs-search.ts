import { apiGroups } from "@/content/api";
import { getAllDocPages } from "@/lib/docs";

export interface DocsSearchEntry {
  title: string;
  href: string;
  category: string;
  excerpt: string;
  content: string;
}

function decodeHtml(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function compactText(value: string) {
  return decodeHtml(value.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

export function getDocsSearchEntries(): DocsSearchEntry[] {
  const docsEntries = getAllDocPages().map((page) => ({
    title: page.title,
    href: page.href,
    category: page.category ?? "Docs",
    excerpt: page.excerpt,
    content: compactText(page.html),
  }));

  const apiEntry = {
    title: "API Reference",
    href: "/api",
    category: "API",
    excerpt: "Typed API reference for scans, issues, reports, and settings.",
    content: apiGroups
      .flatMap((group) => [
        group.title,
        group.description,
        ...group.endpoints.flatMap((endpoint) => [
          endpoint.method,
          endpoint.path,
          endpoint.title,
          endpoint.description,
          endpoint.auth,
          endpoint.body ?? "",
          endpoint.response,
          ...(endpoint.notes ?? []),
        ]),
      ])
      .join(" "),
  };

  return [...docsEntries, apiEntry];
}
