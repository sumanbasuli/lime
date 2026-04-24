"use client";

import { useState } from "react";
import {
  ChevronDownIcon,
  FileDownIcon,
  FileTextIcon,
  Loader2Icon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ReportSettings } from "@/lib/report-settings-config";

interface IssueReportDownloadButtonProps {
  scanId: string;
  settings: ReportSettings;
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

type ReportDownloadKey = "pdf" | "csv-small" | "csv-full" | "llm";

async function getErrorMessage(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    const payload = (await response.json()) as { error?: string };
    if (payload.error) {
      return payload.error;
    }
  }

  const text = await response.text();
  return text || "Failed to generate report";
}

function buildReportDownloads(
  settings: ReportSettings
): Partial<
  Record<
    ReportDownloadKey,
    {
      endpointSuffix: string;
      fallbackFilename: (scanId: string) => string;
      label: string;
      loadingLabel: string;
      description?: string;
    }
  >
> {
  return {
    ...(settings.pdfReportsEnabled
      ? {
          pdf: {
            endpointSuffix: "report.pdf",
            fallbackFilename: (scanId: string) =>
              `lime-issue-report-${scanId}.pdf`,
            label: "Download PDF report",
            loadingLabel: "Generating PDF...",
          },
        }
      : {}),
    ...(settings.csvReportsEnabled
      ? {
          "csv-small": {
            endpointSuffix: "report.csv?mode=small",
            fallbackFilename: (scanId: string) =>
              `lime-issue-report-${scanId}-small.csv`,
            label: "Download small report",
            loadingLabel: "Preparing small CSV...",
            description: `All issues, up to ${settings.smallCsvOccurrenceLimit} occurrences each`,
          },
          "csv-full": {
            endpointSuffix: "report.csv?mode=full",
            fallbackFilename: (scanId: string) =>
              `lime-issue-report-${scanId}-full.csv`,
            label: "Download full report",
            loadingLabel: "Preparing full CSV...",
            description: "Every occurrence. Can be very large",
          },
        }
      : {}),
    ...(settings.llmReportsEnabled
      ? {
          llm: {
            endpointSuffix: "report.llm.txt",
            fallbackFilename: (scanId: string) =>
              `lime-issue-report-${scanId}-llm.txt`,
            label: "Download LLM report",
            loadingLabel: "Preparing LLM text...",
            description: `All issue cards with up to ${settings.llmOccurrenceLimit} sampled occurrences`,
          },
        }
      : {}),
  };
}

export function IssueReportDownloadButton({
  scanId,
  settings,
  className,
}: IssueReportDownloadButtonProps) {
  const reportDownloads = buildReportDownloads(settings);
  const [downloadingFormat, setDownloadingFormat] =
    useState<ReportDownloadKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isDownloading = downloadingFormat !== null;
  const isDownloadingCsv =
    downloadingFormat === "csv-small" || downloadingFormat === "csv-full";
  const csvLoadingLabel = isDownloadingCsv
    ? reportDownloads[downloadingFormat]?.loadingLabel ?? "Preparing CSV..."
    : null;
  const isDownloadingLlm = downloadingFormat === "llm";
  const availableCsvDownloads = ([
    "csv-small",
    "csv-full",
  ] as const).filter((key) => reportDownloads[key]);

  const handleDownload = async (format: ReportDownloadKey) => {
    if (isDownloading) {
      return;
    }
    const config = reportDownloads[format];
    if (!config) {
      return;
    }

    setDownloadingFormat(format);
    setError(null);

    try {
      const response = await fetch(
        `/api/scans/${scanId}/issues/${config.endpointSuffix}`,
        {
          method: "GET",
          cache: "no-store",
        }
      );

      if (!response.ok) {
        throw new Error(await getErrorMessage(response));
      }

      const blob = await response.blob();
      const downloadUrl = URL.createObjectURL(blob);
      const filename =
        getFilenameFromDisposition(response.headers.get("content-disposition")) ??
        config.fallbackFilename(scanId);

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
        err instanceof Error ? err.message : "Failed to generate report"
      );
    } finally {
      setDownloadingFormat(null);
    }
  };

  if (
    !reportDownloads.pdf &&
    availableCsvDownloads.length === 0 &&
    !reportDownloads.llm
  ) {
    return (
      <div className={className}>
        <p className="text-sm text-muted-foreground">
          Report exports are disabled in dashboard settings.
        </p>
      </div>
    );
  }

  return (
    <div className={className}>
      <div className="flex flex-wrap justify-start gap-2 sm:justify-end">
        {reportDownloads.llm ? (
          <Button
            type="button"
            variant="outline"
            size="lg"
            disabled={isDownloading}
            onClick={() => void handleDownload("llm")}
            className="rounded-full border-black/10 bg-white text-[#0A0A0A] hover:bg-black hover:text-[#FFED00] disabled:cursor-wait disabled:opacity-100"
          >
            {isDownloadingLlm ? (
              <>
                <Loader2Icon className="h-4 w-4 animate-spin" />
                {reportDownloads.llm.loadingLabel}
              </>
            ) : (
              <>
                <FileTextIcon className="h-4 w-4" />
                {reportDownloads.llm.label}
              </>
            )}
          </Button>
        ) : null}
        {reportDownloads.pdf ? (
          <Button
            type="button"
            variant="outline"
            size="lg"
            disabled={isDownloading}
            onClick={() => void handleDownload("pdf")}
            className="rounded-full border-black/10 bg-white text-[#0A0A0A] hover:bg-black hover:text-[#FFED00] disabled:cursor-wait disabled:opacity-100"
          >
            {downloadingFormat === "pdf" ? (
              <>
                <Loader2Icon className="h-4 w-4 animate-spin" />
                {reportDownloads.pdf.loadingLabel}
              </>
            ) : (
              <>
                <FileDownIcon className="h-4 w-4" />
                {reportDownloads.pdf.label}
              </>
            )}
          </Button>
        ) : null}
        {availableCsvDownloads.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={isDownloading}
              render={
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  className="rounded-full border-black/10 bg-white text-[#0A0A0A] hover:bg-black hover:text-[#FFED00] disabled:cursor-wait disabled:opacity-100"
                />
              }
            >
              {isDownloadingCsv ? (
                <>
                  <Loader2Icon className="h-4 w-4 animate-spin" />
                  {csvLoadingLabel}
                </>
              ) : (
                <>
                  <FileTextIcon className="h-4 w-4" />
                  Download CSV report
                  <ChevronDownIcon className="h-4 w-4" />
                </>
              )}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72">
              {availableCsvDownloads.map((key) => (
                <DropdownMenuItem
                  key={key}
                  disabled={isDownloading}
                  onClick={() => void handleDownload(key)}
                >
                  <div className="flex flex-col items-start gap-0.5">
                    <span className="font-medium">
                      {reportDownloads[key]?.label}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {reportDownloads[key]?.description}
                    </span>
                  </div>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      <div className="mt-1 min-h-4">
        {error ? (
          <p className="text-xs text-destructive">{error}</p>
        ) : isDownloading ? (
          <p className="text-xs text-muted-foreground">
            Preparing the report. Large scans can take a few seconds.
          </p>
        ) : reportDownloads.llm || availableCsvDownloads.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            {reportDownloads.llm
              ? "LLM text is the smallest export. "
              : ""}
            {reportDownloads["csv-small"]
              ? `Small CSV includes all issues with up to ${settings.smallCsvOccurrenceLimit} occurrences each.`
              : ""}
          </p>
        ) : null}
      </div>
    </div>
  );
}
