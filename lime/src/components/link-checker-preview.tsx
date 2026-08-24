"use client";

import { useState } from "react";
import { MaterialSymbol } from "@/components/material-symbol";
import { Input } from "@/components/ui/input";

type CheckType = "crawl" | "single";

export function LinkCheckerPreview() {
  const [checkType, setCheckType] = useState<CheckType>("crawl");

  return (
    <section className="lime-card p-5" aria-labelledby="new-link-check-title">
      <h2 id="new-link-check-title" className="lime-eyebrow">Check a site</h2>

      <div className="mt-3 space-y-4">
        <fieldset>
          <legend className="lime-eyebrow">Check type</legend>
          <div className="mt-2 flex w-fit items-center gap-1 rounded-xl bg-black/[0.055] p-1">
            <button
              type="button"
              aria-pressed={checkType === "crawl"}
              onClick={() => setCheckType("crawl")}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                checkType === "crawl"
                  ? "bg-white text-black shadow-sm"
                  : "text-black/55 hover:text-black"
              }`}
            >
              <MaterialSymbol name="language" size={16} />
              Full crawl
            </button>
            <button
              type="button"
              aria-pressed={checkType === "single"}
              onClick={() => setCheckType("single")}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                checkType === "single"
                  ? "bg-white text-black shadow-sm"
                  : "text-black/55 hover:text-black"
              }`}
            >
              <MaterialSymbol name="description" size={16} />
              Single page
            </button>
          </div>
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
          <div>
            <label htmlFor="link-check-url" className="sr-only">
              {checkType === "crawl" ? "Website URL" : "Page URL"}
            </label>
            <Input
              id="link-check-url"
              type="url"
              placeholder={
                checkType === "crawl"
                  ? "https://example.com"
                  : "https://example.com/about"
              }
              className="h-11 rounded-xl bg-[#FBFAF6] px-4 font-mono shadow-none focus:bg-white"
            />
          </div>
          <button
            type="button"
            disabled
            aria-describedby="link-check-unavailable"
            className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-black px-6 text-sm font-semibold text-white opacity-55"
          >
            <MaterialSymbol name="play_arrow" size={18} />
            Start link check
          </button>
        </div>
        <p id="link-check-unavailable" className="text-[11px] text-muted-foreground">
          Link-check execution is intentionally unavailable in this design phase.
        </p>
      </div>
    </section>
  );
}
