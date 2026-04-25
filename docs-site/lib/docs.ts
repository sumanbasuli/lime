import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { productDocs } from "@/content/product-docs";
import { renderMarkdown } from "@/lib/markdown";

const repoRoot = path.resolve(process.cwd(), "..");
const docsRoot = path.join(repoRoot, "docs");

export interface DocPage {
  slug: string[];
  href: string;
  title: string;
  sourcePath: string;
  html: string;
  excerpt: string;
  category?: string;
  screenshots?: string[];
  sourceFiles?: string[];
}

function titleFromMarkdown(markdown: string, fallback: string): string {
  const heading = markdown.match(/^#\s+(.+)$/m);
  return heading?.[1]?.replace(/`/g, "") ?? fallback;
}

function excerptFromMarkdown(markdown: string): string {
  const line = markdown
    .split("\n")
    .map((value) => value.trim())
    .find((value) => value && !value.startsWith("#") && !value.startsWith("```"));

  return line?.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1") ?? "";
}

function walkDocs(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const fullPath = path.join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      return walkDocs(fullPath);
    }
    if (entry.endsWith(".md")) {
      return [fullPath];
    }
    return [];
  });
}

function slugForPath(sourcePath: string): string[] {
  const relativePath = path
    .relative(docsRoot, sourcePath)
    .replace(/\.md$/, "")
    .split(path.sep);

  if (relativePath.length === 1 && relativePath[0] === "index") {
    return ["reference"];
  }

  return ["reference", ...relativePath];
}

function hrefForSlug(slug: string[]): string {
  return slug.length === 0 ? "/docs" : `/docs/${slug.join("/")}`;
}

export function getAllDocPages(): DocPage[] {
  const curatedPages = productDocs.map((doc) => ({
    slug: doc.slug,
    href: hrefForSlug(doc.slug),
    title: doc.title,
    sourcePath: "docs-site/content/product-docs.ts",
    html: renderMarkdown(doc.markdown, doc.slug),
    excerpt: doc.description,
    category: doc.category,
    screenshots: doc.screenshots,
    sourceFiles: doc.sourceFiles,
  }));

  const repoPages = existsSync(docsRoot)
    ? walkDocs(docsRoot).map((sourcePath) => {
      const markdown = readFileSync(sourcePath, "utf8");
      const slug = slugForPath(sourcePath);
      const fallback = path.basename(sourcePath, ".md");
      return {
        slug,
        href: hrefForSlug(slug),
        title: titleFromMarkdown(markdown, fallback),
        sourcePath,
        html: renderMarkdown(markdown, slug),
        excerpt: excerptFromMarkdown(markdown),
        category: "Reference",
      };
    })
    : [];

  return [...curatedPages, ...repoPages].sort((left, right) =>
    left.href.localeCompare(right.href)
  );
}

export function getDocPage(slug: string[]): DocPage | null {
  return getAllDocPages().find((page) => page.slug.join("/") === slug.join("/")) ?? null;
}
