"use client";

import { useState } from "react";
import { FileDownIcon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";

interface IssueReportDownloadButtonProps {
  scanId: string;
  className?: string;
}

function getFilenameFromDisposition(header: string | null): string | null {
  if (!header) {
    return null;
  }

  const utf8Match = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }

  const quotedMatch = header.match(/filename="([^"]+)"/i);
  if (quotedMatch?.[1]) {
    return quotedMatch[1];
  }

  const plainMatch = header.match(/filename=([^;]+)/i);
  return plainMatch?.[1]?.trim() ?? null;
}

async function getErrorMessage(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    const payload = (await response.json()) as { error?: string };
    if (payload.error) {
      return payload.error;
    }
  }

  const text = await response.text();
  return text || "Failed to generate PDF report";
}

export function IssueReportDownloadButton({
  scanId,
  className,
}: IssueReportDownloadButtonProps) {
  const [isDownloading, setIsDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDownload = async () => {
    if (isDownloading) {
      return;
    }

    setIsDownloading(true);
    setError(null);

    try {
      const response = await fetch(`/api/scans/${scanId}/issues/report.pdf`, {
        method: "GET",
        cache: "no-store",
      });

      if (!response.ok) {
        throw new Error(await getErrorMessage(response));
      }

      const blob = await response.blob();
      const downloadUrl = URL.createObjectURL(blob);
      const filename =
        getFilenameFromDisposition(response.headers.get("content-disposition")) ??
        `lime-issue-report-${scanId}.pdf`;

      const link = document.createElement("a");
      link.href = downloadUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();

      window.setTimeout(() => {
        URL.revokeObjectURL(downloadUrl);
      }, 1000);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to generate PDF report"
      );
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <div className={className}>
      <Button
        type="button"
        variant="outline"
        size="lg"
        disabled={isDownloading}
        onClick={handleDownload}
        className="rounded-full border-black/10 bg-white text-[#0A0A0A] hover:bg-black hover:text-[#FFED00] disabled:cursor-wait disabled:opacity-100"
      >
        {isDownloading ? (
          <>
            <Loader2Icon className="h-4 w-4 animate-spin" />
            Generating PDF...
          </>
        ) : (
          <>
            <FileDownIcon className="h-4 w-4" />
            Download PDF report
          </>
        )}
      </Button>
      <div className="mt-1 min-h-4">
        {error ? (
          <p className="text-xs text-destructive">{error}</p>
        ) : isDownloading ? (
          <p className="text-xs text-muted-foreground">
            Preparing the report. Large scans can take a few seconds.
          </p>
        ) : null}
      </div>
    </div>
  );
}
