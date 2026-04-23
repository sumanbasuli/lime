export type StoredAuditOutcome =
  | "passed"
  | "failed"
  | "not_applicable"
  | "incomplete";

export type AggregatedAuditStatus =
  | "passed"
  | "failed"
  | "not_applicable"
  | "needs_review"
  | "excluded";

export interface ScanAuditDefinition {
  ruleId: string;
  title: string;
  description: string | null;
  helpUrl: string | null;
  weight: number;
  scored: boolean;
}

export interface ScanAuditMetadata {
  title: string;
  description: string | null;
  helpUrl: string | null;
}

export interface ScanAuditResult extends ScanAuditDefinition {
  status: AggregatedAuditStatus;
  pageCounts: Record<StoredAuditOutcome, number>;
}

export interface ScanAuditRecordInput {
  ruleId: string;
  outcome: StoredAuditOutcome;
}

export interface ScanAuditPageCountInput extends ScanAuditRecordInput {
  pageCount: number;
}

export interface ScanScoreSummary {
  score: number | null;
  hasScore: boolean;
  hasAuditData: boolean;
  completedUrlCount: number;
  failedUrlCount: number;
  totalUrlCount: number;
  hasFullCoverage: boolean;
  isPartialScan: boolean;
  passedCount: number;
  failedCount: number;
  notApplicableCount: number;
  needsReviewCount: number;
  excludedCount: number;
  weightedPassed: number;
  weightedFailed: number;
  weightedTotal: number;
  scoredAuditCount: number;
}

export interface ScanAuditReport {
  summary: ScanScoreSummary;
  audits: ScanAuditResult[];
}

export type DisplayScanStatus =
  | "pending"
  | "profiling"
  | "scanning"
  | "processing"
  | "paused"
  | "completed"
  | "failed"
  | "partial";

export type AccessibilityScoreTone = "green" | "yellow" | "red";

export interface AccessibilityScoreBand {
  key: "excellent" | "good" | "needs_work" | "poor";
  label: string;
  tone: AccessibilityScoreTone;
}

const LIGHTHOUSE_AUDIT_WEIGHTS: Record<string, number> = {
  accesskeys: 7,
  "aria-allowed-attr": 10,
  "aria-dialog-name": 7,
  "aria-hidden-body": 10,
  "aria-hidden-focus": 7,
  "aria-input-field-name": 7,
  "aria-meter-name": 7,
  "aria-progressbar-name": 7,
  "aria-required-attr": 10,
  "aria-required-children": 10,
  "aria-required-parent": 10,
  "aria-roles": 10,
  "aria-text": 7,
  "aria-toggle-field-name": 7,
  "aria-tooltip-name": 7,
  "aria-treeitem-name": 7,
  "aria-valid-attr": 10,
  "aria-valid-attr-value": 10,
  bypass: 3,
  "button-name": 7,
  "color-contrast": 3,
  "definition-list": 3,
  dlitem: 3,
  "document-title": 3,
  "duplicate-id-active": 3,
  "duplicate-id-aria": 3,
  "form-field-multiple-labels": 3,
  "frame-title": 7,
  "heading-order": 3,
  "html-has-lang": 3,
  "html-lang-valid": 3,
  "html-xml-lang-mismatch": 3,
  "image-alt": 10,
  "input-button-name": 7,
  "input-image-alt": 10,
  label: 10,
  "label-content-name-mismatch": 7,
  "landmark-one-main": 3,
  "link-in-text-block": 3,
  "link-name": 7,
  list: 3,
  listitem: 3,
  "meta-refresh": 10,
  "meta-viewport": 3,
  "object-alt": 7,
  "select-name": 7,
  "skip-link": 3,
  tabindex: 3,
  "table-fake-caption": 3,
  "td-headers-attr": 10,
  "th-has-data-cells": 10,
  "valid-lang": 3,
  "video-caption": 10,
};

const auditStatusSortOrder: Record<AggregatedAuditStatus, number> = {
  failed: 0,
  needs_review: 1,
  excluded: 2,
  passed: 3,
  not_applicable: 4,
};

function createEmptyPageCounts(): Record<StoredAuditOutcome, number> {
  return {
    passed: 0,
    failed: 0,
    not_applicable: 0,
    incomplete: 0,
  };
}

export function getLighthouseAccessibilityWeight(ruleId: string): number {
  return LIGHTHOUSE_AUDIT_WEIGHTS[ruleId] ?? 0;
}

export function getAccessibilityScoreBand(score: number): AccessibilityScoreBand {
  if (score >= 90) {
    return { key: "excellent", label: "Excellent", tone: "green" };
  }
  if (score >= 75) {
    return { key: "good", label: "Good", tone: "green" };
  }
  if (score >= 50) {
    return { key: "needs_work", label: "Needs work", tone: "yellow" };
  }

  return { key: "poor", label: "Poor", tone: "red" };
}

function aggregateAuditStatus(
  pageCounts: Record<StoredAuditOutcome, number>
): AggregatedAuditStatus {
  if (pageCounts.failed > 0) {
    return "failed";
  }
  if (pageCounts.incomplete > 0) {
    return "needs_review";
  }
  if (pageCounts.passed > 0) {
    return "passed";
  }
  return "not_applicable";
}

