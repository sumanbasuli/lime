"use client";

import { useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { MaterialSymbol } from "@/components/material-symbol";
import { Input } from "@/components/ui/input";
import { createScan } from "@/lib/api";
import {
  viewportPresetOptions,
  type ViewportPreset,
} from "@/lib/viewport-presets";

type ScanType = "sitemap" | "single";

const viewportIconName = {
  desktop: "desktop_windows",
  laptop: "laptop_mac",
  tablet: "tablet_mac",
  mobile: "smartphone",
} satisfies Record<ViewportPreset, string>;

const viewportFrameClass = {
  desktop: "h-10 w-16",
  laptop: "h-10 w-16",
  tablet: "h-11 w-8",
  mobile: "h-11 w-6",
} satisfies Record<ViewportPreset, string>;

const subscribeToHydration = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

export function NewScanForm() {
  const hydrated = useSyncExternalStore(subscribeToHydration, clientSnapshot, serverSnapshot);
  const [url, setUrl] = useState("");
  const [scanType, setScanType] = useState<ScanType>("sitemap");
  const [viewportPreset, setViewportPreset] = useState<ViewportPreset>("desktop");
  const [tag, setTag] = useState("");
  const [includeLinkCheck, setIncludeLinkCheck] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const controlsDisabled = !hydrated || loading;

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    if (!url.trim()) {
      setError(scanType === "sitemap" ? "Please enter a sitemap URL" : "Please enter a page URL");
      return;
    }

    try {
      new URL(url);
    } catch {
      setError("Please enter a valid URL");
      return;
    }

    setLoading(true);
    try {
      const scan = await createScan({
        url: url.trim(),
        scanType,
        viewportPreset,
        tag: tag.trim() || undefined,
        includeLinkCheck,
      });
      router.push(`/scans/${scan.id}`);
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : "Failed to start scan");
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <fieldset>
        <legend className="lime-eyebrow">Scan type</legend>
        <div className="mt-2 flex w-fit items-center gap-1 rounded-xl bg-black/[0.055] p-1">
          <button
            type="button"
            onClick={() => setScanType("sitemap")}
            disabled={controlsDisabled}
            aria-pressed={scanType === "sitemap"}
            className={`flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition ${
              scanType === "sitemap"
                ? "bg-white text-black shadow-sm"
                : "text-black/50 hover:text-black"
            }`}
          >
            <MaterialSymbol name="language" size={16} />
            Sitemap
          </button>
          <button
            type="button"
            onClick={() => setScanType("single")}
            disabled={controlsDisabled}
            aria-pressed={scanType === "single"}
            className={`flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition ${
              scanType === "single"
                ? "bg-white text-black shadow-sm"
                : "text-black/50 hover:text-black"
            }`}
          >
            <MaterialSymbol name="description" size={16} />
            Single page
          </button>
        </div>
      </fieldset>

      <fieldset>
        <legend className="lime-eyebrow">Screen size</legend>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {viewportPresetOptions.map((option) => {
            const isActive = viewportPreset === option.key;
            return (
              <button
                key={option.key}
                type="button"
                onClick={() => setViewportPreset(option.key)}
                disabled={controlsDisabled}
                aria-pressed={isActive}
                className={`relative flex min-h-[150px] flex-col rounded-2xl border p-4 text-left transition ${
                  isActive
                    ? "border-black bg-black text-white shadow-[0_16px_30px_rgba(10,10,10,0.14)]"
                    : "border-black/12 bg-white text-black hover:border-black/30"
                }`}
              >
                <div className="flex w-full items-center justify-between">
                  <MaterialSymbol name={viewportIconName[option.key]} size={20} />
                  {isActive ? (
                    <MaterialSymbol name="check_circle" size={17} className="text-[#FFED00]" />
                  ) : null}
                </div>
                <div className="flex flex-1 items-center">
                  <span
                    aria-hidden="true"
                    className={`${viewportFrameClass[option.key]} rounded-[3px] border ${
                      isActive ? "border-[#FFED00] bg-[#FFED00]/10" : "border-black/35 bg-black/[0.025]"
                    }`}
                  />
                </div>
                <span className="text-sm font-semibold">{option.label}</span>
                <span className={`mt-0.5 font-mono text-[10px] ${isActive ? "text-white/55" : "text-black/45"}`}>
                  {option.width} × {option.height}
                </span>
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="space-y-1.5">
        <label htmlFor="scan-url" className="lime-eyebrow block">
          {scanType === "sitemap" ? "Sitemap URL" : "Page URL"}
        </label>
        <Input
          id="scan-url"
          type="url"
          placeholder={
            scanType === "sitemap"
              ? "https://example.com/sitemap.xml"
              : "https://example.com/about"
          }
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          disabled={controlsDisabled}
          className="h-11 rounded-xl bg-[#FBFAF6] px-4 font-mono text-sm shadow-none focus:bg-white"
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="scan-tag" className="lime-eyebrow block">
          Tag <span className="font-normal normal-case tracking-normal">— optional</span>
        </label>
        <Input
          id="scan-tag"
          type="text"
          placeholder="e.g. production"
          value={tag}
          onChange={(event) => setTag(event.target.value)}
          disabled={controlsDisabled}
          className="h-11 rounded-xl bg-[#FBFAF6] px-4 shadow-none focus:bg-white"
        />
      </div>

      <div className="rounded-2xl border border-black/12 bg-[#FBFAF6] p-4">
        <label htmlFor="include-link-check" className="flex cursor-pointer items-start gap-3">
          <input
            id="include-link-check"
            type="checkbox"
            aria-labelledby="include-link-check-label"
            checked={includeLinkCheck}
            onChange={(event) => setIncludeLinkCheck(event.target.checked)}
            disabled={controlsDisabled}
            aria-describedby="include-link-check-help"
            className="mt-0.5 size-4 shrink-0 accent-black"
          />
          <span>
            <span className="flex items-center gap-2 text-sm font-semibold">
              <MaterialSymbol name="link" size={18} />
              <span id="include-link-check-label">Include link check</span>
            </span>
            <span id="include-link-check-help" className="mt-1 block text-xs leading-5 text-muted-foreground">
              Check links on this scan’s pages after accessibility scanning finishes. Link results are separate and do not change the accessibility score.
            </span>
          </span>
        </label>
      </div>

      <button
        type="submit"
        disabled={controlsDisabled}
        className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-full bg-black px-5 text-sm font-semibold text-white transition-colors hover:bg-[#FFED00] hover:text-black disabled:cursor-wait disabled:opacity-60"
      >
        <MaterialSymbol
          name={loading ? "progress_activity" : "play_arrow"}
          size={18}
          className={loading ? "animate-spin" : undefined}
        />
        {loading ? "Starting scan…" : "Start scan"}
      </button>

      {error ? (
        <p role="alert" className="flex items-center gap-2 text-[13px] font-medium text-destructive">
          <MaterialSymbol name="error" size={17} />
          {error}
        </p>
      ) : null}
    </form>
  );
}
