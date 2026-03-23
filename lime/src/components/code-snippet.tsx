import Prism from "prismjs";
import "prismjs/components/prism-markup";

const voidElements = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

function formatHtmlSnippet(snippet: string): string {
  const normalized = snippet
    .replace(/\r\n?/g, "\n")
    .replace(/>\s+</g, "><")
    .trim();

  if (!normalized) {
    return "";
  }

  const tokens = normalized.split(/(<[^>]+>)/g).filter(Boolean);
  const lines: string[] = [];
  let indent = 0;

  for (const token of tokens) {
    if (token.startsWith("<")) {
      const trimmed = token.trim();
      const tagNameMatch = trimmed.match(/^<\s*\/?\s*([a-zA-Z0-9-]+)/);
      const tagName = tagNameMatch?.[1]?.toLowerCase() ?? "";
      const isClosingTag = /^<\s*\//.test(trimmed);
      const isComment = /^<!--/.test(trimmed);
      const isSelfClosingTag =
        /\/\s*>$/.test(trimmed) || (tagName !== "" && voidElements.has(tagName));

      if (isClosingTag) {
        indent = Math.max(indent - 1, 0);
      }

      lines.push(`${"  ".repeat(indent)}${trimmed}`);

      if (!isClosingTag && !isSelfClosingTag && !isComment) {
        indent += 1;
      }
      continue;
    }

    const text = token.replace(/\s+/g, " ").trim();
    if (!text) {
      continue;
    }

    lines.push(`${"  ".repeat(indent)}${text}`);
  }

  return lines.join("\n");
}

export function CodeSnippet({ code }: { code: string }) {
  const formattedCode = formatHtmlSnippet(code);
  const highlightedCode = Prism.highlight(
    formattedCode,
    Prism.languages.markup,
    "markup"
  ) as string;
  const lines: string[] = highlightedCode.split("\n");

  return (
    <div className="code-snippet overflow-hidden rounded-xl border">
      <pre className="overflow-hidden p-0">
        <code className="code-snippet-content">
          {lines.map((line, index) => (
            <span key={`${index}-${line.length}`} className="code-snippet-line">
              <span
                className="code-snippet-line-content"
                dangerouslySetInnerHTML={{ __html: line || "&nbsp;" }}
              />
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
