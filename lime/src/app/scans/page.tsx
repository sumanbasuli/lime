import Link from "next/link";
import { db } from "@/db";
import { scans } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { ActiveScansRefresh } from "@/components/active-scans-refresh";
import { ScanActions } from "@/components/scan-actions";
import {
  StatusBadge,
  ScanScoreBadge,
  ScanTypeBadge,
  TagBadge,
} from "@/components/status-badge";
import { measureServerAction } from "@/lib/performance-logging";
import { getScanScoreSummaries } from "@/lib/scan-score-data";
import type { ScanScoreSummary } from "@/lib/scan-scoring";

export const dynamic = "force-dynamic";

function formatDate(value: string | Date | null | undefined): string {
  if (!value) {
    return "—";
  }

  return new Date(value).toLocaleDateString();
}

function formatScanCoverage(
  scan: { status: string | null; scannedUrls: number | null; totalUrls: number | null },
  summary: ScanScoreSummary
): string {
  if (summary.isPartialScan) {
    return `${summary.completedUrlCount} completed, ${summary.failedUrlCount} failed`;
  }

  if (
    summary.totalUrlCount > 0 &&
    (scan.status === "completed" || scan.status === "paused" || scan.status === "failed")
  ) {
    return `${summary.completedUrlCount}/${summary.totalUrlCount} completed`;
  }

  return `${scan.scannedUrls ?? 0}/${scan.totalUrls ?? 0} pages`;
}

export default async function ScansPage({
  searchParams,
}: {
  searchParams: Promise<{ tag?: string }>;
}) {
  const params = await searchParams;
  const tagFilter = params.tag;

  const [allScans, allScansForTags] = await measureServerAction(
    "scans list data",
    () =>
      Promise.all([
        tagFilter
          ? db
              .select()
              .from(scans)
              .where(eq(scans.tag, tagFilter))
              .orderBy(desc(scans.createdAt))
          : db.select().from(scans).orderBy(desc(scans.createdAt)),
        db.select({ tag: scans.tag }).from(scans).orderBy(scans.tag),
      ])
  );
  const scoreSummaries = await measureServerAction(
    "scans score summaries",
    () =>
      getScanScoreSummaries(
        allScans.map((scan) => ({
          id: scan.id,
          status: scan.status ?? "pending",
          updatedAt: scan.updatedAt,
        }))
      )
  );
  const hasActiveScans = allScans.some(
    (scan) =>
      scan.pauseRequested ||
      (scan.status !== "completed" &&
        scan.status !== "paused" &&
        scan.status !== "failed")
  );

  const uniqueTags = [
    ...new Set(
      allScansForTags
        .map((scan) => scan.tag)
        .filter((tag): tag is string => tag !== null)
    ),
  ];

  return (
    <div className="space-y-4">
      <ActiveScansRefresh enabled={hasActiveScans} />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="font-heading text-3xl font-bold leading-[0.95] sm:text-4xl">
          {tagFilter ? `Scans tagged "${tagFilter}"` : "All scans"}
        </h1>
        <Link
          href="/scans/new"
          className="inline-flex h-10 items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          New scan
        </Link>
      </div>

      {uniqueTags.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-medium text-muted-foreground">
            Filter by tag
          </span>
          <Link
            href="/scans"
            className={`inline-flex items-center rounded-full border px-3 py-1.5 text-sm font-medium transition-colors ${
              !tagFilter
                ? "bg-primary text-primary-foreground"
                : "bg-background hover:bg-muted"
            }`}
          >
            All
          </Link>
          {uniqueTags.map((tag) => (
            <Link
              key={tag}
              href={`/scans?tag=${encodeURIComponent(tag)}`}
              className={`inline-flex items-center rounded-full border px-3 py-1.5 text-sm font-medium transition-colors ${
                tagFilter === tag
                  ? "bg-primary text-primary-foreground"
                  : "bg-background hover:bg-muted"
              }`}
            >
              {tag}
            </Link>
          ))}
        </div>
      )}

      <section className="rounded-xl border bg-card p-4">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="pb-3 pr-4 text-[11px] font-medium">
                  Target URL
                </th>
                <th className="pb-3 pr-4 text-[11px] font-medium">Type</th>
                <th className="pb-3 pr-4 text-[11px] font-medium">Tag</th>
                <th className="pb-3 pr-4 text-[11px] font-medium">Status</th>
                <th className="pb-3 pr-4 text-[11px] font-medium">Score</th>
                <th className="pb-3 pr-4 text-[11px] font-medium">Progress</th>
                <th className="pb-3 text-[11px] font-medium">Started</th>
                <th className="pb-3 pl-4 text-right text-[11px] font-medium">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {allScans.length === 0 ? (
                <tr>
                  <td
                    colSpan={8}
                    className="py-12 text-center text-muted-foreground"
                  >
                    {tagFilter ? (
                      <>
                        No scans with tag &quot;{tagFilter}&quot;.{" "}
                        <Link href="/scans" className="underline">
                          View all scans
                        </Link>
                        .
                      </>
                    ) : (
                      <>
                        No scans yet.{" "}
                        <Link href="/scans/new" className="underline">
                          Start your first scan
                        </Link>
                        .
                      </>
                    )}
                  </td>
                </tr>
              ) : (
                allScans.map((scan) => {
                  const scoreSummary = scoreSummaries[scan.id];

                  return (
                  <tr key={scan.id} className="border-b last:border-0">
                    <td className="max-w-xs py-3 pr-4 truncate">
                      <Link
                        href={`/scans/${scan.id}`}
                        className="hover:underline"
                      >
                        {scan.sitemapUrl}
                      </Link>
                    </td>
                    <td className="py-3 pr-4">
                      <ScanTypeBadge scanType={scan.scanType ?? "sitemap"} />
                    </td>
                    <td className="py-3 pr-4">
                      {scan.tag ? (
                        <Link href={`/scans?tag=${encodeURIComponent(scan.tag)}`}>
                          <TagBadge tag={scan.tag} />
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="py-3 pr-4">
                      <StatusBadge
                        status={scan.status ?? "pending"}
                        summary={scoreSummary}
                      />
                    </td>
                    <td className="py-3 pr-4">
                      <ScanScoreBadge
                        status={scan.status ?? "pending"}
                        summary={scoreSummary}
                      />
                    </td>
                    <td className="py-3 pr-4">
                      {formatScanCoverage(scan, scoreSummary)}
                    </td>
                    <td className="py-3 text-muted-foreground">
                      {formatDate(scan.createdAt)}
                    </td>
                    <td className="py-3 pl-4 text-right">
                      <ScanActions
                        scanId={scan.id}
                        status={scan.status ?? "pending"}
                        pauseRequested={scan.pauseRequested ?? false}
                        isPartialScan={scoreSummary.isPartialScan}
                        className="items-end"
                      />
                    </td>
                  </tr>
                )})
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
