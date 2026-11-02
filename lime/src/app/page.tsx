import Link from "next/link";
import { db } from "@/db";
import { scans, issues } from "@/db/schema";
import { and, count, desc, eq, sql } from "drizzle-orm";
import { ActiveScansRefresh } from "@/components/active-scans-refresh";
import {
  StatusBadge,
  ScanScoreBadge,
  ScanTypeBadge,
  TagBadge,
} from "@/components/status-badge";
import { MaterialSymbol } from "@/components/material-symbol";
import { measureServerAction } from "@/lib/performance-logging";
import { getScanScoreSummaries } from "@/lib/scan-score-data";
import type { ScanScoreSummary } from "@/lib/scan-scoring";
import { redactUrlUserinfo } from "@/lib/url-presentation";

export const dynamic = "force-dynamic";

function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "—";

  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function formatDashboardDate(): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date());
}

function formatTarget(value: string): { domain: string; url: string } {
  try {
    const parsed = new URL(value);
    return {
      domain: parsed.hostname.replace(/^www\./, ""),
      url: redactUrlUserinfo(value),
    };
  } catch {
    const redacted = redactUrlUserinfo(value);
    return { domain: redacted, url: redacted };
  }
}

function formatScanCoverage(
  scan: { status: string | null; scannedUrls: number | null; totalUrls: number | null },
  summary: ScanScoreSummary
): string {
  if (summary.isPartialScan) {
    return `${summary.completedUrlCount} done, ${summary.failedUrlCount} failed`;
  }

  if (
    summary.totalUrlCount > 0 &&
    (scan.status === "completed" || scan.status === "paused" || scan.status === "failed")
  ) {
    return `${summary.completedUrlCount}/${summary.totalUrlCount} pages`;
  }

  return `${scan.scannedUrls ?? 0}/${scan.totalUrls ?? 0} pages`;
}

