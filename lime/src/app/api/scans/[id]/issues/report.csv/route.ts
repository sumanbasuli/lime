import {
  buildIssueReportCsv,
  buildIssueReportCsvStream,
} from "@/lib/issues-report-csv";
import {
  loadScopedIssueReportData,
  loadIssueReportData,
} from "@/lib/issues-report-data";
import { resolveIssueReportScope } from "@/lib/issue-report-scope";
import { measureServerAction } from "@/lib/performance-logging";
import { getReportSettings } from "@/lib/report-settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type CsvReportMode = "full" | "small";

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

function sanitizeFilenameToken(rawValue: string): string {
  const sanitized = rawValue
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return sanitized || "issue";
}

function buildCsvFilename(
  rawUrl: string,
  createdAt: Date,
  mode: CsvReportMode,
  scopeSuffix?: string
): string {
  return `lime-issue-report-${sanitizeReportHost(rawUrl)}-${createdAt
    .toISOString()
    .slice(0, 10)}${scopeSuffix ?? ""}-${mode}.csv`;
}

function resolveCsvMode(request: Request): CsvReportMode | null {
  const mode = new URL(request.url).searchParams.get("mode");

  if (mode == null || mode === "full") {
    return "full";
  }

  if (mode === "small") {
    return "small";
  }

  return null;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const mode = resolveCsvMode(request);
  if (!mode) {
    return Response.json(
      { error: 'Invalid CSV mode. Expected "full" or "small".' },
      { status: 400 }
    );
  }

  const { id } = await context.params;
  const reportSettings = await getReportSettings();
  if (!reportSettings.csvReportsEnabled) {
    return Response.json(
      { error: "CSV exports are disabled in settings." },
      { status: 403 }
    );
  }

  const scope = resolveIssueReportScope(
    new URL(request.url).searchParams.get("kind"),
    new URL(request.url).searchParams.get("key")
  );
  if (scope === null) {
    return Response.json(
      { error: 'Invalid issue scope. Expected "failed" or "needs_review".' },
      { status: 400 }
    );
  }

  const data = await measureServerAction(
    `csv report data ${id} ${mode}${scope ? ` ${scope.kind}` : ""}`,
    () =>
      scope
        ? loadScopedIssueReportData(id, scope, {
            occurrenceLimit:
              mode === "full" ? 0 : reportSettings.smallCsvOccurrenceLimit,
          })
        : loadIssueReportData(id, {
            occurrenceLimit:
              mode === "full" ? 0 : reportSettings.smallCsvOccurrenceLimit,
          }),
    500
  );

  if (!data) {
    return Response.json(
      { error: scope ? "Issue not found" : "Scan not found" },
      { status: 404 }
    );
  }

  const csv =
    mode === "full"
      ? buildIssueReportCsvStream(data)
      : buildIssueReportCsv(data);

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${buildCsvFilename(
        data.scan.sitemapUrl,
        data.scan.createdAt,
        mode,
        scope ? `-${sanitizeFilenameToken(`${scope.kind}-${scope.key}`)}` : undefined
      )}"`,
      "Cache-Control": "no-store",
    },
  });
}
