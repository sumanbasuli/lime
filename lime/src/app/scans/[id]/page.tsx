import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { scans, issues, issueOccurrences } from "@/db/schema";
import { eq, count } from "drizzle-orm";
import { AccessibilityScoreGauge } from "@/components/accessibility-score-gauge";
import { AuditResultsDataTable } from "@/components/audit-results-data-table";
import { ScanActions } from "@/components/scan-actions";
import { Button } from "@/components/ui/button";
import {
  StatusBadge,
  ScanTypeBadge,
  TagBadge,
} from "@/components/status-badge";
import { ScanProgress } from "@/components/scan-progress";
import { ArrowRightIcon, ChevronRightIcon } from "lucide-react";
import { formatViewportLabel } from "@/lib/viewport-presets";
import { getScanAuditReports } from "@/lib/scan-score-data";
import {
  getAccessibilityScoreBand,
  type ScanScoreSummary,
} from "@/lib/scan-scoring";

export const dynamic = "force-dynamic";

interface ScanDetailPageProps {
  params: Promise<{ id: string }>;
}

function formatTimestamp(value: string | Date | null | undefined): string {
  if (!value) {
    return "—";
  }

  return new Date(value).toLocaleString();
}

const severityCardStyles: Record<
  "critical" | "serious" | "moderate" | "minor",
  { accentClassName: string; label: string; valueClassName: string }
> = {
  critical: {
    accentClassName: "bg-[#8F2D31] text-white",
    label: "Critical",
    valueClassName: "text-[#0A0A0A]",
  },
  serious: {
    accentClassName: "bg-[#0A0A0A] text-white",
    label: "Serious",
    valueClassName: "text-[#0A0A0A]",
  },
  moderate: {
    accentClassName: "bg-[#FFED00] text-[#0A0A0A]",
    label: "Moderate",
    valueClassName: "text-[#0A0A0A]",
  },
  minor: {
    accentClassName: "border border-black/15 bg-white text-[#0A0A0A]",
    label: "Minor",
    valueClassName: "text-[#0A0A0A]",
  },
};

const scoreCardStyles: Record<
  "passed" | "failed" | "needs_review" | "excluded",
  { accentClassName: string; label: string }
> = {
  passed: {
    accentClassName: "bg-[#1E7A4E] text-white",
    label: "Passed",
  },
  failed: {
    accentClassName: "bg-[#8F2D31] text-white",
    label: "Failed",
  },
  needs_review: {
    accentClassName: "bg-[#FFED00] text-[#0A0A0A]",
    label: "Needs review",
  },
  excluded: {
    accentClassName: "border border-black/15 bg-white text-[#0A0A0A]",
    label: "Excluded",
  },
};

function getScoreSummaryCopy(summary: ScanScoreSummary, status: string): string {
  if (summary.isPartialScan && summary.hasScore && summary.score !== null) {
    return `This scan finished with ${summary.completedUrlCount} of ${summary.totalUrlCount} pages completed and ${summary.failedUrlCount} failed. The current accessibility score is based on completed pages only and may change after a full rerun.`;
  }

  if (summary.hasScore && summary.score !== null) {
    const band = getAccessibilityScoreBand(summary.score);
    return `${band.label} accessibility result. ${summary.weightedPassed} of ${summary.weightedTotal} weighted points passed across ${summary.scoredAuditCount} scored checks.`;
  }

  if (summary.isPartialScan) {
    return `This scan finished with ${summary.completedUrlCount} of ${summary.totalUrlCount} pages completed and ${summary.failedUrlCount} failed. The accessibility score is withheld for partial scans.`;
  }

  if (status === "failed") {
    return "This scan failed before a final accessibility score could be calculated.";
  }

  if (status !== "completed") {
    return "The score will finalize when completed pages finish processing.";
  }

  if (!summary.hasAuditData) {
    return "This scan does not have stored audit outcomes yet. Run a fresh scan to populate passed and failed checks.";
  }

  return "No scored accessibility audits were available for this scan.";
}

