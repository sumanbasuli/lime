"use client";

import { useId, useState } from "react";
import { MaterialSymbol } from "@/components/material-symbol";

interface ApiCopyButtonProps {
  label: string;
  code: string;
}

export function ApiCopyButton({ label, code }: ApiCopyButtonProps) {
  const statusId = useId();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  return (
    <div className="flex max-w-full flex-col items-end gap-1.5">
      <button
        type="button"
        aria-label={`Copy ${label}`}
        aria-describedby={statusId}
        onClick={() => void copyCode()}
        className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-white/15 px-2.5 text-[11px] font-semibold text-white/75 transition-colors hover:border-[#FFED00]/50 hover:text-[#FFED00] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FFED00]"
      >
        <MaterialSymbol name={copyState === "copied" ? "check" : "content_copy"} size={14} />
        {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy"}
      </button>
      <p
        id={statusId}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className={copyState === "failed" ? "max-w-52 text-right text-[10px] leading-4 text-amber-200" : "sr-only"}
      >
        {copyState === "copied"
          ? `${label} copied to clipboard.`
          : copyState === "failed"
            ? "Could not copy automatically. Select the code and copy it manually."
            : "Copy this example to the clipboard."}
      </p>
    </div>
  );
}
