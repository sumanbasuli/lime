import Link from "next/link";
import { notFound } from "next/navigation";
import { count, eq } from "drizzle-orm";
import { ChevronRightIcon } from "lucide-react";
import { db } from "@/db";
import { scans, urls } from "@/db/schema";
import { IssueDetailsFeed } from "@/components/issue-details-feed";
import { IssueReportDownloadButton } from "@/components/issue-report-download-button";
import {
  ISSUE_SUMMARIES_PAGE_SIZE,
  loadIssueSummariesPage,
} from "@/lib/scan-issues";

export const dynamic = "force-dynamic";

interface IssuesPageProps {
  params: Promise<{ id: string }>;
}

export default async function IssuesPage({ params }: IssuesPageProps) {
  const { id } = await params;

  const [scan] = await db.select().from(scans).where(eq(scans.id, id));
  if (!scan) {
    notFound();
  }

  const [urlCoverageRows, initialIssuePage] = await Promise.all([
    db
      .select({
        status: urls.status,
        urlCount: count(),
      })
      .from(urls)
      .where(eq(urls.scanId, scan.id))
      .groupBy(urls.status),
    loadIssueSummariesPage(id, 0, ISSUE_SUMMARIES_PAGE_SIZE),
  ]);

  const {
    activeIssueCount,
    excludedIssueCount,
    needsReviewCount,
    totalIssueCardCount,
  } = initialIssuePage.counts;
  const coverage = urlCoverageRows.reduce(
    (summary, row) => {
      summary.totalUrlCount += row.urlCount;
      if (row.status === "completed") {
        summary.completedUrlCount += row.urlCount;
      }
      if (row.status === "failed") {
        summary.failedUrlCount += row.urlCount;
      }
      return summary;
    },
    {
      completedUrlCount: 0,
      failedUrlCount: 0,
      totalUrlCount: 0,
    }
  );
  const isSettled = scan.status === "completed" || scan.status === "paused";
  const hasAttemptedCoverage =
    coverage.completedUrlCount > 0 || coverage.failedUrlCount > 0;
  const hasFullCoverage =
    isSettled &&
    coverage.totalUrlCount > 0 &&
    coverage.failedUrlCount === 0 &&
    coverage.completedUrlCount === coverage.totalUrlCount;
  const isPartialScan =
    isSettled &&
    coverage.totalUrlCount > 0 &&
    hasAttemptedCoverage &&
    !hasFullCoverage;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <Link href="/scans" className="transition-colors hover:text-foreground">
          Scans
        </Link>
        <ChevronRightIcon className="h-3.5 w-3.5" />
        <Link
          href={`/scans/${id}`}
          className="truncate transition-colors hover:text-foreground"
        >
          {scan.sitemapUrl}
        </Link>
        <ChevronRightIcon className="h-3.5 w-3.5" />
        <span>Issues</span>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <h1 className="font-heading text-3xl font-bold leading-[0.95] sm:text-4xl">
            Issue details{" "}
            <span className="font-sans text-sm font-medium text-muted-foreground">
              ({totalIssueCardCount})
            </span>
          </h1>
          <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
            {activeIssueCount} failed {activeIssueCount === 1 ? "check" : "checks"}
            {needsReviewCount > 0 &&
              `, ${needsReviewCount} ${
                needsReviewCount === 1 ? "check needs" : "checks need"
              } review`}
            {excludedIssueCount > 0 &&
              `, ${excludedIssueCount} excluded from the score`}
            {isPartialScan &&
              `, based on ${coverage.completedUrlCount} of ${coverage.totalUrlCount} completed pages`}
            . Passed and not applicable checks remain on the scan details page.
          </p>
        </div>

        <IssueReportDownloadButton scanId={id} />
      </div>

      {totalIssueCardCount === 0 ? (
        <section className="rounded-xl border bg-card p-12 text-center text-muted-foreground">
          No failed or review-required checks found for this scan.
        </section>
      ) : (
        <IssueDetailsFeed
          scanId={id}
          initialItems={initialIssuePage.items}
          totalItemCount={totalIssueCardCount}
        />
      )}
    </div>
  );
}