function getSeveritySummaryCopy(
  activeIssueCount: number,
  excludedIssueCount: number,
  isActive: boolean,
  isPartialScan: boolean
): string {
  if (activeIssueCount > 0 && excludedIssueCount > 0) {
    const base = `${activeIssueCount} active issue groups. ${excludedIssueCount} false positive${excludedIssueCount === 1 ? "" : "s"} excluded from scoring.`;
    return isPartialScan
      ? `${base} These counts reflect completed pages only.`
      : base;
  }

  if (activeIssueCount > 0) {
    const base = `${activeIssueCount} active issue group${activeIssueCount === 1 ? "" : "s"} ready for review.`;
    return isPartialScan
      ? `${base} These counts reflect completed pages only.`
      : base;
  }

  if (excludedIssueCount > 0) {
    const base = `No active issue groups. ${excludedIssueCount} false positive${excludedIssueCount === 1 ? "" : "s"} kept for reference only.`;
    return isPartialScan
      ? `${base} These counts reflect completed pages only.`
      : base;
  }

  if (isActive) {
    return "Issue groups will appear here as the scan completes more pages.";
  }

  if (isPartialScan) {
    return "No grouped failed checks were found in the completed pages for this partial scan.";
  }

  return "No grouped failed checks were found.";
}

function getAuditResultsCopy(summary: ScanScoreSummary, status: string): string {
  if (summary.isPartialScan) {
    return `Checks below are based on ${summary.completedUrlCount} of ${summary.totalUrlCount} completed pages. ${summary.failedUrlCount} page${summary.failedUrlCount === 1 ? "" : "s"} failed to scan, so the score reflects completed pages only.`;
  }

  if (status !== "completed") {
    return "Passed, failed, and review-required automated checks will appear here as pages finish processing.";
  }

  return "Passed, failed, and review-required automated checks listed in the same order used to calculate the overall score.";
}

function IssueDetailsButton({ scanId }: { scanId: string }) {
  return (
    <Button
      variant="outline"
      size="lg"
      nativeButton={false}
      className="rounded-full border-black/10 bg-white text-[#0A0A0A] hover:bg-black hover:text-[#FFED00]"
      render={<Link href={`/scans/${scanId}/issues`} />}
    >
      View issue details
      <ArrowRightIcon className="h-4 w-4" />
    </Button>
  );
}

