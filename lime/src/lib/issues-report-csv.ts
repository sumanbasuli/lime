import { getLighthouseAccessibilityWeight } from "@/lib/scan-scoring";
import type {
  IssueReportData,
  ReportIssueGroup,
  ReportOccurrence,
} from "@/lib/issues-report-data";

type CsvValue = string | number | boolean | null | undefined;

function formatCsvCell(value: CsvValue): string {
  const text = value == null ? "" : String(value);
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  if (
    normalized.includes(",") ||
    normalized.includes("\"") ||
    normalized.includes("\n")
  ) {
    return `"${normalized.replace(/"/g, "\"\"")}"`;
  }

  return normalized;
}

function formatCsvRow(values: CsvValue[]): string {
  return values.map(formatCsvCell).join(",");
}

function formatActRules(group: ReportIssueGroup): string {
  return group.issue.actRules.map((rule) => rule.actRuleId).join("; ");
}

function formatRequirements(group: ReportIssueGroup): string {
  return group.complianceReferences
    .map((reference) => reference.title)
    .join("; ");
}

function buildRowsForGroup(group: ReportIssueGroup): CsvValue[][] {
  const weight = getLighthouseAccessibilityWeight(group.issue.violationType);
  const occurrences: Array<ReportOccurrence | null> =
    group.occurrences.length > 0 ? group.occurrences : [null];

  return occurrences.map((occurrence, index) => [
    group.kind,
    group.issue.violationType,
    group.issue.description,
    group.issue.severity,
    weight > 0 ? weight : "not scored",
    group.occurrenceCount,
    index + 1,
    group.occurrences.length,
    occurrence?.pageUrl,
    occurrence?.cssSelector,
    occurrence?.htmlSnippet,
    occurrence?.screenshotPath,
    occurrence?.elementScreenshotPath,
    group.issue.helpUrl,
    formatActRules(group),
    formatRequirements(group),
    group.axeSuggestedChange,
    group.axeRuleDescription,
  ]);
}

export function buildIssueReportCsv(data: IssueReportData): string {
  const header = [
    "item_type",
    "rule_id",
    "title",
    "severity",
    "weight",
    "occurrence_count",
    "sample_index",
    "sample_count",
    "page_url",
    "css_selector",
    "html_snippet",
    "screenshot_path",
    "element_screenshot_path",
    "help_url",
    "act_rule_ids",
    "accessibility_requirements",
    "suggested_change",
    "rule_description",
  ];

  const rows = data.issuesWithOccurrences.flatMap(buildRowsForGroup);
  return [
    formatCsvRow(header),
    ...rows.map(formatCsvRow),
  ].join("\r\n");
}
