import Link from "next/link";
import { db } from "@/db";
import { scans } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { ActiveScansRefresh } from "@/components/active-scans-refresh";
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

  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function formatTarget(value: string): { domain: string; url: string } {
  try {
    const parsed = new URL(value);
    return { domain: parsed.hostname.replace(/^www\./, ""), url: value };
  } catch {
    return { domain: value, url: value };
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

export default async function ScansPage({
  searchParams,
}: {
  searchParams: Promise<{ tag?: string; q?: string }>;
}) {
  const params = await searchParams;
  const tagFilter = params.tag;
  const queryFilter = params.q?.trim().toLowerCase() ?? "";

  const [scansForTag, allScansForTags] = await measureServerAction(
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
  const allScans = queryFilter
    ? scansForTag.filter((scan) =>
        [scan.sitemapUrl, scan.tag, scan.status, scan.scanType].some((value) =>
          value?.toLowerCase().includes(queryFilter)
        )
      )
    : scansForTag;
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
  const scansHref = (tag?: string) => {
    const nextParams = new URLSearchParams();
    if (tag) nextParams.set("tag", tag);
    if (queryFilter) nextParams.set("q", params.q?.trim() ?? "");
    const queryString = nextParams.toString();
    return queryString ? `/scans?${queryString}` : "/scans";
  };

  return (
    <div className="mx-auto min-w-0 w-full max-w-[1180px] space-y-5">
      <ActiveScansRefresh enabled={hasActiveScans} />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="lime-page-title">
            {queryFilter
              ? `Results for “${params.q?.trim()}”`
              : tagFilter
                ? `Scans tagged “${tagFilter}”`
                : "All scans"}
          </h1>
        </div>
        <p className="text-xs text-muted-foreground sm:pb-1">
          {allScans.length} of {scansForTag.length} {scansForTag.length === 1 ? "scan" : "scans"}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
          <Link
            href={scansHref()}
            className={`inline-flex items-center rounded-full border px-4 py-2 text-xs font-semibold transition-colors ${
              !tagFilter
                ? "border-black bg-black text-[#FFED00]"
                : "border-black/10 bg-white hover:border-black/25"
            }`}
          >
            All
          </Link>
          {uniqueTags.map((tag) => (
            <Link
              key={tag}
              href={scansHref(tag)}
              className={`inline-flex items-center rounded-full border px-4 py-2 text-xs font-semibold transition-colors ${
                tagFilter === tag
                  ? "border-black bg-black text-[#FFED00]"
                  : "border-black/10 bg-white hover:border-black/25"
              }`}
            >
              {tag}
            </Link>
          ))}
      </div>

      <section className="lime-card min-w-0 max-w-full overflow-hidden">
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
              {allScans.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="py-14 text-center text-muted-foreground"
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
                  const target = formatTarget(scan.sitemapUrl);

                  return (
                  <tr key={scan.id}>
                    <td className="max-w-[300px]">
                      <Link
                        href={`/scans/${scan.id}`}
                        className="block hover:text-[#1E7A4E]"
                      >
                        <span className="block truncate text-[13px] font-semibold">{target.domain}</span>
                        <span className="mt-0.5 block truncate font-mono text-[10px] text-black/40">{target.url}</span>
                      </Link>
                    </td>
                    <td>
                      <ScanTypeBadge scanType={scan.scanType ?? "sitemap"} />
                    </td>
                    <td>
                      {scan.tag ? (
                        <Link href={`/scans?tag=${encodeURIComponent(scan.tag)}`}>
                          <TagBadge tag={scan.tag} />
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td>
                      <StatusBadge
                        status={scan.status ?? "pending"}
                        summary={scoreSummary}
                      />
                    </td>
                    <td>
                      <ScanScoreBadge
                        status={scan.status ?? "pending"}
                        summary={scoreSummary}
                      />
                    </td>
                    <td className="whitespace-nowrap text-xs text-black/60">
                      {formatScanCoverage(scan, scoreSummary)}
                    </td>
                    <td className="whitespace-nowrap text-xs text-muted-foreground">
                      {formatDate(scan.createdAt)}
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