export default async function Home() {
  const [recentScans, [scanCount], [issueCount], [criticalCount], [pageCount]] =
    await measureServerAction("dashboard initial data", () =>
      Promise.all([
        db.select().from(scans).orderBy(desc(scans.createdAt)).limit(12),
        db.select({ value: count() }).from(scans),
        db
          .select({ value: count() })
          .from(issues)
          .where(eq(issues.isFalsePositive, false)),
        db
          .select({ value: count() })
          .from(issues)
          .where(
            and(
              eq(issues.isFalsePositive, false),
              eq(issues.severity, "critical")
            )
          ),
        db
          .select({ value: sql<number>`COALESCE(SUM(${scans.scannedUrls}), 0)` })
          .from(scans),
      ])
    );

  const scoreSummaries = await measureServerAction(
    "dashboard score summaries",
    () =>
      getScanScoreSummaries(
        recentScans.map((scan) => ({
          id: scan.id,
          status: scan.status ?? "pending",
          updatedAt: scan.updatedAt,
        }))
      )
  );

  const activeScans = recentScans.filter(
    (scan) =>
      scan.pauseRequested ||
      (scan.status !== "completed" &&
        scan.status !== "paused" &&
        scan.status !== "failed")
  );
  const activeScan = activeScans[0];
  const visibleScans = recentScans.slice(0, 6);
  const scoreValues = Object.values(scoreSummaries)
    .filter(
      (summary): summary is ScanScoreSummary & { score: number } =>
        summary.hasScore && summary.score !== null
    )
    .map((summary) => summary.score);
  const averageScore = scoreValues.length
    ? Math.round(scoreValues.reduce((total, score) => total + score, 0) / scoreValues.length)
    : null;
  const averageBars = averageScore === null ? 0 : Math.round(averageScore / 10);
  const activeProgress = activeScan?.totalUrls
    ? Math.min(
        100,
        Math.round(((activeScan.scannedUrls ?? 0) / activeScan.totalUrls) * 100)
      )
    : 0;

  return (
    <div className="mx-auto min-w-0 w-full max-w-[1180px] space-y-4 lg:space-y-5">
      <ActiveScansRefresh enabled={activeScans.length > 0} />

      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="lime-eyebrow">{formatDashboardDate()}</p>
          <h1 className="lime-page-title mt-2">Overview</h1>
        </div>
        <p className="text-xs text-muted-foreground sm:pb-1">
          All sites monitored by this workspace
        </p>
      </div>

      <section aria-label="Workspace summary" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <article className="rounded-[20px] border border-black bg-black p-5 text-white shadow-sm">
          <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-white/55">
            Average score
          </p>
          <div className="mt-3 flex items-end gap-3">
            <p className="font-heading text-[44px] font-semibold leading-[0.8] text-[#FFED00]">
              {averageScore ?? "—"}
            </p>
            <div className="mb-0.5 flex h-7 items-end gap-1" aria-hidden="true">
              {Array.from({ length: 10 }, (_, index) => (
                <span
                  key={index}
                  className={`w-1 rounded-full ${index < averageBars ? "bg-[#FFED00]" : "bg-white/28"}`}
                  style={{ height: `${10 + index * 2}px` }}
                />
              ))}
            </div>
          </div>
          <p className="mt-3 text-[11px] text-white/55">
            {scoreValues.length > 0
              ? `Across ${scoreValues.length} recent scored ${scoreValues.length === 1 ? "scan" : "scans"}`
              : "Complete a scan to establish a baseline"}
          </p>
        </article>

        <article className="lime-card p-5">
          <p className="lime-eyebrow">Total scans</p>
          <p className="mt-3 font-heading text-[42px] font-semibold leading-none">
            {scanCount?.value ?? 0}
          </p>
          <p className="mt-3 text-[11px] text-muted-foreground">All scan types</p>
        </article>

        <article className="lime-card p-5">
          <p className="lime-eyebrow">Open issue groups</p>
          <p className="mt-3 font-heading text-[42px] font-semibold leading-none">
            {issueCount?.value ?? 0}
          </p>
          <p className="mt-3 text-[11px] text-[#8F2D31]">
            {criticalCount?.value ?? 0} critical
          </p>
        </article>

        <article className="lime-card p-5">
          <p className="lime-eyebrow">Pages scanned</p>
          <p className="mt-3 font-heading text-[42px] font-semibold leading-none">
            {Number(pageCount?.value ?? 0).toLocaleString()}
          </p>
          <p className="mt-3 text-[11px] text-muted-foreground">Across all scans</p>
        </article>
      </section>

      {activeScan ? (
        <Link
          href={`/scans/${activeScan.id}`}
          className="lime-card block p-4 transition-colors hover:border-black/20"
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="h-2.5 w-2.5 animate-pulse rounded-full border border-black/30 bg-[#FFED00]" />
            <span className="text-sm font-semibold">
              {activeScan.status === "profiling" ? "Profiling" : "Scanning"}{" "}
              {formatTarget(activeScan.sitemapUrl).domain}
            </span>
            <span className="text-xs text-muted-foreground">
              {activeScan.scannedUrls ?? 0} of {activeScan.totalUrls ?? 0} pages
            </span>
            <span className="ml-auto font-heading text-2xl font-semibold leading-none">
              {activeProgress}%
            </span>
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-black/[0.07]">
            <div
              className="h-full rounded-full bg-[#FFED00] transition-[width]"
              style={{ width: `${activeProgress}%` }}
            />
          </div>
        </Link>
      ) : null}

      <section className="min-w-0">
        <div className="mb-3 flex items-center justify-between gap-4">
          <h2 className="lime-section-title">Recent scans</h2>
          {visibleScans.length > 0 ? (
            <Link
              href="/scans"
              className="inline-flex h-9 items-center justify-center gap-2 rounded-full border border-black/10 bg-white px-4 text-xs font-semibold transition-colors hover:bg-black hover:text-[#FFED00]"
            >
              View all
              <MaterialSymbol name="arrow_forward" size={16} />
            </Link>
          ) : null}
        </div>

        <div className="lime-card min-w-0 max-w-full overflow-hidden">
          <div className="overflow-x-auto">
            <table className="lime-data-table w-full min-w-[960px] text-sm">
              <thead>
                <tr className="text-left">
                  <th>Target</th>
                  <th>Type</th>
                  <th>Tag</th>
                  <th>Status</th>
                  <th>Score</th>
                  <th>Coverage</th>
                  <th>Started</th>
                </tr>
              </thead>
              <tbody>
                {visibleScans.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-14 text-center text-muted-foreground">
                      No scans yet. Start a scan to see results here.
                    </td>
                  </tr>
                ) : (
                  visibleScans.map((scan) => {
                    const scoreSummary = scoreSummaries[scan.id];
                    const target = formatTarget(scan.sitemapUrl);

                    return (
                      <tr key={scan.id}>
                        <td className="max-w-[285px]">
                          <Link href={`/scans/${scan.id}`} className="block hover:text-[#1E7A4E]">
                            <span className="block truncate text-[13px] font-semibold">
                              {target.domain}
                            </span>
                            <span className="mt-0.5 block truncate font-mono text-[10px] text-black/40">
                              {target.url}
                            </span>
                          </Link>
                        </td>
                        <td><ScanTypeBadge scanType={scan.scanType ?? "sitemap"} /></td>
                        <td>
                          {scan.tag ? <TagBadge tag={scan.tag} /> : <span className="text-black/30">—</span>}
                        </td>
                        <td>
                          <StatusBadge status={scan.status ?? "pending"} summary={scoreSummary} />
                        </td>
                        <td>
                          <ScanScoreBadge status={scan.status ?? "pending"} summary={scoreSummary} />
                        </td>
                        <td className="whitespace-nowrap text-xs text-black/60">
                          {formatScanCoverage(scan, scoreSummary)}
                        </td>
                        <td className="whitespace-nowrap text-xs text-black/45">
                          {formatDate(scan.createdAt)}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}