function summarizeScanScore(
  audits: ScanAuditResult[],
  scanStatus: string,
  coverage: {
    completedUrlCount: number;
    failedUrlCount: number;
    totalUrlCount: number;
  }
): ScanScoreSummary {
  const isSettled = scanStatus === "completed" || scanStatus === "paused";
  const hasAttemptedCoverage =
    coverage.completedUrlCount > 0 || coverage.failedUrlCount > 0;
  const passedCount = audits.filter((audit) => audit.status === "passed").length;
  const failedCount = audits.filter((audit) => audit.status === "failed").length;
  const notApplicableCount = audits.filter(
    (audit) => audit.status === "not_applicable"
  ).length;
  const needsReviewCount = audits.filter(
    (audit) => audit.status === "needs_review"
  ).length;
  const excludedCount = audits.filter((audit) => audit.status === "excluded").length;
  const weightedPassed = audits
    .filter((audit) => audit.status === "passed")
    .reduce((sum, audit) => sum + audit.weight, 0);
  const weightedFailed = audits
    .filter((audit) => audit.status === "failed")
    .reduce((sum, audit) => sum + audit.weight, 0);
  const weightedTotal = weightedPassed + weightedFailed;
  const hasAuditData = audits.length > 0;
  const hasFullCoverage =
    isSettled &&
    coverage.totalUrlCount > 0 &&
    coverage.failedUrlCount === 0 &&
    coverage.completedUrlCount === coverage.totalUrlCount;
  const isPartialScan =
    isSettled &&
    coverage.totalUrlCount > 0 &&
    hasAttemptedCoverage &&
    !hasFullCoverage;
  const hasScore =
    isSettled &&
    coverage.completedUrlCount > 0 &&
    weightedTotal > 0;

  return {
    score: hasScore ? Math.round((weightedPassed / weightedTotal) * 100) : null,
    hasScore,
    hasAuditData,
    completedUrlCount: coverage.completedUrlCount,
    failedUrlCount: coverage.failedUrlCount,
    totalUrlCount: coverage.totalUrlCount,
    hasFullCoverage,
    isPartialScan,
    passedCount,
    failedCount,
    notApplicableCount,
    needsReviewCount,
    excludedCount,
    weightedPassed,
    weightedFailed,
    weightedTotal,
    scoredAuditCount: audits.filter((audit) => audit.scored).length,
  };
}

export function buildScanAuditReport(options: {
  auditRecords: ScanAuditRecordInput[];
  falsePositiveRuleIds?: Iterable<string>;
  definitions?: Record<string, ScanAuditMetadata>;
  scanStatus: string;
  coverage: {
    completedUrlCount: number;
    failedUrlCount: number;
    totalUrlCount: number;
  };
}): ScanAuditReport {
  return buildScanAuditReportFromPageCounts({
    auditPageCounts: options.auditRecords.map((record) => ({
      ...record,
      pageCount: 1,
    })),
    falsePositiveRuleIds: options.falsePositiveRuleIds,
    definitions: options.definitions,
    scanStatus: options.scanStatus,
    coverage: options.coverage,
  });
}

export function buildScanAuditReportFromPageCounts(options: {
  auditPageCounts: ScanAuditPageCountInput[];
  falsePositiveRuleIds?: Iterable<string>;
  definitions?: Record<string, ScanAuditMetadata>;
  scanStatus: string;
  coverage: {
    completedUrlCount: number;
    failedUrlCount: number;
    totalUrlCount: number;
  };
}): ScanAuditReport {
  const grouped = new Map<string, Record<StoredAuditOutcome, number>>();

  for (const record of options.auditPageCounts) {
    const pageCounts = grouped.get(record.ruleId) ?? createEmptyPageCounts();
    pageCounts[record.outcome] += record.pageCount;
    grouped.set(record.ruleId, pageCounts);
  }

  const falsePositiveRuleIds = new Set(options.falsePositiveRuleIds ?? []);
  const audits = Array.from(grouped.entries())
    .filter(([ruleId]) => !falsePositiveRuleIds.has(ruleId))
    .map(([ruleId, pageCounts]) => {
      const metadata = options.definitions?.[ruleId];
      const weight = getLighthouseAccessibilityWeight(ruleId);

      return {
        ruleId,
        title: metadata?.title || ruleId,
        description: metadata?.description || null,
        helpUrl: metadata?.helpUrl || null,
        weight,
        scored: weight > 0,
        status: aggregateAuditStatus(pageCounts),
        pageCounts,
      } satisfies ScanAuditResult;
    })
    .sort(
      (left, right) =>
        auditStatusSortOrder[left.status] - auditStatusSortOrder[right.status] ||
        right.weight - left.weight ||
        left.title.localeCompare(right.title)
    );

  return {
    summary: summarizeScanScore(audits, options.scanStatus, options.coverage),
    audits,
  };
}

export function getDisplayScanStatus(
  status: string,
  summary?: Pick<ScanScoreSummary, "isPartialScan">
): DisplayScanStatus {
  if (status === "completed" && summary?.isPartialScan) {
    return "partial";
  }

  return (status as DisplayScanStatus) ?? "pending";
}
