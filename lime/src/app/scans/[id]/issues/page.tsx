import Link from "next/link";
import { notFound } from "next/navigation";
import { redactUrlUserinfo } from "@/lib/url-presentation";
import { count, eq } from "drizzle-orm";
import { MaterialSymbol } from "@/components/material-symbol";
import { db } from "@/db";
import { scans, urls } from "@/db/schema";
import { IssueDetailsFeed } from "@/components/issue-details-feed";
import { IssueReportDownloadButton } from "@/components/issue-report-download-button";
import {
  ISSUE_SUMMARIES_PAGE_SIZE,
  loadIssueSummariesPage,
} from "@/lib/scan-issues";
import { measureServerAction } from "@/lib/performance-logging";
import { getReportSettings } from "@/lib/report-settings";

export const dynamic = "force-dynamic";

interface IssuesPageProps {
  params: Promise<{ id: string }>;
}

function formatDomain(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return redactUrlUserinfo(value);
  }
}

export default async function IssuesPage({ params }: IssuesPageProps) {
  const { id } = await params;

  const [scan] = await measureServerAction(
    `issues page scan ${id}`,
    () => db.select().from(scans).where(eq(scans.id, id)),
    250
  );
  if (!scan) {
    notFound();
  }

  const [reportSettings, urlCoverageRows, initialIssuePage] =
    await measureServerAction(`issues page initial data ${id}`, () =>
      Promise.all([
        getReportSettings(),
        db
          .select({
            status: urls.status,
            urlCount: count(),
          })
          .from(urls)
          .where(eq(urls.scanId, scan.id))
          .groupBy(urls.status),
        loadIssueSummariesPage(id, 0, ISSUE_SUMMARIES_PAGE_SIZE),
      ])
    );

  const {
    excludedIssueCount,
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
    <div className="mx-auto w-full max-w-[1180px] space-y-5">
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <Link href="/scans" className="transition-colors hover:text-foreground">
          Scans
        </Link>
        <MaterialSymbol name="chevron_right" size={15} />
        <Link
          href={`/scans/${id}`}
          className="truncate transition-colors hover:text-foreground"
        >
          {formatDomain(scan.sitemapUrl)}
        </Link>
        <MaterialSymbol name="chevron_right" size={15} />
        <span>Issues</span>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <h1 className="font-heading text-[34px] font-semibold leading-[1.05] tracking-[-0.01em]">Issue details</h1>
          <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
            Showing {initialIssuePage.items.length} of {totalIssueCardCount} issue groups · grouped by rule,
            ordered by severity
            {excludedIssueCount > 0 ? ` · ${excludedIssueCount} excluded` : ""}
            {isPartialScan ? ` · ${coverage.completedUrlCount} of ${coverage.totalUrlCount} pages completed` : ""}
          </p>
        </div>

        <IssueReportDownloadButton scanId={id} settings={reportSettings} />
      </div>

      {totalIssueCardCount === 0 ? (
        <section className="lime-card p-12 text-center text-muted-foreground">
          No failed or review-required checks found for this scan.
        </section>
      ) : (
        <IssueDetailsFeed
          scanId={id}
          initialItems={initialIssuePage.items}
          totalItemCount={totalIssueCardCount}
          reportSettings={reportSettings}
        />
      )}
    </div>
  );
}
