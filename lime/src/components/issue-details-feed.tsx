"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import { ChevronRightIcon, ExternalLinkIcon, Loader2Icon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { IssueCardReportDownloadButton } from "@/components/issue-card-report-download-button";
import { IssueFalsePositiveButton } from "@/components/issue-false-positive-button";
import { IssueScreenshotLightbox } from "@/components/issue-screenshot-lightbox";
import { AuditStatusBadge, SeverityBadge } from "@/components/status-badge";
import {
  type ACTRule,
  type AccessibilityReference,
} from "@/lib/act-rules";
import {
  mergeAccessibilityReferences,
  normalizeACTAccessibilityRequirements,
} from "@/lib/accessibility-references";
import {
  type IssueDetailResponse,
  type IssueOccurrence,
  type IssueSummaryItem,
} from "@/lib/scan-issues";
import type { ReportSettings } from "@/lib/report-settings-config";
import { cn } from "@/lib/utils";

const ISSUE_SUMMARIES_PAGE_SIZE = 12;
const ISSUE_OCCURRENCES_PAGE_SIZE = 25;

const CodeSnippet = dynamic(
  () => import("@/components/code-snippet").then((module) => module.CodeSnippet),
  {
    loading: () => (
      <div className="overflow-hidden rounded-xl border bg-muted/20 p-3 text-xs text-muted-foreground">
        Formatting snippet…
      </div>
    ),
  }
);

interface IssueDetailsFeedProps {
  scanId: string;
  initialItems: IssueSummaryItem[];
  totalItemCount: number;
  reportSettings: ReportSettings;
}

interface IssueDetailRouteResponse {
  summary: IssueSummaryItem;
  detail: IssueDetailResponse;
}

const alternativeACTRulePairs = new Set(["09o5cg:afw4f7"]);

function actStatusBadgeVariant(
  status: ACTRule["status"]
): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "approved":
      return "default";
    case "proposed":
      return "secondary";
    case "deprecated":
      return "destructive";
    default:
      return "outline";
  }
}

function formatACTStatus(status: ACTRule["status"]): string {
  if (status === "approved") {
    return "W3C Recommendation";
  }

  return status.charAt(0).toUpperCase() + status.slice(1);
}

function buildSuggestedChangesSummary(suggestedFixes: string[]): string | null {
  const prioritizedFixes = Array.from(
    new Set(
      suggestedFixes
        .map((suggestedFix) => suggestedFix.trim())
        .filter(Boolean)
        .filter(
          (suggestedFix) =>
            !suggestedFix.startsWith("Avoid failing patterns like:") &&
            !suggestedFix.startsWith(
              "Use the ACT passing pattern as a reference:"
            ) &&
            !suggestedFix.startsWith("Meet the ACT expectation:")
        )
    )
  );

  const summaryFixes =
    prioritizedFixes.length > 0
      ? prioritizedFixes.slice(0, 3)
      : Array.from(new Set(suggestedFixes.filter(Boolean))).slice(0, 2);

  if (summaryFixes.length === 0) {
    return null;
  }

  return summaryFixes.join(" ");
}

function selectActionableFixes(
  suggestedFixes: string[],
  limit = 2
): string[] {
  return Array.from(
    new Set(
      suggestedFixes
        .map((suggestedFix) => suggestedFix.trim())
        .filter(Boolean)
        .filter(
          (suggestedFix) =>
            !suggestedFix.startsWith("Avoid failing patterns like:") &&
            !suggestedFix.startsWith(
              "Use the ACT passing pattern as a reference:"
            ) &&
            !suggestedFix.startsWith("Meet the ACT expectation:")
        )
    )
  ).slice(0, limit);
}

function buildRuleMeaningParagraph(actRule: ACTRule): string {
  if (actRule.summary && actRule.summary !== actRule.title) {
    return actRule.summary;
  }

  return `${actRule.title}.`;
}

