import { notFound } from "next/navigation";
import { IssuesReportDocument } from "@/components/issues-report-document";
import { loadIssueReportData } from "@/lib/issues-report-data";

export const dynamic = "force-dynamic";

interface ReportPageProps {
  params: Promise<{ id: string }>;
}

export default async function IssuesReportPage({
  params,
}: ReportPageProps) {
  const { id } = await params;
  const data = await loadIssueReportData(id);

  if (!data) {
    notFound();
  }

  return <IssuesReportDocument data={data} />;
}
