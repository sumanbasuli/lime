export type ApiCodeLanguage = "bash" | "json" | "fields";
export type ApiCodeTokenKind = "plain" | "key" | "string" | "number" | "literal" | "punctuation" | "command" | "flag" | "variable" | "comment" | "type";
export interface ApiCodeToken {
  text: string;
  kind: ApiCodeTokenKind;
}

export function formatApiCode(code: string, language: ApiCodeLanguage): string {
  if (language !== "json") return code;
  try {
    return JSON.stringify(JSON.parse(code), null, 2);
  } catch {
    // A field contract or invalid JSON is still documentation, not a response
    // to invent or repair. Preserve the original text exactly.
    return code;
  }
}

const patterns = {
  json: /"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b|[{}\[\],:]/g,
  bash: /"(?:\\.|[^"\\])*"|'[^']*'|\$[A-Za-z_][A-Za-z0-9_]*|--?[A-Za-z][A-Za-z0-9-]*|\b(?:curl|export)\b|#.*$/g,
  fields: /[A-Za-z_][A-Za-z0-9_]*(?=\s*:)|\b(?:string|number|integer|boolean|object|array|null|UUID)\b|[{}\[\](),:?|]/g,
};

// Highlight only; this is not a shell/JSON interpreter. Tokens remain plain
// text and are rendered by React, never as trusted HTML.
export function tokenizeApiCodeLine(line: string, language: ApiCodeLanguage): ApiCodeToken[] {
  const tokens: ApiCodeToken[] = [];
  let offset = 0;
  for (const match of line.matchAll(patterns[language])) {
    const index = match.index;
    if (index > offset) tokens.push({ text: line.slice(offset, index), kind: "plain" });
    const text = match[0];
    let kind: ApiCodeTokenKind = "plain";
    if (language === "json") {
      if (text.startsWith('"')) kind = /^\s*:/.test(line.slice(index + text.length)) ? "key" : "string";
      else if (/^-?\d/.test(text)) kind = "number";
      else if (/^(true|false|null)$/.test(text)) kind = "literal";
      else kind = "punctuation";
    } else if (language === "bash") {
      if (text.startsWith('"') || text.startsWith("'")) kind = "string";
      else if (text.startsWith("$")) kind = "variable";
      else if (text.startsWith("-")) kind = "flag";
      else if (text.startsWith("#")) kind = "comment";
      else kind = "command";
    } else {
      if (/^\s*:/.test(line.slice(index + text.length))) kind = "key";
      else if (/^[A-Za-z]/.test(text)) kind = "type";
      else kind = "punctuation";
    }
    tokens.push({ text, kind });
    offset = index + text.length;
  }
  if (offset < line.length) tokens.push({ text: line.slice(offset), kind: "plain" });
  return tokens;
}
