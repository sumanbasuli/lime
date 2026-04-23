import { buildIssueReportCsvStream } from "@/lib/issues-report-csv";
import { loadIssueReportData } from "@/lib/issues-report-data";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function sanitizeReportHost(rawUrl: string): string {
  let host = rawUrl;

  try {
    host = new URL(rawUrl).host || rawUrl;
  } catch {
    host = rawUrl;
  }

  const sanitized = host
    .toLowerCase()
    .replace(/\./g, "-")
    .replace(/[^a-z0-9-]/g, "");

  return sanitized || "scan";
}

function buildCsvFilename(rawUrl: string, createdAt: Date): string {
  return `lime-issue-report-${sanitizeReportHost(rawUrl)}-${createdAt
    .toISOString()
    .slice(0, 10)}.csv`;
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const data = await loadIssueReportData(id, { occurrenceLimit: 0 });

  if (!data) {
    return Response.json({ error: "Scan not found" }, { status: 404 });
  }

  const csv = buildIssueReportCsvStream(data);

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${buildCsvFilename(
        data.scan.sitemapUrl,
        data.scan.createdAt
      )}"`,
      "Cache-Control": "no-store",
    },
  });
}
