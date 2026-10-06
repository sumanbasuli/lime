"use client";

import { useState } from "react";
import { MaterialSymbol } from "@/components/material-symbol";

const command = "curl -fsSL https://lime.heysuman.com/install.sh | bash";

export function InstallCommand() {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(command);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  return (
    <div className="mt-6 min-w-0 overflow-hidden rounded-xl border border-white/15 bg-[#181916]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="flex gap-1.5" aria-hidden="true">
            <span className="size-2 rounded-full bg-white/25" />
            <span className="size-2 rounded-full bg-white/15" />
            <span className="size-2 rounded-full bg-[#FFED00]/70" />
          </span>
          <span className="font-mono text-[10px] text-white/65">Terminal · bash</span>
        </div>
        <button
          type="button"
          onClick={() => void copyCommand()}
          aria-label="Copy install command"
          aria-describedby="install-copy-status"
          className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-white/15 px-3 text-xs font-semibold text-white/80 transition-colors hover:border-[#FFED00]/50 hover:text-[#FFED00] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FFED00]"
        >
          <MaterialSymbol name={copyState === "copied" ? "check" : "content_copy"} size={15} />
          {copyState === "copied" ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="flex min-w-0 items-start gap-3 px-4 py-5 sm:px-5">
        <span className="select-none font-mono text-sm leading-7 text-[#FFED00]" aria-hidden="true">$</span>
        <code className="min-w-0 select-all whitespace-normal font-mono text-xs leading-7 text-[#fffbe6] [overflow-wrap:anywhere]" aria-label="One-line install command">
          {command}
        </code>
      </div>
      <p id="install-copy-status" role="status" aria-live="polite" className="min-h-9 border-t border-white/10 px-4 py-2 text-[10px] leading-5 text-white/65">
        {copyState === "copied" ? "Install command copied. Paste it into your terminal when ready." : copyState === "failed" ? "Couldn’t copy automatically. Select the command and copy it manually." : "Copy the command, then paste it into your terminal to begin."}
      </p>
    </div>
  );
}
