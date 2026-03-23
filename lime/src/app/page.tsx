import Link from "next/link";
import { db } from "@/db";
import { scans, issues } from "@/db/schema";
import { desc, count, sql } from "drizzle-orm";
import { NewScanForm } from "@/components/new-scan-form";
import { ScanActions } from "@/components/scan-actions";
import { StatusBadge, ScanTypeBadge, TagBadge } from "@/components/status-badge";
import { ArrowRightIcon } from "lucide-react";

export const dynamic = "force-dynamic";

function formatDate(value: string | Date | null | undefined): string {
  if (!value) {
    return "—";
  }

  return new Date(value).toLocaleDateString();
}

export default async function Home() {
  const recentScans = await db
    .select()
    .from(scans)
    .orderBy(desc(scans.createdAt))
    .limit(10);

  const [scanCount] = await db.select({ value: count() }).from(scans);
  const [issueCount] = await db.select({ value: count() }).from(issues);
  const [pageCount] = await db
    .select({
      value: sql<number>`COALESCE(SUM(${scans.scannedUrls}), 0)`,
    })
    .from(scans);

  const totalScans = scanCount?.value ?? 0;
  const totalIssues = issueCount?.value ?? 0;
  const totalPages = Number(pageCount?.value ?? 0);

  return (
    <div className="space-y-4">
      <h1 className="font-heading text-3xl font-bold leading-[0.95] sm:text-4xl">
        Dashboard
      </h1>

      <section className="rounded-xl border bg-card p-4">
        <h2 className="mb-4 font-heading text-2xl font-bold">New scan</h2>
        <NewScanForm />
      </section>

      <div className="grid auto-rows-fr gap-4 md:grid-cols-3">
        <div className="rounded-xl border bg-card p-4">
          <p className="text-[11px] font-medium text-muted-foreground">
            Total scans
          </p>
          <p className="mt-2 font-heading text-3xl font-bold leading-none">
            {totalScans}
          </p>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <p className="text-[11px] font-medium text-muted-foreground">
            Issues found
          </p>
          <p className="mt-2 font-heading text-3xl font-bold leading-none">
            {totalIssues}
          </p>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <p className="text-[11px] font-medium text-muted-foreground">
            Pages scanned
          </p>
          <p className="mt-2 font-heading text-3xl font-bold leading-none">
            {totalPages}
          </p>
        </div>
      </div>

      <section className="rounded-xl border bg-card p-4">
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 className="font-heading text-2xl font-bold">Recent scans</h2>
          {recentScans.length > 0 && (
            <Link
              href="/scans"
              className="inline-flex h-10 items-center justify-center gap-2 rounded-full border px-4 text-sm font-medium transition-colors hover:bg-muted"
            >
              View all
              <ArrowRightIcon className="h-4 w-4" />
            </Link>
          )}
        </div>

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
                <th className="pb-3 pr-4 text-[11px] font-medium">Progress</th>
                <th className="pb-3 text-[11px] font-medium">Started</th>
                <th className="pb-3 pl-4 text-right text-[11px] font-medium">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {recentScans.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="py-12 text-center text-muted-foreground"
                  >
                    No scans yet. Start a scan above to see results here.
                  </td>
                </tr>
              ) : (
                recentScans.map((scan) => (
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
                        <TagBadge tag={scan.tag} />
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="py-3 pr-4">
                      <StatusBadge status={scan.status ?? "pending"} />
                    </td>
                    <td className="py-3 pr-4">
                      {scan.scannedUrls}/{scan.totalUrls} pages
                    </td>
                    <td className="py-3 text-muted-foreground">
                      {formatDate(scan.createdAt)}
                    </td>
                    <td className="py-3 pl-4 text-right">
                      <ScanActions
                        scanId={scan.id}
                        status={scan.status ?? "pending"}
                        className="items-end"
                      />
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
