import { getLighthouseAccessibilityWeight } from "@/lib/scan-scoring";
import { pool } from "@/db";
import type {
  IssueReportData,
  ReportIssueGroup,
  ReportOccurrence,
} from "@/lib/issues-report-data";
import type { QueryResultRow } from "pg";

type CsvValue = string | number | boolean | null | undefined;
const CSV_OCCURRENCE_BATCH_SIZE = 5000;

interface CsvReportOccurrence {
  id: string;
  urlId: string;
  pageUrl: string;
  cssSelector: string | null;
  htmlSnippet: string | null;
}

interface CsvOccurrenceRow extends QueryResultRow, CsvReportOccurrence {
  cursorCreatedAt: string;
  cursorId: string;
}

interface CsvAuditFallbackRow extends QueryResultRow {
  cursorId: string;
  cursorCreatedAt: string;
  urlId: string;
  pageUrl: string;
}

interface OccurrenceCursor {
  pageUrl: string;
  createdAt: string;
  cursorId: string;
}

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

function formatActRuleUrls(group: ReportIssueGroup): string {
  return group.issue.actRules.map((rule) => rule.ruleUrl).join("; ");
}

function formatRequirements(group: ReportIssueGroup): string {
  return group.complianceReferences
    .map((reference) => reference.title)
    .join("; ");
}

function buildRowForOccurrence(
  group: ReportIssueGroup,
  occurrence: Pick<
    ReportOccurrence,
    "pageUrl" | "cssSelector" | "htmlSnippet"
  > | null
): CsvValue[] {
  const weight = getLighthouseAccessibilityWeight(group.issue.violationType);

  return [
    group.kind,
    group.issue.violationType,
    group.issue.description,
    group.issue.severity,
    weight > 0 ? weight : "not scored",
    group.occurrenceCount,
    occurrence?.pageUrl,
    occurrence?.cssSelector,
    occurrence?.htmlSnippet,
    group.issue.helpUrl,
    formatActRuleUrls(group),
    formatRequirements(group),
  ];
}

function buildRowsForGroup(group: ReportIssueGroup): CsvValue[][] {
  const occurrences: Array<ReportOccurrence | null> =
    group.occurrences.length > 0 ? group.occurrences : [null];

  return occurrences.map((occurrence) => buildRowForOccurrence(group, occurrence));
}

export function buildIssueReportCsv(data: IssueReportData): string {
  const rows = data.issuesWithOccurrences.flatMap(buildRowsForGroup);
  return [
    formatCsvRow(ISSUE_REPORT_CSV_HEADER),
    ...rows.map(formatCsvRow),
  ].join("\r\n");
}

const ISSUE_REPORT_CSV_HEADER = [
  "item_type",
  "rule_id",
  "title",
  "severity",
  "weight",
  "occurrence_count",
  "page_url",
  "css_selector",
  "html_snippet",
  "help_url",
  "act_urls",
  "accessibility_requirements",
];

async function loadFailedOccurrenceBatch(
  issueId: string,
  cursor: OccurrenceCursor | null
): Promise<CsvOccurrenceRow[]> {
  const cursorClause = cursor
    ? "AND (u.url, io.created_at, io.id) > ($2::text, $3::timestamp, $4::uuid)"
    : "";
  const params = cursor
    ? [
        issueId,
        cursor.pageUrl,
        cursor.createdAt,
        cursor.cursorId,
        CSV_OCCURRENCE_BATCH_SIZE,
      ]
    : [issueId, CSV_OCCURRENCE_BATCH_SIZE];
  const limitParam = cursor ? "$5" : "$2";
  const result = await pool.query<CsvOccurrenceRow>(
    `
      SELECT
        io.id::text AS id,
        io.id::text AS "cursorId",
        io.issue_id::text AS "issueId",
        io.url_id::text AS "urlId",
        io.html_snippet AS "htmlSnippet",
        io.css_selector AS "cssSelector",
        u.url AS "pageUrl",
        to_char(io.created_at, 'YYYY-MM-DD HH24:MI:SS.US') AS "cursorCreatedAt"
      FROM issue_occurrences io
      INNER JOIN urls u ON u.id = io.url_id
      WHERE io.issue_id = $1::uuid
      ${cursorClause}
      ORDER BY u.url, io.created_at, io.id
      LIMIT ${limitParam}
    `,
    params
  );

  return result.rows;
}

