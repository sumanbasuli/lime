import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { scans, issues, issueOccurrences } from "@/db/schema";
import { eq, count } from "drizzle-orm";
import { ScanActions } from "@/components/scan-actions";
import { Progress } from "@/components/ui/progress";
import {
  StatusBadge,
  SeverityBadge,
  ScanTypeBadge,
  TagBadge,
} from "@/components/status-badge";
import { ScanProgress } from "@/components/scan-progress";
import { ArrowRightIcon, ChevronRightIcon } from "lucide-react";
import { formatViewportLabel } from "@/lib/viewport-presets";

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
      createdAt: issues.createdAt,
      occurrenceCount: count(issueOccurrences.id),
    })
    .from(issues)
    .leftJoin(issueOccurrences, eq(issueOccurrences.issueId, issues.id))
    .where(eq(issues.scanId, id))
    .groupBy(issues.id);

  const severityCounts = scanIssues.reduce(
    (acc, issue) => {
      const severity = issue.severity ?? "moderate";
      acc[severity] = (acc[severity] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  const progressPercent =
    scan.totalUrls && scan.totalUrls > 0
      ? Math.round(((scan.scannedUrls ?? 0) / scan.totalUrls) * 100)
      : 0;

  const isActive =
    scan.status !== "completed" && scan.status !== "failed";

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
          <StatusBadge status={scan.status ?? "pending"} />
          <ScanActions
            scanId={scan.id}
            status={scan.status ?? "pending"}
            redirectOnDelete="/scans"
          />
        </div>
      </div>

      <section className="rounded-xl border bg-card p-4">
        <div className="flex items-center justify-between gap-4">
          <h2 className="font-heading text-2xl font-bold">Scan progress</h2>
          <div className="text-right">
            <p className="font-heading text-2xl font-bold leading-none">
              {progressPercent}%
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {scan.scannedUrls ?? 0}/{scan.totalUrls ?? 0} pages
            </p>
          </div>
        </div>

        <div className="mt-4 space-y-2">
          <Progress value={progressPercent} className="h-2" />
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span>Started: {formatTimestamp(scan.createdAt)}</span>
            <span>Updated: {formatTimestamp(scan.updatedAt)}</span>
          </div>
        </div>
      </section>

      {scanIssues.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-heading text-2xl font-bold">
            Severity breakdown
          </h2>

          <div className="grid auto-rows-fr gap-3 md:grid-cols-4">
            {(["critical", "serious", "moderate", "minor"] as const).map(
              (severity) => (
                <div
                  key={severity}
                  className="rounded-xl border bg-card p-3"
                >
                  <p className="text-[11px] font-medium capitalize text-muted-foreground">
                    {severity}
                  </p>
                  <p className="mt-2 font-heading text-3xl font-bold leading-none">
                    {severityCounts[severity] || 0}
                  </p>
                </div>
              )
            )}
          </div>
        </section>
      )}

      <section className="rounded-xl border bg-card p-4">
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 className="font-heading text-2xl font-bold">
            Flagged issues ({scanIssues.length})
          </h2>
          {scanIssues.length > 0 && (
            <Link
              href={`/scans/${scan.id}/issues`}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-full border px-4 text-sm font-medium transition-colors hover:bg-muted"
            >
              View details
              <ArrowRightIcon className="h-4 w-4" />
            </Link>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="pb-3 pr-4 text-[11px] font-medium">
                  Violation
                </th>
                <th className="pb-3 pr-4 text-[11px] font-medium">
                  Severity
                </th>
                <th className="pb-3 pr-4 text-[11px] font-medium">
                  Occurrences
                </th>
                <th className="pb-3 text-[11px] font-medium">
                  Description
                </th>
              </tr>
            </thead>
            <tbody>
              {scanIssues.length === 0 ? (
                <tr>
                  <td
                    colSpan={4}
                    className="py-12 text-center text-muted-foreground"
                  >
                    {isActive
                      ? "Issues will appear here as the scan progresses..."
                      : "No issues found."}
                  </td>
                </tr>
              ) : (
                scanIssues.map((issue) => (
                  <tr key={issue.id} className="border-b last:border-0">
                    <td className="py-3 pr-4 font-mono text-xs">
                      {issue.violationType}
                    </td>
                    <td className="py-3 pr-4">
                      <SeverityBadge severity={issue.severity ?? "moderate"} />
                    </td>
                    <td className="py-3 pr-4 text-sm font-medium">
                      {issue.occurrenceCount}
                    </td>
                    <td className="max-w-lg py-3 leading-5 text-muted-foreground">
                      {issue.description}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
