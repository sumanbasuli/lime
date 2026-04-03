import { eq } from "drizzle-orm";
import { db } from "@/db";
import {
  issueOccurrences,
  issues,
  scans,
  urls,
} from "@/db/schema";
import {
  enrichIssueWithACT,
  resolveAxeRuleContext,
  type ACTRule,
  type AccessibilityReference,
} from "@/lib/act-rules";
import { getScanAuditReports } from "@/lib/scan-score-data";
import {
  getLighthouseAccessibilityWeight,
  type ScanScoreSummary,
} from "@/lib/scan-scoring";

export interface ReportOccurrence {
  id: string;
  urlId: string;
  ruleId?: string;
  issueId?: string;
  htmlSnippet: string | null;
  screenshotPath: string | null;
  elementScreenshotPath: string | null;
  cssSelector: string | null;
  pageUrl: string;
}

type ScanIssueRow = typeof issues.$inferSelect;

export type ReportIssue = ScanIssueRow & {
  actRules: ACTRule[];
  suggestedFixes: string[];
  axeAccessibilityRequirements: AccessibilityReference[];
};

export interface ReportIssueGroup {
  issue: ReportIssue;
  occurrences: ReportOccurrence[];
  complianceReferences: AccessibilityReference[];
  axeSuggestedChange: string | null;
  axeRuleDescription: string | null;
}

export interface IssueReportData {
  scan: typeof scans.$inferSelect;
  scoreSummary: ScanScoreSummary;
  issuesWithOccurrences: ReportIssueGroup[];
  activeIssueCount: number;
  totalIssueCardCount: number;
  severityBreakdown: Record<"critical" | "serious" | "moderate" | "minor", number>;
}

function isSeverityKey(
  value: string | null | undefined
): value is keyof IssueReportData["severityBreakdown"] {
  return (
    value === "critical" ||
    value === "serious" ||
    value === "moderate" ||
    value === "minor"
  );
}

export async function loadIssueReportData(
  scanId: string
): Promise<IssueReportData | null> {
  const [scan] = await db.select().from(scans).where(eq(scans.id, scanId));
  if (!scan) {
    return null;
  }

  const auditReports = await getScanAuditReports([
    { id: scan.id, status: scan.status ?? "pending" },
  ]);
  const scoreSummary = auditReports[scan.id].summary;

  const scanIssues = await db.select().from(issues).where(eq(issues.scanId, scanId));
  const reportableScanIssues = scanIssues.filter(
    (issue) =>
      !issue.isFalsePositive && getLighthouseAccessibilityWeight(issue.violationType) > 0
  );

  const issuesWithOccurrences = await Promise.all(
    reportableScanIssues.map(async (issue) => {
      const occurrences = await db
        .select({
          id: issueOccurrences.id,
          issueId: issueOccurrences.issueId,
          urlId: issueOccurrences.urlId,
          htmlSnippet: issueOccurrences.htmlSnippet,
          screenshotPath: issueOccurrences.screenshotPath,
          elementScreenshotPath: issueOccurrences.elementScreenshotPath,
          cssSelector: issueOccurrences.cssSelector,
          pageUrl: urls.url,
        })
        .from(issueOccurrences)
        .innerJoin(urls, eq(urls.id, issueOccurrences.urlId))
        .where(eq(issueOccurrences.issueId, issue.id));

      const enrichedIssue = await enrichIssueWithACT(issue);
      const axeContext = await resolveAxeRuleContext(issue.violationType);

      return {
        issue: enrichedIssue,
        occurrences,
        complianceReferences: axeContext.accessibilityRequirements,
        axeSuggestedChange: axeContext.successCriterion,
        axeRuleDescription: axeContext.ruleDescription,
      } satisfies ReportIssueGroup;
    })
  );

  const severityOrder = { critical: 0, serious: 1, moderate: 2, minor: 3 };
  issuesWithOccurrences.sort(
    (a, b) =>
      getLighthouseAccessibilityWeight(b.issue.violationType) -
        getLighthouseAccessibilityWeight(a.issue.violationType) ||
      (severityOrder[a.issue.severity as keyof typeof severityOrder] ?? 3) -
        (severityOrder[b.issue.severity as keyof typeof severityOrder] ?? 3)
  );

  const activeIssueCount = issuesWithOccurrences.length;
  const totalIssueCardCount = activeIssueCount;
  const severityBreakdown = issuesWithOccurrences.reduce(
    (summary, { issue }) => {
      if (isSeverityKey(issue.severity)) {
        const severity = issue.severity;
        summary[severity] += 1;
      }

      return summary;
    },
    {
      critical: 0,
      serious: 0,
      moderate: 0,
      minor: 0,
    }
  );

  return {
    scan,
    scoreSummary,
    issuesWithOccurrences,
    activeIssueCount,
    totalIssueCardCount,
    severityBreakdown,
  };
}
