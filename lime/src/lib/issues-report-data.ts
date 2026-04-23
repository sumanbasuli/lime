import { and, asc, count, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  issueOccurrences,
  issues,
  scans,
  urlAuditOccurrences,
  urlAudits,
  urls,
} from "@/db/schema";
import {
  enrichIssueWithACT,
  getAxeRuleCatalog,
  resolveACTContext,
  resolveAxeRuleContext,
  type ACTRule,
  type AccessibilityReference,
} from "@/lib/act-rules";
import { getScanAuditReports } from "@/lib/scan-score-data";
import {
  getLighthouseAccessibilityWeight,
  type ScanScoreSummary,
} from "@/lib/scan-scoring";

export const REPORT_OCCURRENCE_SAMPLE_LIMIT = 5;
export const REPORT_MEDIA_SAMPLE_LIMIT = 5;

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

export type ReportIssueKind = "failed" | "needs_review";

export type ReportIssue = Omit<ScanIssueRow, "severity" | "createdAt"> & {
  severity: ScanIssueRow["severity"] | null;
  createdAt: ScanIssueRow["createdAt"] | null;
  actRules: ACTRule[];
  suggestedFixes: string[];
  axeAccessibilityRequirements: AccessibilityReference[];
};

export interface ReportIssueGroup {
  kind: ReportIssueKind;
  issue: ReportIssue;
  occurrences: ReportOccurrence[];
  occurrenceCount: number;
  complianceReferences: AccessibilityReference[];
  axeSuggestedChange: string | null;
  axeRuleDescription: string | null;
}

