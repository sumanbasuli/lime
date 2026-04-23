import { and, asc, count, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  issueOccurrences,
  issues,
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
import { getLighthouseAccessibilityWeight } from "@/lib/scan-scoring";

export const ISSUE_SUMMARIES_PAGE_SIZE = 12;
export const ISSUE_OCCURRENCES_PAGE_SIZE = 25;

export interface IssueListCounts {
  activeIssueCount: number;
  excludedIssueCount: number;
  needsReviewCount: number;
  totalIssueCardCount: number;
}

export interface IssueOccurrence {
  id: string;
  urlId: string;
  issueId?: string;
  ruleId?: string;
  htmlSnippet: string | null;
  screenshotPath: string | null;
  elementScreenshotPath: string | null;
  cssSelector: string | null;
  pageUrl: string;
}

interface IssueSummaryBase {
  key: string;
  title: string;
  helpUrl: string | null;
  occurrenceCount: number;
  weight: number;
  scored: boolean;
}

export interface FailedIssueSummaryItem extends IssueSummaryBase {
  kind: "failed";
  issueId: string;
  violationType: string;
  severity: "critical" | "serious" | "moderate" | "minor";
  isFalsePositive: boolean;
}

export interface NeedsReviewSummaryItem extends IssueSummaryBase {
  kind: "needs_review";
  ruleId: string;
}

export type IssueSummaryItem =
  | FailedIssueSummaryItem
  | NeedsReviewSummaryItem;

interface DetailBase {
  title: string;
  helpUrl: string | null;
  occurrences: IssueOccurrence[];
  occurrenceCount: number;
  occurrenceOffset: number;
  hasMoreOccurrences: boolean;
}

export interface FailedIssueDetail extends DetailBase {
  kind: "failed";
  issueId: string;
  violationType: string;
  severity: "critical" | "serious" | "moderate" | "minor";
  isFalsePositive: boolean;
  actRules: ACTRule[];
  suggestedFixes: string[];
  complianceReferences: AccessibilityReference[];
  axeSuggestedChange: string | null;
  axeRuleDescription: string | null;
}

export interface NeedsReviewIssueDetail extends DetailBase {
  kind: "needs_review";
  ruleId: string;
  ruleDescription: string | null;
  actRules: ACTRule[];
  suggestedFixes: string[];
  complianceReferences: AccessibilityReference[];
  axeSuggestedChange: string | null;
}

export type IssueDetailResponse = FailedIssueDetail | NeedsReviewIssueDetail;

function severitySortOrder(
  severity: "critical" | "serious" | "moderate" | "minor"
): number {
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

function compareFailedIssueSummaries(
  left: FailedIssueSummaryItem,
  right: FailedIssueSummaryItem
): number {
  return (
    right.weight - left.weight ||
    severitySortOrder(left.severity) - severitySortOrder(right.severity) ||
    left.title.localeCompare(right.title)
  );
}

async function loadIssueSummaries(scanId: string): Promise<{
  items: IssueSummaryItem[];
  counts: IssueListCounts;
}> {
  const failedIssueRows = await db
    .select({
      issueId: issues.id,
      violationType: issues.violationType,
      title: issues.description,
      helpUrl: issues.helpUrl,
      severity: issues.severity,
      isFalsePositive: issues.isFalsePositive,
      occurrenceCount: count(issueOccurrences.id),
    })
    .from(issues)
    .leftJoin(issueOccurrences, eq(issueOccurrences.issueId, issues.id))
    .where(eq(issues.scanId, scanId))
    .groupBy(issues.id);

  const failedIssues: FailedIssueSummaryItem[] = failedIssueRows
    .map((issue) => {
      const weight = getLighthouseAccessibilityWeight(issue.violationType);

      return {
        kind: "failed" as const,
        key: issue.issueId,
        issueId: issue.issueId,
        violationType: issue.violationType,
        title: issue.title,
        helpUrl: issue.helpUrl,
        severity: issue.severity,
        isFalsePositive: issue.isFalsePositive,
        occurrenceCount: issue.occurrenceCount,
        weight,
        scored: weight > 0,
      };
    })
    .sort(compareFailedIssueSummaries);

  const failedRuleIds = new Set(failedIssues.map((issue) => issue.violationType));

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

  const needsReviewIssues: NeedsReviewSummaryItem[] = Array.from(
    new Set([
      ...incompleteAuditCounts.map((row) => row.ruleId),
      ...incompleteOccurrenceCounts.map((row) => row.ruleId),
    ])
  )
    .filter((ruleId) => ruleId && !failedRuleIds.has(ruleId))
    .map((ruleId) => {
      const weight = getLighthouseAccessibilityWeight(ruleId);
      const metadata = axeRuleCatalog[ruleId];
      const occurrenceCount =
        occurrenceCountByRuleId.get(ruleId) ?? auditCountByRuleId.get(ruleId) ?? 0;

      return {
        kind: "needs_review" as const,
        key: ruleId,
        ruleId,
        title: metadata?.help || ruleId,
        helpUrl: metadata?.helpUrl || null,
        occurrenceCount,
        weight,
        scored: weight > 0,
      };
    })
    .sort(
      (left, right) =>
        right.weight - left.weight || left.title.localeCompare(right.title)
    );
  const activeFailedIssues = failedIssues.filter(
    (issue) => !issue.isFalsePositive
  );
  const falsePositiveIssues = failedIssues.filter(
    (issue) => issue.isFalsePositive
  );

  return {
    items: [...activeFailedIssues, ...needsReviewIssues, ...falsePositiveIssues],
    counts: {
      activeIssueCount: activeFailedIssues.length,
      excludedIssueCount: falsePositiveIssues.length,
      needsReviewCount: needsReviewIssues.length,
      totalIssueCardCount: failedIssues.length + needsReviewIssues.length,
    },
  };
}

export async function loadIssueSummariesPage(
  scanId: string,
  offset: number,
  limit: number
): Promise<{
  items: IssueSummaryItem[];
  counts: IssueListCounts;
}> {
  const { items, counts } = await loadIssueSummaries(scanId);
  return {
    items: items.slice(offset, offset + limit),
    counts,
  };
}

async function loadFailedIssueDetail(
  scanId: string,
  issueId: string,
  occurrenceOffset: number,
  occurrenceLimit: number
): Promise<FailedIssueDetail | null> {
  const [issue] = await db
    .select()
    .from(issues)
    .where(and(eq(issues.scanId, scanId), eq(issues.id, issueId)))
    .limit(1);

  if (!issue) {
    return null;
  }

  const [occurrenceCountRows, occurrenceRows, enrichedIssue, axeContext] =
    await Promise.all([
      db
        .select({ value: count() })
        .from(issueOccurrences)
        .where(eq(issueOccurrences.issueId, issueId)),
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
        .where(eq(issueOccurrences.issueId, issueId))
        .orderBy(asc(urls.url), asc(issueOccurrences.createdAt))
        .limit(occurrenceLimit)
        .offset(occurrenceOffset),
      enrichIssueWithACT(issue),
      resolveAxeRuleContext(issue.violationType),
    ]);

  const occurrenceCount = occurrenceCountRows[0]?.value ?? 0;

  return {
    kind: "failed",
    issueId: issue.id,
    violationType: issue.violationType,
    title: issue.description,
    helpUrl: issue.helpUrl,
    severity: issue.severity,
    isFalsePositive: issue.isFalsePositive,
    actRules: enrichedIssue.actRules,
    suggestedFixes: enrichedIssue.suggestedFixes,
    complianceReferences: axeContext.accessibilityRequirements,
    axeSuggestedChange: axeContext.successCriterion,
    axeRuleDescription: axeContext.ruleDescription,
    occurrences: occurrenceRows,
    occurrenceCount,
    occurrenceOffset,
    hasMoreOccurrences: occurrenceOffset + occurrenceRows.length < occurrenceCount,
  };
}

async function loadNeedsReviewIssueDetail(
  scanId: string,
  ruleId: string,
  occurrenceOffset: number,
  occurrenceLimit: number
): Promise<NeedsReviewIssueDetail | null> {
  const [occurrenceCountRows, actContext, axeContext, axeRuleCatalog] =
    await Promise.all([
      db
        .select({ value: count() })
        .from(urlAuditOccurrences)
        .innerJoin(urls, eq(urls.id, urlAuditOccurrences.urlId))
        .where(
          and(
            eq(urls.scanId, scanId),
            eq(urls.status, "completed"),
            eq(urlAuditOccurrences.ruleId, ruleId),
            eq(urlAuditOccurrences.outcome, "incomplete")
          )
        ),
      resolveACTContext(ruleId),
      resolveAxeRuleContext(ruleId),
      getAxeRuleCatalog(),
    ]);

  const occurrenceCount = occurrenceCountRows[0]?.value ?? 0;
  const metadata = axeRuleCatalog[ruleId];

  if (occurrenceCount > 0) {
    const occurrenceRows = await db
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
      .limit(occurrenceLimit)
      .offset(occurrenceOffset);

    return {
      kind: "needs_review",
      ruleId,
      title: metadata?.help || ruleId,
      helpUrl: metadata?.helpUrl || null,
      ruleDescription: axeContext.ruleDescription,
      actRules: actContext.actRules,
      suggestedFixes: actContext.suggestedFixes,
      complianceReferences: axeContext.accessibilityRequirements,
      axeSuggestedChange: axeContext.successCriterion,
      occurrences: occurrenceRows,
      occurrenceCount,
      occurrenceOffset,
      hasMoreOccurrences:
        occurrenceOffset + occurrenceRows.length < occurrenceCount,
    };
  }

  const [auditCountRows, auditRows] = await Promise.all([
    db
      .select({ value: count() })
      .from(urlAudits)
      .innerJoin(urls, eq(urls.id, urlAudits.urlId))
      .where(
        and(
          eq(urls.scanId, scanId),
          eq(urls.status, "completed"),
          eq(urlAudits.ruleId, ruleId),
          eq(urlAudits.outcome, "incomplete")
        )
      ),
    db
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
      .limit(occurrenceLimit)
      .offset(occurrenceOffset),
  ]);

  const auditCount = auditCountRows[0]?.value ?? 0;
  if (auditCount === 0) {
    return null;
  }

  return {
    kind: "needs_review",
    ruleId,
    title: metadata?.help || ruleId,
    helpUrl: metadata?.helpUrl || null,
    ruleDescription: axeContext.ruleDescription,
    actRules: actContext.actRules,
    suggestedFixes: actContext.suggestedFixes,
    complianceReferences: axeContext.accessibilityRequirements,
    axeSuggestedChange: axeContext.successCriterion,
    occurrences: auditRows.map((row) => ({
      id: `${ruleId}-${row.urlId}`,
      ruleId,
      urlId: row.urlId,
      htmlSnippet: null,
      screenshotPath: null,
      elementScreenshotPath: null,
      cssSelector: null,
      pageUrl: row.pageUrl,
    })),
    occurrenceCount: auditCount,
    occurrenceOffset,
    hasMoreOccurrences: occurrenceOffset + auditRows.length < auditCount,
  };
}

export async function loadIssueDetail(
  scanId: string,
  kind: IssueSummaryItem["kind"],
  key: string,
  occurrenceOffset: number,
  occurrenceLimit: number
): Promise<IssueDetailResponse | null> {
  if (kind === "failed") {
    return loadFailedIssueDetail(
      scanId,
      key,
      occurrenceOffset,
      occurrenceLimit
    );
  }

  return loadNeedsReviewIssueDetail(
    scanId,
    key,
    occurrenceOffset,
    occurrenceLimit
  );
}

export async function loadIssueSummaryByKey(
  scanId: string,
  kind: IssueSummaryItem["kind"],
  key: string
): Promise<IssueSummaryItem | null> {
  if (kind === "failed") {
    const [issue] = await db
      .select({
        issueId: issues.id,
        violationType: issues.violationType,
        title: issues.description,
        helpUrl: issues.helpUrl,
        severity: issues.severity,
        isFalsePositive: issues.isFalsePositive,
        occurrenceCount: count(issueOccurrences.id),
      })
      .from(issues)
      .leftJoin(issueOccurrences, eq(issueOccurrences.issueId, issues.id))
      .where(and(eq(issues.scanId, scanId), eq(issues.id, key)))
      .groupBy(issues.id)
      .limit(1);

    if (!issue) {
      return null;
    }

    const weight = getLighthouseAccessibilityWeight(issue.violationType);
    return {
      kind: "failed",
      key: issue.issueId,
      issueId: issue.issueId,
      violationType: issue.violationType,
      title: issue.title,
      helpUrl: issue.helpUrl,
      severity: issue.severity,
      isFalsePositive: issue.isFalsePositive,
      occurrenceCount: issue.occurrenceCount,
      weight,
      scored: weight > 0,
    };
  }

  const [failedRuleRows, incompleteOccurrenceRows, incompleteAuditRows, axeRuleCatalog] =
    await Promise.all([
      db
        .select({ value: count() })
        .from(issues)
        .where(and(eq(issues.scanId, scanId), eq(issues.violationType, key))),
      db
        .select({ value: count() })
        .from(urlAuditOccurrences)
        .innerJoin(urls, eq(urls.id, urlAuditOccurrences.urlId))
        .where(
          and(
            eq(urls.scanId, scanId),
            eq(urls.status, "completed"),
            eq(urlAuditOccurrences.ruleId, key),
            eq(urlAuditOccurrences.outcome, "incomplete")
          )
        ),
      db
        .select({ value: count() })
        .from(urlAudits)
        .innerJoin(urls, eq(urls.id, urlAudits.urlId))
        .where(
          and(
            eq(urls.scanId, scanId),
            eq(urls.status, "completed"),
            eq(urlAudits.ruleId, key),
            eq(urlAudits.outcome, "incomplete")
          )
        ),
      getAxeRuleCatalog(),
    ]);

  if ((failedRuleRows[0]?.value ?? 0) > 0) {
    return null;
  }

  const occurrenceCount =
    (incompleteOccurrenceRows[0]?.value ?? 0) ||
    (incompleteAuditRows[0]?.value ?? 0);
  if (occurrenceCount === 0) {
    return null;
  }

  const weight = getLighthouseAccessibilityWeight(key);
  const metadata = axeRuleCatalog[key];
  return {
    kind: "needs_review",
    key,
    ruleId: key,
    title: metadata?.help || key,
    helpUrl: metadata?.helpUrl || null,
    occurrenceCount,
    weight,
    scored: weight > 0,
  };
}

export async function loadIssueDetailWithSummary(
  scanId: string,
  kind: IssueSummaryItem["kind"],
  key: string,
  occurrenceOffset: number,
  occurrenceLimit: number
): Promise<{
  summary: IssueSummaryItem;
  detail: IssueDetailResponse;
} | null> {
  const [summary, detail] = await Promise.all([
    loadIssueSummaryByKey(scanId, kind, key),
    loadIssueDetail(scanId, kind, key, occurrenceOffset, occurrenceLimit),
  ]);

  if (!summary || !detail) {
    return null;
  }

  return { summary, detail };
}

export async function loadOccurrencesForIssues(
  issueIds: string[]
): Promise<Map<string, IssueOccurrence[]>> {
  if (issueIds.length === 0) {
    return new Map();
  }

  const rows = await db
    .select({
      issueId: issueOccurrences.issueId,
      id: issueOccurrences.id,
      urlId: issueOccurrences.urlId,
      htmlSnippet: issueOccurrences.htmlSnippet,
      screenshotPath: issueOccurrences.screenshotPath,
      elementScreenshotPath: issueOccurrences.elementScreenshotPath,
      cssSelector: issueOccurrences.cssSelector,
      pageUrl: urls.url,
    })
    .from(issueOccurrences)
    .innerJoin(urls, eq(urls.id, issueOccurrences.urlId))
    .where(inArray(issueOccurrences.issueId, issueIds))
    .orderBy(asc(urls.url), asc(issueOccurrences.createdAt));

  const grouped = new Map<string, IssueOccurrence[]>();
  for (const row of rows) {
    const group = grouped.get(row.issueId) ?? [];
    group.push({
      id: row.id,
      issueId: row.issueId,
      urlId: row.urlId,
      htmlSnippet: row.htmlSnippet,
      screenshotPath: row.screenshotPath,
      elementScreenshotPath: row.elementScreenshotPath,
      cssSelector: row.cssSelector,
      pageUrl: row.pageUrl,
    });
    grouped.set(row.issueId, group);
  }

  return grouped;
}
