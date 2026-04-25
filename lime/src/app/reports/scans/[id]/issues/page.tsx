import { notFound } from "next/navigation";
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
      const reportData = scope
        ? await loadScopedIssueReportData(id, scope, {
            occurrenceLimit: settings.singleIssuePdfOccurrenceLimit,
            includeAffectedPages: true,
          })
        : await loadIssueReportData(id, {
            occurrenceLimit: settings.fullPdfOccurrenceLimit,
            includeAffectedPages: true,
          });

      return [settings, reportData] as const;
    },
    1000
  );

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
