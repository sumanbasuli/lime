"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createScan } from "@/lib/api";
import { Loader2Icon, GlobeIcon, FileTextIcon } from "lucide-react";
import {
  formatViewportLabel,
  viewportPresetOptions,
  type ViewportPreset,
} from "@/lib/viewport-presets";

type ScanType = "sitemap" | "single";

export function NewScanForm() {
  const [url, setUrl] = useState("");
  const [scanType, setScanType] = useState<ScanType>("sitemap");
  const [viewportPreset, setViewportPreset] =
    useState<ViewportPreset>("desktop");
  const [tag, setTag] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!url.trim()) {
      setError(
        scanType === "sitemap"
          ? "Please enter a sitemap URL"
          : "Please enter a page URL"
      );
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
      });
      router.push(`/scans/${scan.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start scan");
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-1.5">
        <p className="text-[11px] font-medium text-muted-foreground">
          Scan type
        </p>
        <div className="flex w-fit items-center gap-1 rounded-xl bg-muted p-1">
          <button
            type="button"
            onClick={() => setScanType("sitemap")}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              scanType === "sitemap"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <GlobeIcon className="h-3.5 w-3.5" />
            Sitemap
          </button>
          <button
            type="button"
            onClick={() => setScanType("single")}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              scanType === "single"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <FileTextIcon className="h-3.5 w-3.5" />
            Single page
          </button>
        </div>
      </div>

      <div className="space-y-1.5">
        <p className="text-[11px] font-medium text-muted-foreground">
          Screen size
        </p>
        <div className="flex flex-wrap gap-2">
          {viewportPresetOptions.map((option) => {
            const isActive = viewportPreset === option.key;

            return (
              <button
                key={option.key}
                type="button"
                onClick={() => setViewportPreset(option.key)}
                disabled={loading}
                className={`inline-flex h-10 items-center rounded-full border px-4 text-sm font-medium transition-colors ${
                  isActive
                    ? "border-foreground bg-foreground text-background"
                    : "border-border bg-background hover:bg-muted"
                }`}
              >
                {formatViewportLabel(option.key, option.width, option.height)}
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_12rem_auto]">
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium text-muted-foreground">
            {scanType === "sitemap" ? "Sitemap URL" : "Page URL"}
          </p>
          <Input
            type="url"
            placeholder={
              scanType === "sitemap"
                ? "https://example.com/sitemap.xml"
                : "https://example.com/about"
            }
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={loading}
            className="h-10"
          />
        </div>

        <div className="space-y-1.5">
          <p className="text-[11px] font-medium text-muted-foreground">
            Tag
          </p>
          <Input
            type="text"
            placeholder="Optional"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            disabled={loading}
            className="h-10"
          />
        </div>

        <div className="flex items-end">
          <Button type="submit" disabled={loading} className="h-10 w-full px-4 md:w-auto">
            {loading ? (
              <>
                <Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
                Scanning...
              </>
            ) : (
              "Start scan"
            )}
          </Button>
        </div>
      </div>

      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </form>
  );
}