function buildRuleActionParagraph(actRule: ACTRule): string | null {
  const actionableFixes = selectActionableFixes(actRule.suggestedFixes);
  if (actionableFixes.length === 0) {
    return null;
  }

  return actionableFixes.join(" ");
}

function areAlternativeACTRules(firstRule: ACTRule, secondRule: ACTRule): boolean {
  const pairKey = [firstRule.actRuleId, secondRule.actRuleId].sort().join(":");
  return alternativeACTRulePairs.has(pairKey);
}

function normalizeComparisonText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function shouldShowRuleDescription(
  title: string,
  ruleDescription: string | null
): ruleDescription is string {
  if (!ruleDescription) {
    return false;
  }

  return normalizeComparisonText(title) !== normalizeComparisonText(ruleDescription);
}

function elementScreenshotUrl(path: string): string {
  const marker = "/screenshots/";
  const normalized = path.startsWith("/app/screenshots/")
    ? path.replace(/^\/app\/screenshots\//, "")
    : path.includes(marker)
      ? path.slice(path.lastIndexOf(marker) + marker.length)
      : path;
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length >= 2) {
    return `/api/screenshots/${parts[0]}/${parts[1]}`;
  }
  return "";
}

function focusedPreviewPath(path: string): string {
  const extensionIndex = path.lastIndexOf(".");
  if (extensionIndex === -1) {
    return `${path}_preview`;
  }

  return `${path.slice(0, extensionIndex)}_preview${path.slice(extensionIndex)}`;
}

function occurrenceScreenshot(occ: {
  elementScreenshotPath: string | null;
}) {
  if (occ.elementScreenshotPath) {
    return {
      path: occ.elementScreenshotPath,
      label: "Screenshot",
    };
  }

  return null;
}

function occurrencePageCapture(occ: { screenshotPath: string | null }) {
  if (!occ.screenshotPath) {
    return null;
  }

  return {
    path: occ.screenshotPath,
    label: "Page capture",
  };
}

function formatOccurrenceLabel(count: number): string {
  return `${count} occurrence${count === 1 ? "" : "s"}`;
}

function severitySortOrder(
  severity: "critical" | "serious" | "moderate" | "minor"
): number {
  switch (severity) {
    case "critical":
      return 0;
    case "serious":
      return 1;
    case "moderate":
      return 2;
    case "minor":
    default:
      return 3;
  }
}

function issueSummaryRank(item: IssueSummaryItem): number {
  if (item.kind === "failed" && !item.isFalsePositive) {
    return 0;
  }
  if (item.kind === "needs_review") {
    return 1;
  }
  return 2;
}

function compareIssueSummaryItems(
  left: IssueSummaryItem,
  right: IssueSummaryItem
): number {
  const rankDifference = issueSummaryRank(left) - issueSummaryRank(right);
  if (rankDifference !== 0) {
    return rankDifference;
  }

  const weightDifference = right.weight - left.weight;
  if (weightDifference !== 0) {
    return weightDifference;
  }

  if (left.kind === "failed" && right.kind === "failed") {
    const severityDifference =
      severitySortOrder(left.severity) - severitySortOrder(right.severity);
    if (severityDifference !== 0) {
      return severityDifference;
    }
  }

  return left.title.localeCompare(right.title);
}

