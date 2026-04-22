"use client";

import { startTransition, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2Icon, RotateCcwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { retryFailedPages } from "@/lib/api";

interface PartialScanRetryBentoProps {
  scanId: string;
  failedUrlCount: number;
}

export function PartialScanRetryBento({
  scanId,
  failedUrlCount,
}: PartialScanRetryBentoProps) {
  const router = useRouter();
  const [isRetrying, setIsRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleRetryFailedPages = async () => {
    setIsRetrying(true);
    setError(null);

    try {
      await retryFailedPages(scanId);
      startTransition(() => {
        router.refresh();
      });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to retry failed pages"
      );
      setIsRetrying(false);
    }
  };

  return (
    <section className="overflow-hidden rounded-[28px] border border-black/10 bg-[#FFED00] p-5 text-[#0A0A0A] shadow-[0_22px_48px_rgba(10,10,10,0.08)]">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
        <div className="space-y-3">
          <div className="inline-flex rounded-full border border-black/15 bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.12em]">
            Partial scan recovery
          </div>
          <div className="space-y-2">
            <h2 className="font-heading text-[30px] font-bold leading-none">
              Retry {failedUrlCount} failed{" "}
              {failedUrlCount === 1 ? "page" : "pages"} in this scan
            </h2>
            <p className="max-w-3xl text-sm leading-5 text-[#0A0A0A]/80">
              This reopens the current scan and retries only the pages that
              failed before. New successful pages are merged into the existing
              report and score without creating a second scan.
            </p>
          </div>
        </div>

        <div className="flex flex-col items-start gap-2 lg:items-end">
          <Button
            type="button"
            size="lg"
            disabled={isRetrying}
            onClick={handleRetryFailedPages}
            className="min-w-[220px] rounded-full bg-[#0A0A0A] text-[#FFED00] hover:bg-[#202020]"
          >
            {isRetrying ? (
              <Loader2Icon className="animate-spin" />
            ) : (
              <RotateCcwIcon />
            )}
            Retry failed pages
          </Button>
          <p className="text-xs text-[#0A0A0A]/70">
            The scan stays on this same page and updates in place.
          </p>
          {error && <p className="text-xs text-[#8F2D31]">{error}</p>}
        </div>
      </div>
    </section>
  );
}
