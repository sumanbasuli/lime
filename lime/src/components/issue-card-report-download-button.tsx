"use client";

import { useState } from "react";
import { DownloadIcon, Loader2Icon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  buildIssueReportScopeQuery,
  type IssueReportScope,
} from "@/lib/issue-report-scope";
import type { ReportSettings } from "@/lib/report-settings-config";
import { cn } from "@/lib/utils";

interface IssueCardReportDownloadButtonProps {
  scanId: string;
  scope: IssueReportScope;
  issueTitle: string;
  settings: ReportSettings;
  className?: string;
}

type IssueReportDownloadKind = "pdf" | "llm" | "csv";

interface IssueReportMenuItem {
  kind: IssueReportDownloadKind;
  label: string;
  description: string;
  buildHref: (scanId: string, scope: IssueReportScope) => string;
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
  return text || "Failed to generate report";
}

async function downloadFile(url: string, fallbackFilename: string) {
  const response = await fetch(url, {
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
    fallbackFilename;

  const link = document.createElement("a");
  link.href = downloadUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();

  window.setTimeout(() => {
    URL.revokeObjectURL(downloadUrl);
  }, 1000);
}

function buildMenuItems(settings: ReportSettings) {
  return [
    ...(settings.pdfReportsEnabled
      ? [
          {
            kind: "pdf" as const,
            label: "Download PDF",
            description: `Printable issue report with up to ${settings.singleIssuePdfOccurrenceLimit} detailed occurrences`,
            buildHref: (scanId: string, scope: IssueReportScope) =>
              `/api/scans/${scanId}/issues/report.pdf?${buildIssueReportScopeQuery(scope)}`,
          },
        ]
      : []),
    ...(settings.llmReportsEnabled
      ? [
          {
            kind: "llm" as const,
            label: "Download LLM",
            description: `Compact text for LLM review with up to ${settings.llmOccurrenceLimit} sampled occurrences`,
            buildHref: (scanId: string, scope: IssueReportScope) =>
              `/api/scans/${scanId}/issues/report.llm.txt?${buildIssueReportScopeQuery(scope)}`,
          },
        ]
      : []),
    ...(settings.csvReportsEnabled
      ? [
          {
            kind: "csv" as const,
            label: "Download CSV",
            description: "All occurrences for this issue in tabular form",
            buildHref: (scanId: string, scope: IssueReportScope) =>
              `/api/scans/${scanId}/issues/report.csv?${buildIssueReportScopeQuery(scope, {
                mode: "full",
              })}`,
          },
        ]
      : []),
  ] satisfies IssueReportMenuItem[];
}

export function IssueCardReportDownloadButton({
  scanId,
  scope,
  issueTitle,
  settings,
  className,
}: IssueCardReportDownloadButtonProps) {
  const menuItems = buildMenuItems(settings);
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);

  if (menuItems.length === 0) {
    return null;
  }

  const handlePdfDownload = async (href: string) => {
    if (isGeneratingPdf) {
      return;
    }

    setPdfError(null);
    setIsGeneratingPdf(true);

    try {
      await downloadFile(href, `lime-issue-report-${scanId}.pdf`);
    } catch (error) {
      setPdfError(
        error instanceof Error ? error.message : "Failed to generate PDF report"
      );
    } finally {
      setIsGeneratingPdf(false);
    }
  };

  return (
    <div className={cn("pointer-events-auto", className)}>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              className="rounded-full"
              disabled={isGeneratingPdf}
              aria-label={`Download reports for ${issueTitle}`}
            />
          }
        >
          {isGeneratingPdf ? (
            <Loader2Icon className="h-4 w-4 animate-spin" />
          ) : (
            <DownloadIcon className="h-4 w-4" />
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          {menuItems.map((item) => (
            <DropdownMenuItem
              key={item.label}
              onClick={(event) => {
                event.preventDefault();

                const href = item.buildHref(scanId, scope);
                if (item.kind === "pdf") {
                  void handlePdfDownload(href);
                  return;
                }

                window.location.assign(href);
              }}
            >
              <div className="flex flex-col items-start gap-0.5">
                <span className="font-medium">{item.label}</span>
                <span className="text-xs text-muted-foreground">
                  {item.description}
                </span>
              </div>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {isGeneratingPdf || pdfError ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
          <div className="pointer-events-auto w-full max-w-lg rounded-2xl border border-black/10 bg-background p-4 shadow-2xl">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#FFED00] text-black">
                {isGeneratingPdf ? (
                  <Loader2Icon className="h-5 w-5 animate-spin" />
                ) : (
                  <DownloadIcon className="h-5 w-5" />
                )}
              </div>

              <div className="min-w-0 flex-1">
                <p className="font-heading text-base font-bold text-foreground">
                  {isGeneratingPdf
                    ? "Generating issue PDF report"
                    : "Could not generate issue PDF report"}
                </p>
                <p className="mt-1 text-sm leading-5 text-muted-foreground">
                  {isGeneratingPdf
                    ? "This can take a while for large issues. Your download will start automatically when the PDF is ready."
                    : pdfError}
                </p>
                <p className="mt-2 truncate text-xs font-medium text-foreground/70">
                  {issueTitle}
                </p>
              </div>

              {pdfError ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0 rounded-full"
                  onClick={() => setPdfError(null)}
                  aria-label="Dismiss PDF export status"
                >
                  <XIcon className="h-4 w-4" />
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