export interface IssueReportData {
  scan: typeof scans.$inferSelect;
  scoreSummary: ScanScoreSummary;
  issuesWithOccurrences: ReportIssueGroup[];
  activeIssueCount: number;
  failedIssueCount: number;
  needsReviewIssueCount: number;
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

function severitySortOrder(severity: ScanIssueRow["severity"] | null): number {
  switch (severity) {
    case "critical":
      return 0;
    case "serious":
      return 1;
    case "moderate":
      return 2;
    case "minor":
    default:
      return 3;
  }
}

async function loadFailedReportGroups(
  scanId: string,
  scanIssues: ScanIssueRow[]
): Promise<ReportIssueGroup[]> {
  const reportableScanIssues = scanIssues.filter(
    (issue) => !issue.isFalsePositive
  );

  return Promise.all(
    reportableScanIssues.map(async (issue) => {
      const [occurrenceCountRows, occurrences, enrichedIssue, axeContext] =
        await Promise.all([
          db
            .select({ value: count() })
            .from(issueOccurrences)
            .where(eq(issueOccurrences.issueId, issue.id)),
          db
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
            .where(eq(issueOccurrences.issueId, issue.id))
            .orderBy(asc(urls.url), asc(issueOccurrences.createdAt))
            .limit(REPORT_OCCURRENCE_SAMPLE_LIMIT),
          enrichIssueWithACT(issue),
          resolveAxeRuleContext(issue.violationType),
        ]);

      return {
        kind: "failed",
        issue: enrichedIssue,
        occurrences,
        occurrenceCount: occurrenceCountRows[0]?.value ?? occurrences.length,
        complianceReferences: axeContext.accessibilityRequirements,
        axeSuggestedChange: axeContext.successCriterion,
        axeRuleDescription: axeContext.ruleDescription,
      } satisfies ReportIssueGroup;
    })
  );
}

async function loadNeedsReviewReportGroups(
  scanId: string,
  failedRuleIds: Set<string>
): Promise<ReportIssueGroup[]> {
  const [incompleteAuditCounts, incompleteOccurrenceCounts, axeRuleCatalog] =
    await Promise.all([
      db
        .select({
          ruleId: urlAudits.ruleId,
          auditCount: count(),
        })
        .from(urlAudits)
        .innerJoin(urls, eq(urls.id, urlAudits.urlId))
        .where(
          and(
            eq(urls.scanId, scanId),
            eq(urls.status, "completed"),
            eq(urlAudits.outcome, "incomplete")
          )
        )
        .groupBy(urlAudits.ruleId),
      db
        .select({
          ruleId: urlAuditOccurrences.ruleId,
          occurrenceCount: count(),
        })
        .from(urlAuditOccurrences)
        .innerJoin(urls, eq(urls.id, urlAuditOccurrences.urlId))
        .where(
          and(
            eq(urls.scanId, scanId),
            eq(urls.status, "completed"),
            eq(urlAuditOccurrences.outcome, "incomplete")
          )
        )
        .groupBy(urlAuditOccurrences.ruleId),
      getAxeRuleCatalog(),
    ]);

  const occurrenceCountByRuleId = new Map(
    incompleteOccurrenceCounts.map((row) => [row.ruleId, row.occurrenceCount])
  );
  const auditCountByRuleId = new Map(
    incompleteAuditCounts.map((row) => [row.ruleId, row.auditCount])
  );
  const ruleIds = Array.from(
    new Set([
      ...incompleteAuditCounts.map((row) => row.ruleId),
      ...incompleteOccurrenceCounts.map((row) => row.ruleId),
    ])
  ).filter((ruleId) => ruleId && !failedRuleIds.has(ruleId));

  return Promise.all(
    ruleIds.map(async (ruleId) => {
      const [actContext, axeContext] = await Promise.all([
        resolveACTContext(ruleId),
        resolveAxeRuleContext(ruleId),
      ]);
      const occurrenceCount = occurrenceCountByRuleId.get(ruleId) ?? 0;
      const auditCount = auditCountByRuleId.get(ruleId) ?? 0;
      const metadata = axeRuleCatalog[ruleId];

      let occurrences: ReportOccurrence[];
      if (occurrenceCount > 0) {
        occurrences = await db
          .select({
            id: urlAuditOccurrences.id,
            ruleId: urlAuditOccurrences.ruleId,
            urlId: urlAuditOccurrences.urlId,
            htmlSnippet: urlAuditOccurrences.htmlSnippet,
            screenshotPath: urlAuditOccurrences.screenshotPath,
            elementScreenshotPath: urlAuditOccurrences.elementScreenshotPath,
            cssSelector: urlAuditOccurrences.cssSelector,
            pageUrl: urls.url,
          })
          .from(urlAuditOccurrences)
          .innerJoin(urls, eq(urls.id, urlAuditOccurrences.urlId))
          .where(
            and(
              eq(urls.scanId, scanId),
              eq(urls.status, "completed"),
              eq(urlAuditOccurrences.ruleId, ruleId),
              eq(urlAuditOccurrences.outcome, "incomplete")
            )
          )
          .orderBy(asc(urls.url), asc(urlAuditOccurrences.createdAt))
          .limit(REPORT_OCCURRENCE_SAMPLE_LIMIT);
      } else {
        const auditRows = await db
          .select({
            urlId: urls.id,
            pageUrl: urls.url,
          })
          .from(urlAudits)
          .innerJoin(urls, eq(urls.id, urlAudits.urlId))
          .where(
            and(
              eq(urls.scanId, scanId),
              eq(urls.status, "completed"),
              eq(urlAudits.ruleId, ruleId),
              eq(urlAudits.outcome, "incomplete")
            )
          )
          .orderBy(asc(urls.url))
          .limit(REPORT_OCCURRENCE_SAMPLE_LIMIT);

        occurrences = auditRows.map((row) => ({
          id: `${ruleId}-${row.urlId}`,
          ruleId,
          urlId: row.urlId,
          htmlSnippet: null,
          screenshotPath: null,
          elementScreenshotPath: null,
          cssSelector: null,
          pageUrl: row.pageUrl,
        }));
      }

      return {
        kind: "needs_review",
        issue: {
          id: `needs-review:${ruleId}`,
          scanId,
          violationType: ruleId,
          description: metadata?.help || ruleId,
          helpUrl: metadata?.helpUrl || null,
          severity: null,
          isFalsePositive: false,
          createdAt: null,
          actRules: actContext.actRules,
          suggestedFixes: actContext.suggestedFixes,
          axeAccessibilityRequirements: axeContext.accessibilityRequirements,
        },
        occurrences,
        occurrenceCount: occurrenceCount || auditCount || occurrences.length,
        complianceReferences: axeContext.accessibilityRequirements,
        axeSuggestedChange: axeContext.successCriterion,
        axeRuleDescription: axeContext.ruleDescription,
      } satisfies ReportIssueGroup;
    })
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
  const failedRuleIds = new Set(scanIssues.map((issue) => issue.violationType));
  const [failedGroups, needsReviewGroups] = await Promise.all([
    loadFailedReportGroups(scanId, scanIssues),
    loadNeedsReviewReportGroups(scanId, failedRuleIds),
  ]);

  const issuesWithOccurrences = [...failedGroups, ...needsReviewGroups];
  issuesWithOccurrences.sort(
    (a, b) =>
      (a.kind === "failed" ? 0 : 1) - (b.kind === "failed" ? 0 : 1) ||
      getLighthouseAccessibilityWeight(b.issue.violationType) -
        getLighthouseAccessibilityWeight(a.issue.violationType) ||
      severitySortOrder(a.issue.severity) - severitySortOrder(b.issue.severity) ||
      a.issue.description.localeCompare(b.issue.description)
  );

  const failedIssueCount = failedGroups.length;
  const needsReviewIssueCount = needsReviewGroups.length;
  const activeIssueCount = failedIssueCount + needsReviewIssueCount;
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
    failedIssueCount,
    needsReviewIssueCount,
    totalIssueCardCount,
    severityBreakdown,
  };
}