async function loadNeedsReviewOccurrenceBatch(
  scanId: string,
  ruleId: string,
  cursor: OccurrenceCursor | null
): Promise<CsvOccurrenceRow[]> {
  const cursorClause = cursor
    ? "AND (u.url, uao.created_at, uao.id) > ($3::text, $4::timestamp, $5::uuid)"
    : "";
  const params = cursor
    ? [
        scanId,
        ruleId,
        cursor.pageUrl,
        cursor.createdAt,
        cursor.cursorId,
        CSV_OCCURRENCE_BATCH_SIZE,
      ]
    : [scanId, ruleId, CSV_OCCURRENCE_BATCH_SIZE];
  const limitParam = cursor ? "$6" : "$3";
  const result = await pool.query<CsvOccurrenceRow>(
    `
      SELECT
        uao.id::text AS id,
        uao.id::text AS "cursorId",
        uao.rule_id AS "ruleId",
        uao.url_id::text AS "urlId",
        uao.html_snippet AS "htmlSnippet",
        uao.css_selector AS "cssSelector",
        u.url AS "pageUrl",
        to_char(uao.created_at, 'YYYY-MM-DD HH24:MI:SS.US') AS "cursorCreatedAt"
      FROM url_audit_occurrences uao
      INNER JOIN urls u ON u.id = uao.url_id
      WHERE u.scan_id = $1::uuid
        AND u.status = 'completed'
        AND uao.rule_id = $2
        AND uao.outcome = 'incomplete'
        ${cursorClause}
      ORDER BY u.url, uao.created_at, uao.id
      LIMIT ${limitParam}
    `,
    params
  );

  return result.rows;
}

async function loadNeedsReviewAuditFallbackBatch(
  scanId: string,
  ruleId: string,
  cursor: OccurrenceCursor | null
): Promise<CsvOccurrenceRow[]> {
  const cursorClause = cursor
    ? "AND (u.url, ua.created_at, ua.id) > ($3::text, $4::timestamp, $5::uuid)"
    : "";
  const params = cursor
    ? [
        scanId,
        ruleId,
        cursor.pageUrl,
        cursor.createdAt,
        cursor.cursorId,
        CSV_OCCURRENCE_BATCH_SIZE,
      ]
    : [scanId, ruleId, CSV_OCCURRENCE_BATCH_SIZE];
  const limitParam = cursor ? "$6" : "$3";
  const result = await pool.query<CsvAuditFallbackRow>(
    `
      SELECT
        ua.id::text AS "cursorId",
        to_char(ua.created_at, 'YYYY-MM-DD HH24:MI:SS.US') AS "cursorCreatedAt",
        u.id::text AS "urlId",
        u.url AS "pageUrl"
      FROM url_audits ua
      INNER JOIN urls u ON u.id = ua.url_id
      WHERE u.scan_id = $1::uuid
        AND u.status = 'completed'
        AND ua.rule_id = $2
        AND ua.outcome = 'incomplete'
        ${cursorClause}
      ORDER BY u.url, ua.created_at, ua.id
      LIMIT ${limitParam}
    `,
    params
  );

  return result.rows.map((row) => ({
    id: `${ruleId}-${row.urlId}-${row.cursorId}`,
    cursorId: row.cursorId,
    cursorCreatedAt: row.cursorCreatedAt,
    ruleId,
    urlId: row.urlId,
    htmlSnippet: null,
    cssSelector: null,
    pageUrl: row.pageUrl,
  }));
}

async function loadOccurrenceBatch(
  group: ReportIssueGroup,
  cursor: OccurrenceCursor | null
): Promise<CsvOccurrenceRow[]> {
  if (group.occurrenceSource === "issue_occurrences") {
    return loadFailedOccurrenceBatch(group.issue.id, cursor);
  }

  if (group.occurrenceSource === "url_audit_occurrences") {
    return loadNeedsReviewOccurrenceBatch(
      group.issue.scanId,
      group.issue.violationType,
      cursor
    );
  }

  return loadNeedsReviewAuditFallbackBatch(
    group.issue.scanId,
    group.issue.violationType,
    cursor
  );
}

async function* streamOccurrencesForGroup(
  group: ReportIssueGroup
): AsyncGenerator<CsvReportOccurrence> {
  let cursor: OccurrenceCursor | null = null;

  for (;;) {
    const rows = await loadOccurrenceBatch(group, cursor);
    if (rows.length === 0) {
      return;
    }

    for (const row of rows) {
      yield row;
    }

    const lastRow = rows[rows.length - 1];
    cursor = {
      pageUrl: lastRow.pageUrl,
      createdAt: lastRow.cursorCreatedAt,
      cursorId: lastRow.cursorId,
    };

    if (rows.length < CSV_OCCURRENCE_BATCH_SIZE) {
      return;
    }
  }
}

async function* streamIssueReportCsvRows(
  data: IssueReportData
): AsyncGenerator<string> {
  yield formatCsvRow(ISSUE_REPORT_CSV_HEADER);

  for (const group of data.issuesWithOccurrences) {
    let wroteOccurrence = false;

    for await (const occurrence of streamOccurrencesForGroup(group)) {
      yield formatCsvRow(buildRowForOccurrence(group, occurrence));
      wroteOccurrence = true;
    }

    if (!wroteOccurrence) {
      yield formatCsvRow(buildRowForOccurrence(group, null));
    }
  }
}

export function buildIssueReportCsvStream(data: IssueReportData): ReadableStream {
  const encoder = new TextEncoder();
  const rows = streamIssueReportCsvRows(data);
  let wroteRow = false;

  return new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await rows.next();
        if (done) {
          controller.close();
          return;
        }

        const prefix = wroteRow ? "\r\n" : "";
        controller.enqueue(encoder.encode(`${prefix}${value}`));
        wroteRow = true;
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await rows.return?.(undefined);
    },
  });
}
