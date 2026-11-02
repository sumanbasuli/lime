import Link from "next/link";
import { db } from "@/db";
import { scans } from "@/db/schema";
import { and, asc, count, desc, eq, ilike, isNotNull, or, sql } from "drizzle-orm";
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
import { redactUrlUserinfo } from "@/lib/url-presentation";

export const dynamic = "force-dynamic";

const scansPerPage = 50;
const maxPage = 1_000_000;
const maxSearchLength = 256;
const maxTagLength = 256;

function pageNumber(value: string | undefined): number {
  if (!value || !/^\d{1,7}$/.test(value)) return 1;
  const parsed = Number(value);
  return parsed >= 1 && parsed <= maxPage ? parsed : 1;
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function literalSearchPattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, "\\$&")}%`;
}

function displayTag(value: string): string {
  return value.length > 60 ? `${value.slice(0, 60)}…` : value;
}

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
    return { domain: parsed.hostname.replace(/^www\./, ""), url: redactUrlUserinfo(value) };
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

export default async function ScansPage({
  searchParams,
}: {
  searchParams: Promise<{ tag?: string | string[]; q?: string | string[]; page?: string | string[] }>;
}) {
  const params = await searchParams;
  const rawTagFilter = firstParam(params.tag) ?? "";
  const rawQueryFilter = firstParam(params.q)?.trim() ?? "";
  const queryTooLong = rawQueryFilter.length > maxSearchLength;
  const queryHasNul = rawQueryFilter.includes("\0");
  const tagTooLong = rawTagFilter.length > maxTagLength;
  const tagHasNul = rawTagFilter.includes("\0");
  const filterError = queryTooLong
    ? "Search terms must be 256 characters or fewer."
    : queryHasNul || tagHasNul
      ? "Search and tag filters contain an unsupported character."
      : tagTooLong
        ? "Tag filters must be 256 characters or fewer."
        : null;
  const tagFilter = filterError ? undefined : rawTagFilter || undefined;
  const queryFilter = filterError ? "" : rawQueryFilter;
  const requestedPage = pageNumber(firstParam(params.page));
  // Search the displayed URL, not credentials or query/fragment secrets in
  // the stored target. Normalize HTTP backslash forms before authority cleanup.
  const authorityNormalized = sql<string>`regexp_replace(${scans.sitemapUrl}, ${"^([a-z][a-z0-9+.-]*:)[/\\\\]*"}, ${"\\1//"}, 'i')`;
  const protocolRelativeCleaned = sql<string>`regexp_replace(${authorityNormalized}, ${"^//[^/?#]*@"}, ${"//"})`;
  const authorityCleaned = sql<string>`regexp_replace(${protocolRelativeCleaned}, ${"^([a-z][a-z0-9+.-]*://)[^/?#\\\\]*@"}, ${"\\1"}, 'i')`;
  const publicTargetWithTail = sql<string>`CASE WHEN ${scans.sitemapUrl} LIKE '//%'
    THEN ${authorityCleaned} WHEN ${authorityCleaned} <> ${authorityNormalized}
    THEN replace(${authorityCleaned}, chr(92), '/') ELSE ${scans.sitemapUrl} END`;
  const publicTarget = sql<string>`split_part(split_part(${publicTargetWithTail}, '?', 1), '#', 1)`;
  const pattern = literalSearchPattern(queryFilter);
  const filter = and(
    tagFilter ? eq(scans.tag, tagFilter) : undefined,
    queryFilter
      ? or(
          ilike(publicTarget, pattern),
          ilike(scans.tag, pattern),
          ilike(sql<string>`${scans.status}::text`, pattern),
          ilike(scans.scanType, pattern)
        )
      : undefined
  );
  const [countRows, tagRows] = await measureServerAction(
    "scans list counts and tags",
    () => Promise.all([
      filterError
        ? Promise.resolve([{ total: 0 }])
        : db.select({ total: count() }).from(scans).where(filter),
      filterError
        ? Promise.resolve([] as Array<{ tag: string | null }>)
        : db.selectDistinct({ tag: scans.tag }).from(scans)
            .where(and(isNotNull(scans.tag), sql`char_length(${scans.tag}) <= ${maxTagLength}`))
            .orderBy(asc(scans.tag)).limit(201),
    ])
  );
  const matchingTotal = Number(countRows[0]?.total ?? 0);
  const lastPage = Math.max(1, Math.min(maxPage, Math.ceil(matchingTotal / scansPerPage)));
  const page = Math.min(requestedPage, lastPage);
  const allScans = filterError ? [] : await measureServerAction(
    "scans list page",
    () => db.select({
      id: scans.id,
      sitemapUrl: sql<string>`left(${publicTarget}, 8192)`,
      status: scans.status,
      scanType: scans.scanType,
      tag: sql<string | null>`left(${scans.tag}, ${maxTagLength + 1})`,
      pauseRequested: scans.pauseRequested,
      scannedUrls: scans.scannedUrls,
      totalUrls: scans.totalUrls,
      createdAt: scans.createdAt,
      updatedAt: scans.updatedAt,
    }).from(scans).where(filter)
      .orderBy(desc(scans.createdAt), desc(scans.id))
      .limit(scansPerPage).offset((page - 1) * scansPerPage)
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
    ...new Set([
      ...tagRows.slice(0, 200).map((row) => row.tag).filter((tag): tag is string => tag !== null),
      ...(tagFilter ? [tagFilter] : []),
    ]),
  ];
  const scansHref = (tag?: string, nextPage?: number) => {
    const nextParams = new URLSearchParams();
    if (tag) nextParams.set("tag", tag);
    if (queryFilter) nextParams.set("q", queryFilter);
    if (nextPage && nextPage > 1) nextParams.set("page", String(nextPage));
    const queryString = nextParams.toString();
    return queryString ? `/scans?${queryString}` : "/scans";
  };

  return (
    <div className="mx-auto min-w-0 w-full max-w-[1180px] space-y-5">
      <ActiveScansRefresh enabled={hasActiveScans} />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="lime-page-title">
            {filterError
              ? "Check your scan filters"
              : queryFilter
              ? `Results for “${queryFilter}”`
              : tagFilter
                ? `Scans tagged “${tagFilter}”`
                : "All scans"}
          </h1>
        </div>
        <p className="text-xs text-muted-foreground sm:pb-1">
          {matchingTotal === 0
            ? "0 scans"
            : `Showing ${(page - 1) * scansPerPage + 1}–${(page - 1) * scansPerPage + allScans.length} of ${matchingTotal} ${matchingTotal === 1 ? "scan" : "scans"}`}
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
              aria-label={`Scans tagged ${tag}`}
              className={`inline-flex items-center rounded-full border px-4 py-2 text-xs font-semibold transition-colors ${
                tagFilter === tag
                  ? "border-black bg-black text-[#FFED00]"
                  : "border-black/10 bg-white hover:border-black/25"
              }`}
            >
              {displayTag(tag)}
            </Link>
          ))}
          {tagRows.length > 200 ? (
            <span className="text-xs text-muted-foreground">
              Showing a selection of tags. Search to find others.
            </span>
          ) : null}
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
                    {filterError ? (
                      <>
                        {filterError}{" "}
                        <Link href="/scans" className="underline">Clear filters</Link>.
                      </>
                    ) : queryFilter ? (
                      <>
                        No scans match &quot;{queryFilter}&quot;
                        {tagFilter ? <> with tag &quot;{tagFilter}&quot;</> : null}.{" "}
                        <Link
                          href={tagFilter ? `/scans?tag=${encodeURIComponent(tagFilter)}` : "/scans"}
                          className="underline"
                        >
                          Clear search
                        </Link>
                        .
                      </>
                    ) : tagFilter ? (
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
                        scan.tag.length > maxTagLength ? (
                          <TagBadge tag={displayTag(scan.tag)} />
                        ) : (
                          <Link href={`/scans?tag=${encodeURIComponent(scan.tag)}`} aria-label={`Scans tagged ${scan.tag}`}>
                            <TagBadge tag={displayTag(scan.tag)} />
                          </Link>
                        )
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

      {matchingTotal > scansPerPage ? (
        <nav aria-label="Scan pages" className="flex items-center justify-between gap-4 text-sm">
          {page > 1 ? (
            <Link href={scansHref(tagFilter, page - 1)} className="lime-pill-button px-4 py-2 text-xs">
              Previous
            </Link>
          ) : <span />}
          <span className="text-xs text-muted-foreground">Page {page} of {lastPage}</span>
          {page < lastPage ? (
            <Link href={scansHref(tagFilter, page + 1)} className="lime-pill-button px-4 py-2 text-xs">
              Next
            </Link>
          ) : <span />}
        </nav>
      ) : null}
    </div>
  );
}
