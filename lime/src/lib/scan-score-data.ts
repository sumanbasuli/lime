import { and, count, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { issues, urlAudits, urls } from "@/db/schema";
import { getAxeRuleCatalog } from "@/lib/act-rules";
import {
  buildScanAuditReport,
  type ScanAuditReport,
  type ScanScoreSummary,
  type StoredAuditOutcome,
} from "@/lib/scan-scoring";

interface ScanLike {
  id: string;
  status: string;
}

function getErrorDetails(error: unknown): { code?: string; message: string } {
  if (error instanceof Error) {
    const cause = error.cause;
    if (
      cause &&
      typeof cause === "object" &&
      "message" in cause &&
      typeof cause.message === "string"
    ) {
      const code =
        "code" in cause && typeof cause.code === "string"
          ? cause.code
          : undefined;

      return { code, message: cause.message };
    }

    return { message: error.message };
  }

  return { message: String(error) };
}

function isMissingAuditStorageError(error: unknown): boolean {
  const { code, message } = getErrorDetails(error);

  if (code === "42P01" || code === "42704") {
    return true;
  }

  return (
    message.includes(`url_audits`) &&
    (message.includes(`does not exist`) ||
      message.includes(`doesn't exist`) ||
      message.includes(`relation`) ||
      message.includes(`Failed query`))
  );
}

export async function getScanAuditReports(
  scansToLoad: ScanLike[]
): Promise<Record<string, ScanAuditReport>> {
  if (scansToLoad.length === 0) {
    return {};
  }

  const scanIds = scansToLoad.map((scan) => scan.id);
  const [falsePositiveRows, axeRuleCatalog, urlCoverageRows] = await Promise.all([
    db
      .select({
        scanId: issues.scanId,
        ruleId: issues.violationType,
      })
      .from(issues)
      .where(and(inArray(issues.scanId, scanIds), eq(issues.isFalsePositive, true))),
    getAxeRuleCatalog(),
    db
      .select({
        scanId: urls.scanId,
        status: urls.status,
        urlCount: count(),
      })
      .from(urls)
      .where(inArray(urls.scanId, scanIds))
      .groupBy(urls.scanId, urls.status),
  ]);

  let auditRows: Array<{
    scanId: string;
    ruleId: string;
    outcome: string;
  }> = [];

  try {
    auditRows = await db
      .select({
        scanId: urls.scanId,
        ruleId: urlAudits.ruleId,
        outcome: urlAudits.outcome,
      })
      .from(urlAudits)
      .innerJoin(urls, eq(urls.id, urlAudits.urlId))
      .where(and(inArray(urls.scanId, scanIds), eq(urls.status, "completed")));
  } catch (error) {
    if (!isMissingAuditStorageError(error)) {
      throw error;
    }
  }

  const metadataByRuleId = Object.fromEntries(
    Object.values(axeRuleCatalog).map((rule) => [
      rule.ruleId,
      {
        title: rule.help,
        description: rule.description,
        helpUrl: rule.helpUrl,
      },
    ])
  );

  const auditRowsByScan = new Map<
    string,
    Array<{ ruleId: string; outcome: StoredAuditOutcome }>
  >();
  for (const row of auditRows) {
    const scanAuditRows = auditRowsByScan.get(row.scanId) ?? [];
    scanAuditRows.push({
      ruleId: row.ruleId,
      outcome: row.outcome as StoredAuditOutcome,
    });
    auditRowsByScan.set(row.scanId, scanAuditRows);
  }

  const falsePositiveRuleIdsByScan = new Map<string, Set<string>>();
  for (const row of falsePositiveRows) {
    const falsePositiveRuleIds =
      falsePositiveRuleIdsByScan.get(row.scanId) ?? new Set<string>();
    falsePositiveRuleIds.add(row.ruleId);
    falsePositiveRuleIdsByScan.set(row.scanId, falsePositiveRuleIds);
  }

  const coverageByScan = new Map<
    string,
    { completedUrlCount: number; failedUrlCount: number; totalUrlCount: number }
  >();
  for (const row of urlCoverageRows) {
    const coverage = coverageByScan.get(row.scanId) ?? {
      completedUrlCount: 0,
      failedUrlCount: 0,
      totalUrlCount: 0,
    };

    coverage.totalUrlCount += row.urlCount;
    if (row.status === "completed") {
      coverage.completedUrlCount += row.urlCount;
    }
    if (row.status === "failed") {
      coverage.failedUrlCount += row.urlCount;
    }

    coverageByScan.set(row.scanId, coverage);
  }

  const reports: Record<string, ScanAuditReport> = {};
  for (const scan of scansToLoad) {
    reports[scan.id] = buildScanAuditReport({
      auditRecords: auditRowsByScan.get(scan.id) ?? [],
      falsePositiveRuleIds: falsePositiveRuleIdsByScan.get(scan.id),
      definitions: metadataByRuleId,
      scanStatus: scan.status,
      coverage: coverageByScan.get(scan.id) ?? {
        completedUrlCount: 0,
        failedUrlCount: 0,
        totalUrlCount: 0,
      },
    });
  }

  return reports;
}

export async function getScanScoreSummaries(
  scansToLoad: ScanLike[]
): Promise<Record<string, ScanScoreSummary>> {
  const reports = await getScanAuditReports(scansToLoad);

  return Object.fromEntries(
    Object.entries(reports).map(([scanId, report]) => [scanId, report.summary])
  );
}
