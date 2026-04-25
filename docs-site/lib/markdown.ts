import { siteConfig, withBasePath } from "@/lib/site";

function splitHref(href: string): { target: string; anchor: string } {
  const hashIndex = href.indexOf("#");
  if (hashIndex === -1) {
    return { target: href, anchor: "" };
  }

  return {
    target: href.slice(0, hashIndex),
    anchor: href.slice(hashIndex),
  };
}

function normalizeParts(parts: string[]): string[] {
  const normalized: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      normalized.pop();
      continue;
    }
    normalized.push(part);
  }
  return normalized;
}

function resolveRelativePath(currentSlug: string[], target: string): string[] {
  const baseParts = ["docs", ...currentSlug.slice(0, -1)];
  return normalizeParts([...baseParts, ...target.split("/")]);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function rewriteLink(href: string, currentSlug: string[]): string {
  if (/^(https?:|mailto:|#)/.test(href)) {
    return href;
  }

  const { target, anchor } = splitHref(href);
  if (!target) {
    return anchor;
  }

  if (target.startsWith("/")) {
    return withBasePath(`${target}${anchor}`);
  }

  const sourceParts = resolveRelativePath(currentSlug, target);
  const repoPath = sourceParts.join("/");
  const hasFileExtension = /\.[a-z0-9]+$/i.test(target);

  const looksLikeDocRoute =
    target.endsWith(".md") ||
    target.endsWith("/") ||
    (!hasFileExtension && !target.startsWith("."));

  if (looksLikeDocRoute) {
    const docsPath = repoPath
      .replace(/^docs\//, "")
      .replace(/\.md$/, "")
      .replace(/\/index$/, "");
    return withBasePath(`/docs/${docsPath}${anchor}`);
  }

  return `${siteConfig.repoUrl}/blob/main/${repoPath}${anchor}`;
}

function renderInline(value: string, currentSlug: string[]): string {
  let html = escapeHtml(value);

  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_, label: string, href: string) =>
      `<a href="${escapeHtml(rewriteLink(href, currentSlug))}">${label}</a>`
  );

  return html;
}

function renderImage(alt: string, rawHref: string, caption: string, currentSlug: string[]): string {
  const src = rewriteLink(rawHref, currentSlug);
  const safeAlt = escapeHtml(alt);
  const safeCaption = escapeHtml(caption);

  return `<figure><img src="${escapeHtml(src)}" alt="${safeAlt}" />${
    safeCaption ? `<figcaption>${safeCaption}</figcaption>` : ""
  }</figure>`;
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function renderTable(lines: string[], currentSlug: string[]): string {
  const rows = lines.map((line) =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim())
  );
  const [header, , ...bodyRows] = rows;

  return `<div class="markdown-table-wrap"><table><thead><tr>${header
    .map((cell) => `<th>${renderInline(cell, currentSlug)}</th>`)
    .join("")}</tr></thead><tbody>${bodyRows
    .map(
      (row) =>
        `<tr>${row.map((cell) => `<td>${renderInline(cell, currentSlug)}</td>`).join("")}</tr>`
    )
    .join("")}</tbody></table></div>`;
}

export function renderMarkdown(markdown: string, currentSlug: string[] = []): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const html: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const image = line.match(/^!\[([^\]]*)\]\((\S+?)(?:\s+"([^"]+)")?\)$/);
    if (image) {
      html.push(renderImage(image[1], image[2], image[3] ?? "", currentSlug));
      index += 1;
      continue;
    }

    if (line.startsWith("```")) {
      const language = line.slice(3).trim();
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith("```")) {
        codeLines.push(lines[index]);
        index += 1;
      }
      index += 1;
      html.push(
        `<pre><code data-language="${escapeHtml(language)}">${escapeHtml(
          codeLines.join("\n")
        )}</code></pre>`
      );
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const title = heading[2].trim();
      html.push(
        `<h${level} id="${slugify(title)}">${renderInline(title, currentSlug)}</h${level}>`
      );
      index += 1;
      continue;
    }

    if (
      index + 1 < lines.length &&
      line.includes("|") &&
      isTableSeparator(lines[index + 1])
    ) {
      const tableLines = [line, lines[index + 1]];
      index += 2;
      while (index < lines.length && lines[index].includes("|")) {
        tableLines.push(lines[index]);
        index += 1;
      }
      html.push(renderTable(tableLines, currentSlug));
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*]\s+/, ""));
        index += 1;
      }
      html.push(`<ul>${items.map((item) => `<li>${renderInline(item, currentSlug)}</li>`).join("")}</ul>`);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+\.\s+/, ""));
        index += 1;
      }
      html.push(`<ol>${items.map((item) => `<li>${renderInline(item, currentSlug)}</li>`).join("")}</ol>`);
      continue;
    }

    const paragraph: string[] = [line.trim()];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^(#{1,4})\s+/.test(lines[index]) &&
      !lines[index].startsWith("```") &&
      !/^\s*[-*]\s+/.test(lines[index]) &&
      !/^\s*\d+\.\s+/.test(lines[index])
    ) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    html.push(`<p>${renderInline(paragraph.join(" "), currentSlug)}</p>`);
  }

  return html.join("\n");
}
