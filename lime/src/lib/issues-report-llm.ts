import {
  getLighthouseAccessibilityWeight,
  type ScanScoreSummary,
} from "@/lib/scan-scoring";
import type { IssueReportData, ReportIssueGroup } from "@/lib/issues-report-data";

const LLM_SNIPPET_CHAR_LIMIT = 240;
const LLM_SELECTOR_CHAR_LIMIT = 180;
const LLM_TEXT_CHAR_LIMIT = 320;

function normalizeWhitespace(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function truncateText(
  value: string | null | undefined,
  limit: number
): string | null {
  const normalized = normalizeWhitespace(value);
  if (!normalized) {
    return null;
  }

  if (normalized.length <= limit) {
    return normalized;
  }

  return `${normalized.slice(0, limit - 1).trimEnd()}…`;
}

function formatList(values: string[]): string {
  return values.length > 0 ? values.join("; ") : "none";
}

function formatScoreSummary(summary: ScanScoreSummary): string[] {
  return [
    `score: ${summary.hasScore && summary.score !== null ? summary.score : "n/a"}`,
    `coverage: ${summary.completedUrlCount}/${summary.totalUrlCount} completed, ${summary.failedUrlCount} failed`,
    `scan_state: ${
      summary.isPartialScan
        ? "partial"
        : summary.hasFullCoverage
          ? "full"
          : "incomplete"
    }`,
    `audit_results: passed ${summary.passedCount}; failed ${summary.failedCount}; needs_review ${summary.needsReviewCount}; excluded ${summary.excludedCount}; not_applicable ${summary.notApplicableCount}`,
  ];
}

function formatIssueBlock(group: ReportIssueGroup, index: number): string {
  const weight = getLighthouseAccessibilityWeight(group.issue.violationType);
  const occurrenceLines =
    group.occurrences.length > 0
      ? group.occurrences.flatMap((occurrence, occurrenceIndex) => [
          `sample_${occurrenceIndex + 1}_page_url: ${occurrence.pageUrl}`,
          `sample_${occurrenceIndex + 1}_css_selector: ${
            truncateText(occurrence.cssSelector, LLM_SELECTOR_CHAR_LIMIT) ?? "n/a"
          }`,
          `sample_${occurrenceIndex + 1}_html_snippet: ${
            truncateText(occurrence.htmlSnippet, LLM_SNIPPET_CHAR_LIMIT) ?? "n/a"
          }`,
        ])
      : ["sample_occurrences: none"];

  const lines = [
    `## issue_${index}`,
    `kind: ${group.kind}`,
    `rule_id: ${group.issue.violationType}`,
    `title: ${
      truncateText(
        group.issue.description ?? group.issue.violationType,
        LLM_TEXT_CHAR_LIMIT
      ) ?? group.issue.violationType
    }`,
    `severity: ${group.issue.severity ?? (group.kind === "needs_review" ? "needs_review" : "n/a")}`,
    `weight: ${weight > 0 ? weight : "not_scored"}`,
    `occurrence_count: ${group.occurrenceCount}`,
    `sample_occurrence_count: ${group.occurrences.length}`,
    `help_url: ${group.issue.helpUrl ?? "n/a"}`,
    `act_urls: ${formatList(group.issue.actRules.map((rule) => rule.ruleUrl))}`,
    `accessibility_requirements: ${formatList(
      group.complianceReferences.map((reference) => reference.title)
    )}`,
    `rule_description: ${
      truncateText(group.axeRuleDescription, LLM_TEXT_CHAR_LIMIT) ?? "n/a"
    }`,
    `suggested_change: ${
      truncateText(group.axeSuggestedChange, LLM_TEXT_CHAR_LIMIT) ?? "n/a"
    }`,
    ...occurrenceLines,
  ];

  return lines.join("\n");
}

export function buildIssueReportLlmText(
  data: IssueReportData,
  occurrenceLimit: number
): string {
  const header = [
    "# LIME LLM Issue Report",
    `scan_id: ${data.scan.id}`,
    `sitemap_url: ${data.scan.sitemapUrl}`,
    `scan_status: ${data.scan.status}`,
    `generated_at: ${new Date().toISOString()}`,
    ...formatScoreSummary(data.scoreSummary),
    `issue_cards: ${data.totalIssueCardCount}`,
    `failed_issue_cards: ${data.failedIssueCount}`,
    `needs_review_issue_cards: ${data.needsReviewIssueCount}`,
    `severity_breakdown: critical ${data.severityBreakdown.critical}; serious ${data.severityBreakdown.serious}; moderate ${data.severityBreakdown.moderate}; minor ${data.severityBreakdown.minor}`,
    `export_notes: includes every failed and needs-review issue card; occurrences are sampled at ${occurrenceLimit} per issue; screenshots are omitted; text is whitespace-normalized and truncated for size.`,
  ];

  const body = data.issuesWithOccurrences.map((group, index) =>
    formatIssueBlock(group, index + 1)
  );

  return [...header, ...body].join("\n\n");
}
