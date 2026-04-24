import { buildIssueReportLlmText } from "@/lib/issues-report-llm";
import {
  loadScopedIssueReportData,
  loadIssueReportData,
} from "@/lib/issues-report-data";
import { resolveIssueReportScope } from "@/lib/issue-report-scope";
import { getReportSettings } from "@/lib/report-settings";

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

function sanitizeFilenameToken(rawValue: string): string {
  const sanitized = rawValue
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return sanitized || "issue";
}

function buildLlmFilename(
  rawUrl: string,
  createdAt: Date,
  scopeSuffix?: string
): string {
  return `lime-issue-report-${sanitizeReportHost(rawUrl)}-${createdAt
    .toISOString()
    .slice(0, 10)}${scopeSuffix ?? ""}-llm.txt`;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const reportSettings = await getReportSettings();
  if (!reportSettings.llmReportsEnabled) {
    return Response.json(
      { error: "LLM exports are disabled in settings." },
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

  const data = scope
    ? await loadScopedIssueReportData(id, scope, {
        occurrenceLimit: reportSettings.llmOccurrenceLimit,
      })
    : await loadIssueReportData(id, {
        occurrenceLimit: reportSettings.llmOccurrenceLimit,
      });

  if (!data) {
    return Response.json(
      { error: scope ? "Issue not found" : "Scan not found" },
      { status: 404 }
    );
  }

  const text = buildIssueReportLlmText(data, reportSettings.llmOccurrenceLimit);

  return new Response(text, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${buildLlmFilename(
        data.scan.sitemapUrl,
        data.scan.createdAt,
        scope ? `-${sanitizeFilenameToken(`${scope.kind}-${scope.key}`)}` : undefined
      )}"`,
      "Cache-Control": "no-store",
    },
  });
}
