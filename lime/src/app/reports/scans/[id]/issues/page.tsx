import { notFound } from "next/navigation";
import { after } from "next/server";
import { headers } from "next/headers";
import { IssuesReportDocument } from "@/components/issues-report-document";
import {
  loadScopedIssueReportData,
  loadIssueReportData,
} from "@/lib/issues-report-data";
import {
  getFirstSearchParam,
  resolveIssueReportScope,
} from "@/lib/issue-report-scope";
import { measureServerAction } from "@/lib/performance-logging";
import { getReportSettings } from "@/lib/report-settings";
import {
  claimHTMLReport,
  REPORT_HTML_LEASE_HEADER,
} from "@/lib/report-html-admission";
import { HtmlReportTooLargeError, withHtmlReportRead } from "@/lib/html-report-read";

export const dynamic = "force-dynamic";

interface ReportPageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    kind?: string | string[];
    key?: string | string[];
  }>;
}

export default async function IssuesReportPage({
  params,
  searchParams,
}: ReportPageProps) {
  const release = claimHTMLReport((await headers()).get(REPORT_HTML_LEASE_HEADER));
  if (!release) {
    throw new Error("HTML report admission is unavailable");
  }
  try {
    after(release);
  } catch (error) {
    release();
    throw error;
  }

  const { id } = await params;
  const resolvedSearchParams = await searchParams;
  const scope = resolveIssueReportScope(
    getFirstSearchParam(resolvedSearchParams.kind),
    getFirstSearchParam(resolvedSearchParams.key)
  );

  if (scope === null) {
    notFound();
  }

  const [reportSettings, data] = await measureServerAction(
    `pdf report page data ${id}${scope ? ` ${scope.kind}` : ""}`,
    async () => {
      const settings = await getReportSettings();
      let reportData;
      try {
        reportData = await withHtmlReportRead((context) => scope
          ? loadScopedIssueReportData(id, scope, {
              occurrenceLimit: settings.singleIssuePdfOccurrenceLimit,
              includeAffectedPages: true,
              context,
            })
          : loadIssueReportData(id, {
              occurrenceLimit: settings.fullPdfOccurrenceLimit,
              includeAffectedPages: true,
              context,
            }));
      } catch (error) {
        if (!(error instanceof HtmlReportTooLargeError)) throw error;
        return [settings, error] as const;
      }

      return [settings, reportData] as const;
    },
    1000
  );

  if (data instanceof HtmlReportTooLargeError) {
    const csvQuery = new URLSearchParams({ mode: "full" });
    if (scope) {
      csvQuery.set("kind", scope.kind);
      csvQuery.set("key", scope.key);
    }
    return (
      <main data-report-too-large="true">
        <h1>Report too large to render</h1>
        <p>{data.message}</p>
        {reportSettings.csvReportsEnabled ? (
          <a href={`/api/scans/${encodeURIComponent(id)}/issues/report.csv?${csvQuery}`}>
            Download the complete CSV export
          </a>
        ) : (
          <p>CSV exports are disabled in settings.</p>
        )}
      </main>
    );
  }

  if (!data) {
    notFound();
  }

  return (
    <IssuesReportDocument
      data={data}
      reportScope={scope ? "issue" : "scan"}
      reportSettings={reportSettings}
    />
  );
}
