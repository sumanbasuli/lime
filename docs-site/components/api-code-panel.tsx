import { Fragment } from "react";
import { ApiCopyButton } from "@/components/api-copy-button";
import { MaterialSymbol } from "@/components/material-symbol";
import { formatApiCode, tokenizeApiCodeLine, type ApiCodeLanguage, type ApiCodeTokenKind } from "@/lib/api-code";

interface ApiCodePanelProps {
  label: string;
  code: string;
  language: ApiCodeLanguage;
}

const languageLabels: Record<ApiCodeLanguage, string> = {
  bash: "Bash",
  json: "JSON",
  fields: "Fields",
};
const tokenTone: Record<ApiCodeTokenKind, string> = {
  plain: "text-[#e8e7dd]",
  key: "text-[#9dd8e8]",
  string: "text-[#bde0b1]",
  number: "text-[#eec38e]",
  literal: "text-[#ceb8ef]",
  punctuation: "text-white/50",
  command: "text-[#FFED00]",
  flag: "text-[#9dd8e8]",
  variable: "text-[#eec38e]",
  comment: "text-white/55",
  type: "text-[#ceb8ef]",
};

// A Server Component: only the copy control needs browser-side JavaScript.
export function ApiCodePanel({ label, code, language }: ApiCodePanelProps) {
  const displayCode = formatApiCode(code, language);
  const lines = displayCode.split("\n");

  return (
    <div className="min-w-0 max-w-full overflow-hidden rounded-2xl border border-black/15 bg-[#191c1b] shadow-[0_8px_24px_rgba(0,0,0,0.06)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 bg-white/[0.025] px-4 py-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2.5">
          <MaterialSymbol name={language === "bash" ? "terminal" : "data_object"} size={15} className="text-[#FFED00]/80" />
          <span className="text-[11px] font-semibold text-white/80">{label}</span>
          <span className="rounded border border-white/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-white/55">{languageLabels[language]}</span>
        </div>
        <ApiCopyButton label={label} code={displayCode} />
      </div>
      <pre
        tabIndex={0}
        role="region"
        aria-label={`${label} ${languageLabels[language]} code`}
        className="m-0 flex max-w-full gap-4 overflow-x-auto px-4 py-4 font-mono text-[11px] leading-6 outline-offset-[-2px] focus-visible:outline-2 focus-visible:outline-[#FFED00] sm:text-xs"
      >
        <span aria-hidden="true" className="shrink-0 select-none border-r border-white/10 pr-3 text-right text-white/25">{lines.map((_, index) => index + 1).join("\n")}</span>
        <code className="shrink-0 whitespace-pre">
          {lines.map((line, index) => (
            <Fragment key={index}>
              {tokenizeApiCodeLine(line, language).map((token, tokenIndex) => (
                <span key={tokenIndex} className={tokenTone[token.kind]}>{token.text}</span>
              ))}
              {index < lines.length - 1 ? "\n" : null}
            </Fragment>
          ))}
        </code>
      </pre>
    </div>
  );
}
