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
  const contentSlug =
    currentSlug[0] === "reference"
      ? currentSlug.slice(1)
      : currentSlug;
  const baseParts = ["docs", ...contentSlug.slice(0, -1)];
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
  if (/^https?:/.test(href)) {
    const url = new URL(href);
    if (url.origin === new URL(siteConfig.docsUrl).origin) {
      return withBasePath(`${url.pathname}${url.search}${url.hash}`);
    }
    return href;
  }
  if (/^(mailto:|#)/.test(href)) {
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
    if (!repoPath.startsWith("docs/")) {
      return `${siteConfig.repoUrl}/blob/main/${repoPath}${anchor}`;
    }
    const docsPath = repoPath
      .replace(/^docs\//, "")
      .replace(/\.md$/, "")
      .replace(/(^|\/)index$/, "");
    const docsPrefix = currentSlug[0] === "reference" ? "/docs/reference" : "/docs";
    return withBasePath(`${docsPrefix}${docsPath ? `/${docsPath}` : ""}${anchor}`);
  }

  return `${siteConfig.repoUrl}/blob/main/${repoPath}${anchor}`;
}

function renderInline(value: string, currentSlug: string[]): string {
  const tokens = /`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*/g;
  let html = "";
  let offset = 0;
  for (const match of value.matchAll(tokens)) {
    html += escapeHtml(value.slice(offset, match.index));
    if (match[1] !== undefined) {
      html += `<code>${escapeHtml(match[1])}</code>`;
    } else if (match[2] !== undefined) {
      html += `<a href="${escapeHtml(rewriteLink(match[3], currentSlug))}">${renderInline(match[2], currentSlug)}</a>`;
    } else {
      html += `<strong>${escapeHtml(match[4])}</strong>`;
    }
    offset = match.index + match[0].length;
  }
  return html + escapeHtml(value.slice(offset));
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

function renderList(lines: string[], start: number, currentSlug: string[]): { html: string; next: number } {
  const pattern = /^(\s*)([-*]|\d+\.)\s+(.+)$/;
  const first = lines[start].match(pattern)!;
  const indent = first[1].length;
  const tag = /\d/.test(first[2]) ? "ol" : "ul";
  const items: string[] = [];
  let next = start;
  while (next < lines.length) {
    const item = lines[next].match(pattern);
    if (!item || item[1].length < indent) break;
    if (item[1].length > indent && items.length) {
      const nested = renderList(lines, next, currentSlug);
      items[items.length - 1] += nested.html;
      next = nested.next;
      continue;
    }
    if ((/\d/.test(item[2]) ? "ol" : "ul") !== tag) break;
    items.push(renderInline(item[3], currentSlug));
    next += 1;
  }
  return { html: `<${tag}>${items.map((item) => `<li>${item}</li>`).join("")}</${tag}>`, next };
}

export function renderMarkdown(markdown: string, currentSlug: string[] = []): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const html: string[] = [];
  const headingIds = new Set<string>();
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
      const baseId = slugify(title);
      let id = baseId;
      let occurrence = 1;
      while (headingIds.has(id)) {
        occurrence += 1;
        id = `${baseId}-${occurrence}`;
      }
      headingIds.add(id);
      html.push(
        `<h${level} id="${id}">${renderInline(title, currentSlug)}</h${level}>`
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

    if (/^\s*(?:[-*]|\d+\.)\s+/.test(line)) {
      const list = renderList(lines, index, currentSlug);
      html.push(list.html);
      index = list.next;
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