export default async function ScanDetailPage({ params }: ScanDetailPageProps) {
  const { id } = await params;

  const [scan] = await db.select().from(scans).where(eq(scans.id, id));

  if (!scan) {
    notFound();
  }

  const scanIssues = await db
    .select({
      id: issues.id,
      violationType: issues.violationType,
      description: issues.description,
      severity: issues.severity,
      isFalsePositive: issues.isFalsePositive,
      createdAt: issues.createdAt,
      occurrenceCount: count(issueOccurrences.id),
    })
    .from(issues)
    .leftJoin(issueOccurrences, eq(issueOccurrences.issueId, issues.id))
    .where(eq(issues.scanId, id))
    .groupBy(issues.id);
  const auditReports = await getScanAuditReports([
    { id: scan.id, status: scan.status ?? "pending" },
  ]);
  const auditReport = auditReports[scan.id];
  const scoreSummary = auditReport.summary;
  const progressPercent =
    scan.totalUrls && scan.totalUrls > 0
      ? Math.round(((scan.scannedUrls ?? 0) / scan.totalUrls) * 100)
      : 0;

  const isActive =
    scan.status !== "completed" && scan.status !== "failed";
  const excludedIssueCount = scanIssues.filter(
    (issue) => issue.isFalsePositive
  ).length;
  const activeIssueCount = scanIssues.length - excludedIssueCount;
  const activeIssues = scanIssues.filter((issue) => !issue.isFalsePositive);

  const severityCounts = activeIssues.reduce(
    (acc, issue) => {
      const severity = issue.severity ?? "moderate";
      acc[severity] = (acc[severity] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  return (
    <div className="space-y-4">
      {isActive && (
        <ScanProgress scanId={scan.id} status={scan.status ?? "pending"} />
      )}

      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            <Link href="/scans" className="transition-colors hover:text-foreground">
              Scans
            </Link>
            <ChevronRightIcon className="h-3.5 w-3.5" />
            <span>Scan details</span>
          </div>

          <h1 className="font-heading text-3xl font-bold leading-[0.95] sm:text-4xl">
            Scan details
          </h1>
          <p className="max-w-3xl break-all text-sm leading-5 text-muted-foreground">
            {scan.sitemapUrl}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <ScanTypeBadge scanType={scan.scanType ?? "sitemap"} />
            {scan.tag && <TagBadge tag={scan.tag} />}
            <span className="text-xs text-muted-foreground">
              Screen size:{" "}
              {formatViewportLabel(
                scan.viewportPreset,
                scan.viewportWidth,
                scan.viewportHeight
              )}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 lg:justify-end">
          <StatusBadge
            status={scan.status ?? "pending"}
            summary={scoreSummary}
          />
          <ScanActions
            scanId={scan.id}
            status={scan.status ?? "pending"}
            redirectOnDelete="/scans"
          />
        </div>
      </div>

      {isActive && (
        <section className="rounded-[28px] border border-black/10 bg-white p-4 shadow-[0_20px_45px_rgba(10,10,10,0.05)]">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-heading text-[28px] font-bold leading-none text-[#0A0A0A]">
                Scan progress
              </h2>
              <p className="mt-2 text-sm leading-5 text-[#0A0A0A]/80">
                Progress appears here while pages are still being profiled,
                scanned, or processed.
              </p>
            </div>
            <div className="text-right">
              <p className="font-heading text-3xl font-bold leading-none text-[#0A0A0A]">
                {progressPercent}%
              </p>
              <p className="mt-1 text-xs text-[#0A0A0A]/75">
                {scan.scannedUrls ?? 0}/{scan.totalUrls ?? 0} pages
              </p>
            </div>
          </div>

          <div className="mt-4 h-2 overflow-hidden rounded-full bg-black/8">
            <div
              className="h-full rounded-full bg-[#FFED00]"
              style={{ width: `${progressPercent}%` }}
            />
          </div>

          <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[#0A0A0A]/75">
            <span>Started: {formatTimestamp(scan.createdAt)}</span>
            <span>Updated: {formatTimestamp(scan.updatedAt)}</span>
          </div>
        </section>
      )}

      <section className="space-y-4">
        <div className="rounded-[28px] border border-black/10 bg-white p-4 shadow-[0_20px_45px_rgba(10,10,10,0.06)]">
          <div>
            <h2 className="font-heading text-[28px] font-bold leading-none text-[#0A0A0A]">
              Accessibility score
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-5 text-[#0A0A0A]/80">
              {getScoreSummaryCopy(scoreSummary, scan.status ?? "pending")}
            </p>
          </div>

          <div className="mt-5 grid gap-4 lg:grid-cols-[232px_minmax(0,1fr)] lg:items-center">
            <AccessibilityScoreGauge
              summary={scoreSummary}
              status={scan.status ?? "pending"}
            />

            <div className="space-y-3">
              <div className="grid gap-2 md:grid-cols-4">
                <div className="rounded-2xl border border-black/10 bg-white p-3">
                  <div
                    className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.1em] ${scoreCardStyles.passed.accentClassName}`}
                  >
                    {scoreCardStyles.passed.label}
                  </div>
                  <p className="mt-2 font-heading text-3xl font-bold leading-none text-[#0A0A0A]">
                    {scoreSummary.passedCount}
                  </p>
                </div>
                <div className="rounded-2xl border border-black/10 bg-white p-3">
                  <div
                    className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.1em] ${scoreCardStyles.failed.accentClassName}`}
                  >
                    {scoreCardStyles.failed.label}
                  </div>
                  <p className="mt-2 font-heading text-3xl font-bold leading-none text-[#0A0A0A]">
                    {scoreSummary.failedCount}
                  </p>
                </div>
                <div className="rounded-2xl border border-black/10 bg-white p-3">
                  <div
                    className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.1em] ${scoreCardStyles.needs_review.accentClassName}`}
                  >
                    {scoreCardStyles.needs_review.label}
                  </div>
                  <p className="mt-2 font-heading text-3xl font-bold leading-none text-[#0A0A0A]">
                    {scoreSummary.needsReviewCount}
                  </p>
                </div>
                <div className="rounded-2xl border border-black/10 bg-white p-3">
                  <div
                    className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.1em] ${scoreCardStyles.excluded.accentClassName}`}
                  >
                    {scoreCardStyles.excluded.label}
                  </div>
                  <p className="mt-2 font-heading text-3xl font-bold leading-none text-[#0A0A0A]">
                    {scoreSummary.excludedCount}
                  </p>
                </div>
              </div>
              <p className="text-xs text-[#0A0A0A]/75">
                Not applicable: {scoreSummary.notApplicableCount}
              </p>
              <p className="text-xs text-[#0A0A0A]/75">
                Coverage: {scoreSummary.completedUrlCount}/{scoreSummary.totalUrlCount} completed
                {scoreSummary.failedUrlCount > 0
                  ? `, ${scoreSummary.failedUrlCount} failed`
                  : ""}
              </p>
            </div>
          </div>
        </div>

        <div className="rounded-[28px] border border-black/10 bg-white p-4 shadow-[0_20px_45px_rgba(10,10,10,0.06)]">
          <div>
            <div>
              <h2 className="font-heading text-[28px] font-bold leading-none text-[#0A0A0A]">
                Severity breakdown
              </h2>
              <p className="mt-2 max-w-xl text-sm leading-5 text-[#0A0A0A]/80">
                Active issue groups first, with false positives excluded from the
                score but still available below for reference.
              </p>
            </div>
          </div>

          <div className="mt-4 grid auto-rows-fr gap-2 md:grid-cols-4">
            {(["critical", "serious", "moderate", "minor"] as const).map(
              (severity) => {
                const config = severityCardStyles[severity];

                return (
                  <div
                    key={severity}
                    className="rounded-2xl border border-black/10 bg-white p-2.5"
                  >
                    <div
                      className={`inline-flex rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] ${config.accentClassName}`}
                    >
                      {config.label}
                    </div>
                    <p
                      className={`mt-2.5 font-heading text-3xl font-bold leading-none ${config.valueClassName}`}
                    >
                      {severityCounts[severity] || 0}
                    </p>
                    <p className="mt-1.5 text-[11px] text-[#0A0A0A]/75">
                      Active issue groups
                    </p>
                  </div>
                );
              }
            )}
          </div>

          <div className="mt-3 rounded-2xl border border-black/10 bg-[#FAFAFA] px-3.5 py-3 text-sm text-[#0A0A0A]/80">
            {getSeveritySummaryCopy(
              activeIssueCount,
              excludedIssueCount,
              isActive,
              scoreSummary.isPartialScan
            )}
          </div>
        </div>
      </section>

      <section className="rounded-[28px] border border-black/10 bg-white p-4 shadow-[0_20px_45px_rgba(10,10,10,0.05)]">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="font-heading text-[28px] font-bold leading-none text-[#0A0A0A]">
              Audit results
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-5 text-[#0A0A0A]/80">
              {getAuditResultsCopy(scoreSummary, scan.status ?? "pending")}
            </p>
          </div>

          {scanIssues.length > 0 && <IssueDetailsButton scanId={scan.id} />}
        </div>

        {!scoreSummary.hasAuditData ? (
          <div className="mt-4 rounded-2xl border border-dashed border-black/10 p-6 text-sm text-[#0A0A0A]/80">
            {scan.status === "completed"
              ? "This scan was created before audit outcomes were stored. Run a fresh scan to see passed checks and an out-of-100 Lighthouse-style score."
              : "Audit results will appear here once completed pages have been processed."}
          </div>
        ) : (
          <div className="mt-4">
            <AuditResultsDataTable audits={auditReport.audits} />
          </div>
        )}
      </section>
    </div>
  );
}