function ACTRuleCard({
  actRule,
  complianceReferences,
}: {
  actRule: ACTRule;
  complianceReferences: AccessibilityReference[];
}) {
  const accessibilityReferences = mergeAccessibilityReferences(
    normalizeACTAccessibilityRequirements(actRule.accessibilityRequirements),
    complianceReferences
  );

  return (
    <article className="rounded-lg border border-black/20 bg-[#FFED00] p-3 text-[#111111]">
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant="outline"
          className="border-black bg-black font-mono text-[#FFED00]"
        >
          {actRule.actRuleId}
        </Badge>
        <Badge
          variant={actStatusBadgeVariant(actRule.status)}
          className="border-black/30 bg-white text-[#111111]"
        >
          {formatACTStatus(actRule.status)}
        </Badge>
        <a
          href={actRule.ruleUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 font-heading text-[15px] font-bold leading-tight text-[#111111] hover:underline"
        >
          {actRule.title}
          <ExternalLinkIcon className="h-3 w-3" />
        </a>
      </div>

      <div className="mt-2 space-y-2 text-sm leading-5 text-[#111111]/85">
        <p>
          <span className="mr-2 font-semibold underline decoration-black/35 underline-offset-3">
            What this means
          </span>
          {buildRuleMeaningParagraph(actRule)}
        </p>
        {buildRuleActionParagraph(actRule) && (
          <p>
            <span className="mr-2 font-semibold underline decoration-black/35 underline-offset-3">
              What to do
            </span>
            {buildRuleActionParagraph(actRule)}
          </p>
        )}
      </div>

      {accessibilityReferences.length > 0 && (
        <div className="mt-3">
          <p className="text-[11px] font-semibold text-[#111111]/70">
            Accessibility requirements
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {accessibilityReferences.map((requirement) => (
              <div
                key={`${actRule.actRuleId}-${requirement.id}`}
                className="rounded-md border border-black/20 bg-white/80 px-2.5 py-2"
              >
                <p className="text-xs font-medium leading-5">
                  {requirement.title}
                </p>
                <p className="mt-1 text-[11px] text-[#111111]/70">
                  {requirement.forConformance ? "Required" : "Supporting"}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </article>
  );
}

function BaseRuleGuidanceCard({
  description,
  helpUrl,
  accessibilityRequirements,
}: {
  description: string;
  helpUrl: string | null;
  accessibilityRequirements: AccessibilityReference[];
}) {
  return (
    <article className="rounded-lg border border-black/20 bg-[#FFED00] p-3 text-[#111111]">
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant="secondary"
          className="border-black/30 bg-white text-[#111111]"
        >
          axe-core
        </Badge>
        {helpUrl ? (
          <a
            href={helpUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-heading text-[15px] font-bold leading-tight text-[#111111] hover:underline"
          >
            {description}
            <ExternalLinkIcon className="h-3 w-3" />
          </a>
        ) : (
          <h3 className="font-heading text-[15px] font-bold leading-tight text-[#111111]">
            {description}
          </h3>
        )}
      </div>

      <div className="mt-2 space-y-2 text-sm leading-5 text-[#111111]/85">
        <p>
          <span className="mr-2 font-semibold underline decoration-black/35 underline-offset-3">
            What this means
          </span>
          {description}
        </p>
        <p>
          <span className="mr-2 font-semibold underline decoration-black/35 underline-offset-3">
            What to review
          </span>
          Review the affected elements below and compare them with the linked
          guidance so the expected accessible pattern is clear in context.
        </p>
      </div>

      {accessibilityRequirements.length > 0 ? (
        <div className="mt-3">
          <p className="text-[11px] font-semibold text-[#111111]/70">
            Accessibility requirements
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {accessibilityRequirements.map((requirement) => (
              <div
                key={requirement.id}
                className="rounded-md border border-black/20 bg-white/80 px-2.5 py-2"
              >
                <p className="text-xs font-medium leading-5">
                  {requirement.title}
                </p>
                <p className="mt-1 text-[11px] text-[#111111]/70">
                  {requirement.forConformance ? "Required" : "Supporting"}
                </p>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="mt-3">
          <p className="text-[11px] font-semibold text-[#111111]/70">
            Accessibility requirements
          </p>
          <div className="mt-2 rounded-md border border-black/20 bg-white/80 px-2.5 py-2">
            <p className="text-xs font-medium leading-5">
              No direct standards reference
            </p>
            <p className="mt-1 text-[11px] text-[#111111]/70">
              Supporting guidance only
            </p>
          </div>
        </div>
      )}
    </article>
  );
}

function AlternativeRuleBinder() {
  return (
    <div className="flex shrink-0 items-center justify-center px-1 lg:px-0">
      <div className="flex w-full items-center gap-3 lg:h-full lg:w-16 lg:flex-col lg:justify-center">
        <div className="h-px flex-1 bg-black/20 lg:h-10 lg:w-px lg:flex-none" />
        <div className="flex h-14 w-14 items-center justify-center rounded-full border border-black/15 bg-white/85 text-[#111111] shadow-[0_12px_28px_rgba(17,17,17,0.12)] ring-4 ring-white/35 backdrop-blur-sm">
          <span className="font-heading text-sm font-bold leading-none">OR</span>
        </div>
        <div className="h-px flex-1 bg-black/20 lg:h-10 lg:w-px lg:flex-none" />
      </div>
    </div>
  );
}

function IssueOccurrenceList({
  occurrences,
  ruleLabel,
}: {
  occurrences: IssueOccurrence[];
  ruleLabel: string;
}) {
  return (
    <section className="space-y-2">
      <h3 className="font-heading text-base font-bold">Affected elements</h3>

      {occurrences.map((occ) => {
        const screenshot = occurrenceScreenshot(occ);
        const pageCapture = occurrencePageCapture(occ);

        return (
          <div key={occ.id} className="rounded-xl border bg-muted/30 p-3">
            <p className="text-[11px] font-medium text-muted-foreground">URL</p>
            <a
              href={occ.pageUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1.5 inline-flex break-all text-sm leading-5 text-primary hover:underline"
            >
              {occ.pageUrl}
            </a>

            {occ.cssSelector && (
              <p className="mt-2 text-[11px] text-muted-foreground">
                Selector:{" "}
                <code className="rounded bg-muted px-1 font-mono">
                  {occ.cssSelector}
                </code>
              </p>
            )}

            {occ.htmlSnippet && (
              <div className="mt-2">
                <p className="mb-1 text-[11px] font-medium text-muted-foreground">
                  HTML snippet
                </p>
                <CodeSnippet code={occ.htmlSnippet} />
              </div>
            )}

            {screenshot && (
              <div className="mt-2">
                <p className="mb-1 text-[11px] font-medium text-muted-foreground">
                  {screenshot.label}
                </p>
                <IssueScreenshotLightbox
                  src={elementScreenshotUrl(screenshot.path)}
                  previewSrc={elementScreenshotUrl(
                    focusedPreviewPath(screenshot.path)
                  )}
                  alt={`Screenshot of ${ruleLabel}`}
                  label={`${ruleLabel} screenshot`}
                  previewClassName="block max-h-64 w-auto max-w-full rounded-lg object-contain object-center"
                />
              </div>
            )}

            {!screenshot && pageCapture && (
              <div className="mt-2 space-y-2">
                <p className="text-[11px] text-muted-foreground">
                  A focused screenshot was not available for this occurrence.
                </p>
                <IssueScreenshotLightbox
                  src={elementScreenshotUrl(pageCapture.path)}
                  alt={`Page capture for ${ruleLabel}`}
                  label={pageCapture.label}
                  triggerLabel="Open page capture"
                />
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

function IssueDetailLoading() {
  return (
    <div className="space-y-3 border-t px-4 pb-4 pt-3">
      <div className="rounded-lg border bg-muted/20 p-4 text-sm text-muted-foreground">
        Loading issue details…
      </div>
    </div>
  );
}

function IssueCard({
  scanId,
  item,
  reportSettings,
  onFalsePositiveChange,
}: {
  scanId: string;
  item: IssueSummaryItem;
  reportSettings: ReportSettings;
  onFalsePositiveChange: (issueId: string, isFalsePositive: boolean) => void;
}) {
  const [summary, setSummary] = useState(item);
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<IssueDetailResponse | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [loadingMoreOccurrences, setLoadingMoreOccurrences] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  useEffect(() => {
    setSummary(item);
  }, [item]);

  const loadDetail = useCallback(async ({
    occurrenceOffset,
    append,
  }: {
    occurrenceOffset: number;
    append: boolean;
  }) => {
    const params = new URLSearchParams({
      kind: summary.kind,
      key: summary.kind === "failed" ? summary.issueId : summary.ruleId,
      occurrenceOffset: String(occurrenceOffset),
      occurrenceLimit: String(ISSUE_OCCURRENCES_PAGE_SIZE),
    });
    const response = await fetch(`/api/scans/${scanId}/issues/details?${params}`, {
      cache: "no-store",
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || "Failed to load issue details");
    }

    const payload = (await response.json()) as IssueDetailRouteResponse;
    setSummary(payload.summary);
    setDetail((currentDetail) => {
      if (!append || !currentDetail) {
        return payload.detail;
      }

      return {
        ...payload.detail,
        occurrences: [
          ...currentDetail.occurrences,
          ...payload.detail.occurrences,
        ],
      };
    });
  }, [scanId, summary]);

  useEffect(() => {
    if (!open || detail || loadingDetail) {
      return;
    }

    let cancelled = false;
    setLoadingDetail(true);
    setDetailError(null);

    loadDetail({ occurrenceOffset: 0, append: false })
      .catch((error) => {
        if (!cancelled) {
          setDetailError(
            error instanceof Error ? error.message : "Failed to load issue details"
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingDetail(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [detail, loadDetail, loadingDetail, open]);

  const handleLoadMoreOccurrences = async () => {
    if (!detail || loadingMoreOccurrences) {
      return;
    }

    setLoadingMoreOccurrences(true);
    setDetailError(null);
    try {
      await loadDetail({
        occurrenceOffset: detail.occurrences.length,
        append: true,
      });
    } catch (error) {
      setDetailError(
        error instanceof Error ? error.message : "Failed to load more occurrences"
      );
    } finally {
      setLoadingMoreOccurrences(false);
    }
  };

  const ruleLabel =
    summary.kind === "failed" ? summary.violationType : summary.ruleId;
  const exportActionsEnabled =
    reportSettings.pdfReportsEnabled ||
    reportSettings.csvReportsEnabled ||
    reportSettings.llmReportsEnabled;
  const headerPaddingClass =
    summary.kind === "failed"
      ? exportActionsEnabled
        ? "pr-56 sm:pr-72"
        : "pr-16 sm:pr-20"
      : exportActionsEnabled
        ? "pr-16"
        : "pr-4";

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <section
        id={`rule-${ruleLabel}`}
        data-issue-card={summary.kind === "failed" ? "true" : undefined}
        data-false-positive={
          summary.kind === "failed" && summary.isFalsePositive ? "true" : "false"
        }
        className="overflow-hidden rounded-xl border bg-card"
      >
        <div className="relative">
          <CollapsibleTrigger
            aria-label={`Toggle details for ${summary.title}`}
            className="issue-card-trigger peer absolute inset-0 rounded-xl transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          />

          <div
            className={cn(
              "issue-card-header pointer-events-none relative z-10 flex items-start gap-3 p-4",
              headerPaddingClass
            )}
          >
            <div className="issue-expander mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-background text-muted-foreground transition-all duration-200">
              <ChevronRightIcon
                className={cn(
                  "h-4 w-4 transition-transform duration-200",
                  open && "rotate-90"
                )}
              />
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                {summary.kind === "failed" ? (
                  <>
                    <SeverityBadge severity={summary.severity} />
                    {summary.scored ? (
                      <Badge variant="outline">Weight {summary.weight}</Badge>
                    ) : (
                      <Badge variant="secondary">Not scored</Badge>
                    )}
                    {summary.isFalsePositive && (
                      <Badge variant="secondary">False positive</Badge>
                    )}
                  </>
                ) : (
                  <>
                    <AuditStatusBadge status="needs_review" />
                    {summary.scored ? (
                      <Badge variant="outline">Weight {summary.weight}</Badge>
                    ) : (
                      <Badge variant="secondary">Not scored</Badge>
                    )}
                  </>
                )}

                <span className="text-[11px] font-medium text-muted-foreground">
                  {formatOccurrenceLabel(detail?.occurrenceCount ?? summary.occurrenceCount)}
                </span>
              </div>

              {summary.helpUrl ? (
                <a
                  href={summary.helpUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="pointer-events-auto mt-2 inline-flex max-w-full items-start gap-1 font-heading text-[15px] font-bold leading-tight text-foreground hover:underline"
                >
                  <span className="issue-card-heading truncate sm:whitespace-normal">
                    {summary.title}
                  </span>
                  <ExternalLinkIcon className="mt-0.5 h-3 w-3 shrink-0" />
                </a>
              ) : (
                <h2 className="issue-card-heading mt-2 font-heading text-[15px] font-bold leading-tight text-foreground">
                  {summary.title}
                </h2>
              )}

              {detail &&
                ((detail.kind === "failed" &&
                  shouldShowRuleDescription(
                    detail.title,
                    detail.axeRuleDescription
                  )) ||
                  (detail.kind === "needs_review" &&
                    shouldShowRuleDescription(
                      detail.title,
                      detail.ruleDescription
                    ))) && (
                  <p className="mt-1 max-w-3xl text-sm leading-5 text-muted-foreground">
                    {detail.kind === "failed"
                      ? detail.axeRuleDescription
                      : detail.ruleDescription}
                  </p>
                )}
            </div>
          </div>

          <div className="absolute right-4 top-4 z-20 flex items-start gap-2">
            <IssueCardReportDownloadButton
              scanId={scanId}
              scope={{
                kind: summary.kind,
                key: summary.kind === "failed" ? summary.issueId : summary.ruleId,
              }}
              issueTitle={summary.title}
              settings={reportSettings}
            />
            {summary.kind === "failed" && (
              <IssueFalsePositiveButton
                scanId={scanId}
                issueId={summary.issueId}
                isFalsePositive={summary.isFalsePositive}
                onFalsePositiveChange={onFalsePositiveChange}
              />
            )}
          </div>
        </div>

        <CollapsibleContent>
          {!open ? null : loadingDetail && !detail ? (
            <IssueDetailLoading />
          ) : detailError && !detail ? (
            <div className="space-y-3 border-t px-4 pb-4 pt-3">
              <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-4 text-sm text-destructive">
                {detailError}
              </div>
            </div>
          ) : detail ? (
            <div className="space-y-4 border-t px-4 pb-4 pt-3">
              {buildSuggestedChangesSummary(detail.suggestedFixes) && (
                <section className="rounded-lg border border-[#0E5A4A]/20 bg-[#E7FFF6] p-4 text-[#0F172A]">
                  <h3 className="font-heading text-base font-bold text-[#0F172A]">
                    Suggested changes
                  </h3>
                  <p className="mt-2 text-sm leading-5 text-[#0F172A]/80">
                    {buildSuggestedChangesSummary(detail.suggestedFixes)}
                  </p>
                </section>
              )}

              {detail.actRules.length > 0 ? (
                <section className="space-y-2">
                  {detail.actRules.length === 2 &&
                  areAlternativeACTRules(detail.actRules[0], detail.actRules[1]) ? (
                    <div className="flex flex-col items-center gap-3 lg:flex-row lg:items-stretch">
                      <div className="w-full lg:flex-1">
                        <ACTRuleCard
                          actRule={detail.actRules[0]}
                          complianceReferences={detail.complianceReferences}
                        />
                      </div>
                      <AlternativeRuleBinder />
                      <div className="w-full lg:flex-1">
                        <ACTRuleCard
                          actRule={detail.actRules[1]}
                          complianceReferences={detail.complianceReferences}
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="grid gap-3 lg:grid-cols-2">
                      {detail.actRules.map((actRule) => (
                        <ACTRuleCard
                          key={actRule.actRuleId}
                          actRule={actRule}
                          complianceReferences={detail.complianceReferences}
                        />
                      ))}
                    </div>
                  )}
                </section>
              ) : (
                <section>
                  <BaseRuleGuidanceCard
                    description={detail.title}
                    helpUrl={detail.helpUrl}
                    accessibilityRequirements={detail.complianceReferences}
                  />
                </section>
              )}

              <IssueOccurrenceList occurrences={detail.occurrences} ruleLabel={ruleLabel} />

              {detail.hasMoreOccurrences && (
                <div className="flex flex-col items-start gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={loadingMoreOccurrences}
                    onClick={handleLoadMoreOccurrences}
                  >
                    {loadingMoreOccurrences ? (
                      <Loader2Icon className="animate-spin" />
                    ) : null}
                    Load more occurrences
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    Showing {detail.occurrences.length} of {detail.occurrenceCount}{" "}
                    occurrences.
                  </p>
                </div>
              )}

              {detailError && (
                <p className="text-sm text-destructive">{detailError}</p>
              )}
            </div>
          ) : null}
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

function LoadingIssueCards() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 3 }).map((_, index) => (
        <div
          key={index}
          className="rounded-xl border bg-card p-4 text-sm text-muted-foreground"
        >
          Loading issue…
        </div>
      ))}
    </div>
  );
}

export function IssueDetailsFeed({
  scanId,
  initialItems,
  totalItemCount,
  reportSettings,
}: IssueDetailsFeedProps) {
  const [items, setItems] = useState(initialItems);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);

  const hasMore = items.length < totalItemCount;

  const handleFalsePositiveChange = useCallback(
    (issueId: string, isFalsePositive: boolean) => {
      setItems((currentItems) =>
        currentItems
          .map((item) =>
            item.kind === "failed" && item.issueId === issueId
              ? { ...item, isFalsePositive }
              : item
          )
          .sort(compareIssueSummaryItems)
      );
    },
    []
  );

  const loadMore = useCallback(async () => {
    if (isLoadingMore || !hasMore) {
      return;
    }

    setIsLoadingMore(true);
    setLoadMoreError(null);
    try {
      const params = new URLSearchParams({
        offset: String(items.length),
        limit: String(ISSUE_SUMMARIES_PAGE_SIZE),
      });
      const response = await fetch(`/api/scans/${scanId}/issues/chunks?${params}`, {
        cache: "no-store",
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || "Failed to load more issues");
      }

      const payload = (await response.json()) as {
        items: IssueSummaryItem[];
      };

      setItems((currentItems) => [
        ...currentItems,
        ...payload.items.filter(
          (nextItem) =>
            !currentItems.some(
              (currentItem) =>
                currentItem.kind === nextItem.kind &&
                currentItem.key === nextItem.key
            )
        ),
      ].sort(compareIssueSummaryItems));
    } catch (error) {
      setLoadMoreError(
        error instanceof Error ? error.message : "Failed to load more issues"
      );
    } finally {
      setIsLoadingMore(false);
    }
  }, [hasMore, isLoadingMore, items.length, scanId]);

  return (
    <div className="space-y-3">
      {items.map((item) => (
        <IssueCard
          key={`${item.kind}-${item.key}`}
          scanId={scanId}
          item={item}
          reportSettings={reportSettings}
          onFalsePositiveChange={handleFalsePositiveChange}
        />
      ))}

      {hasMore && (
        <div className="space-y-3">
          {isLoadingMore && <LoadingIssueCards />}
          {!isLoadingMore && (
            <div className="rounded-xl border border-dashed bg-card p-4 text-sm text-muted-foreground">
              Loaded {items.length} of {totalItemCount} issue groups. Load the
              next batch when you need it.
            </div>
          )}
          <Button
            type="button"
            variant="outline"
            disabled={isLoadingMore}
            onClick={() => void loadMore()}
          >
            {isLoadingMore ? <Loader2Icon className="animate-spin" /> : null}
            Load more issues
          </Button>
        </div>
      )}

      {!hasMore && totalItemCount > initialItems.length && (
        <div className="rounded-xl border border-dashed bg-card p-4 text-sm text-muted-foreground">
          All {totalItemCount} issue groups are loaded.
        </div>
      )}

      {loadMoreError && (
        <p className="text-sm text-destructive">{loadMoreError}</p>
      )}
    </div>
  );
}
