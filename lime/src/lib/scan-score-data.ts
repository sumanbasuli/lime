import { and, count, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { issues, scanScoreSummaryCache, scans, urlAudits, urls } from "@/db/schema";
import { getAxeRuleCatalog } from "@/lib/act-rules";
import { getPerformanceSettings } from "@/lib/report-settings";
import {
  buildScanAuditReportFromPageCounts,
  type ScanAuditReport,
  type ScanAuditPageCountInput,
  type ScanScoreSummary,
  type StoredAuditOutcome,
} from "@/lib/scan-scoring";

interface ScanLike {
  id: string;
  status: string;
  updatedAt?: Date;
}

interface ScanCacheState extends ScanLike {
  updatedAt: Date;
}

type ScanScoreSummaryCacheInsert = typeof scanScoreSummaryCache.$inferInsert;

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
    pageCount: number;
  }> = [];

  try {
    auditRows = await db
      .select({
        scanId: urls.scanId,
        ruleId: urlAudits.ruleId,
        outcome: urlAudits.outcome,
        pageCount: count(),
      })
      .from(urlAudits)
      .innerJoin(urls, eq(urls.id, urlAudits.urlId))
      .where(and(inArray(urls.scanId, scanIds), eq(urls.status, "completed")))
      .groupBy(urls.scanId, urlAudits.ruleId, urlAudits.outcome);
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

  const auditRowsByScan = new Map<string, ScanAuditPageCountInput[]>();
  for (const row of auditRows) {
    const scanAuditRows = auditRowsByScan.get(row.scanId) ?? [];
    scanAuditRows.push({
      ruleId: row.ruleId,
      outcome: row.outcome as StoredAuditOutcome,
      pageCount: row.pageCount,
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
    reports[scan.id] = buildScanAuditReportFromPageCounts({
      auditPageCounts: auditRowsByScan.get(scan.id) ?? [],
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

  await refreshScoreSummaryCaches(scansToLoad, reports);

  return reports;
}

function cachedRowToSummary(
  row: typeof scanScoreSummaryCache.$inferSelect
): ScanScoreSummary {
  return {
    score: row.score,
    hasScore: row.hasScore,
    hasAuditData: row.hasAuditData,
    completedUrlCount: row.completedUrlCount,
    failedUrlCount: row.failedUrlCount,
    totalUrlCount: row.totalUrlCount,
    hasFullCoverage: row.hasFullCoverage,
    isPartialScan: row.isPartialScan,
    passedCount: row.passedCount,
    failedCount: row.failedCount,
    notApplicableCount: row.notApplicableCount,
    needsReviewCount: row.needsReviewCount,
    excludedCount: row.excludedCount,
    weightedPassed: row.weightedPassed,
    weightedFailed: row.weightedFailed,
    weightedTotal: row.weightedTotal,
    scoredAuditCount: row.scoredAuditCount,
  };
}

function isFreshSummaryCache(
  row: typeof scanScoreSummaryCache.$inferSelect,
  scan: ScanCacheState,
  ttlSeconds: number
): boolean {
  return (
    row.scanUpdatedAt.getTime() >= scan.updatedAt.getTime() &&
    Date.now() - row.updatedAt.getTime() <= ttlSeconds * 1000
  );
}

async function loadScanCacheStates(scanIds: string[]): Promise<ScanCacheState[]> {
  const rows = await db
    .select({
      id: scans.id,
      status: scans.status,
      updatedAt: scans.updatedAt,
    })
    .from(scans)
    .where(inArray(scans.id, scanIds));

  return rows.map((row) => ({
    id: row.id,
    status: row.status ?? "pending",
    updatedAt: row.updatedAt,
  }));
}

async function resolveScanCacheStates(
  scansToLoad: ScanLike[]
): Promise<ScanCacheState[]> {
  const statesById = new Map<string, ScanCacheState>();
  const missingIds: string[] = [];

  for (const scan of scansToLoad) {
    if (scan.updatedAt instanceof Date) {
      statesById.set(scan.id, {
        id: scan.id,
        status: scan.status,
        updatedAt: scan.updatedAt,
      });
    } else {
      missingIds.push(scan.id);
    }
  }

  if (missingIds.length > 0) {
    const loadedStates = await loadScanCacheStates(missingIds);
    for (const state of loadedStates) {
      statesById.set(state.id, state);
    }
  }

  return scansToLoad
    .map((scan) => statesById.get(scan.id))
    .filter((scan): scan is ScanCacheState => Boolean(scan));
}

async function upsertScoreSummaryCache(
  scan: ScanCacheState,
  summary: ScanScoreSummary
) {
  const now = new Date();

  await db
    .insert(scanScoreSummaryCache)
    .values({
      scanId: scan.id,
      scanUpdatedAt: scan.updatedAt,
      scanStatus: scan.status as ScanScoreSummaryCacheInsert["scanStatus"],
      score: summary.score,
      hasScore: summary.hasScore,
      hasAuditData: summary.hasAuditData,
      completedUrlCount: summary.completedUrlCount,
      failedUrlCount: summary.failedUrlCount,
      totalUrlCount: summary.totalUrlCount,
      hasFullCoverage: summary.hasFullCoverage,
      isPartialScan: summary.isPartialScan,
      passedCount: summary.passedCount,
      failedCount: summary.failedCount,
      notApplicableCount: summary.notApplicableCount,
      needsReviewCount: summary.needsReviewCount,
      excludedCount: summary.excludedCount,
      weightedPassed: summary.weightedPassed,
      weightedFailed: summary.weightedFailed,
      weightedTotal: summary.weightedTotal,
      scoredAuditCount: summary.scoredAuditCount,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: scanScoreSummaryCache.scanId,
      set: {
        scanUpdatedAt: scan.updatedAt,
        scanStatus: scan.status as ScanScoreSummaryCacheInsert["scanStatus"],
        score: summary.score,
        hasScore: summary.hasScore,
        hasAuditData: summary.hasAuditData,
        completedUrlCount: summary.completedUrlCount,
        failedUrlCount: summary.failedUrlCount,
        totalUrlCount: summary.totalUrlCount,
        hasFullCoverage: summary.hasFullCoverage,
        isPartialScan: summary.isPartialScan,
        passedCount: summary.passedCount,
        failedCount: summary.failedCount,
        notApplicableCount: summary.notApplicableCount,
        needsReviewCount: summary.needsReviewCount,
        excludedCount: summary.excludedCount,
        weightedPassed: summary.weightedPassed,
        weightedFailed: summary.weightedFailed,
        weightedTotal: summary.weightedTotal,
        scoredAuditCount: summary.scoredAuditCount,
        updatedAt: now,
      },
    });
}

async function refreshScoreSummaryCaches(
  scansToLoad: ScanLike[],
  reports: Record<string, ScanAuditReport>
) {
  const scanStates = await resolveScanCacheStates(scansToLoad);
  if (scanStates.length === 0) {
    return;
  }

  const scanIds = scanStates.map((scan) => scan.id);
  const [performanceSettings, cachedRows] = await Promise.all([
    getPerformanceSettings(),
    db
      .select()
      .from(scanScoreSummaryCache)
      .where(inArray(scanScoreSummaryCache.scanId, scanIds)),
  ]);
  const cachedRowsByScan = new Map(cachedRows.map((row) => [row.scanId, row]));

  await Promise.all(
    scanStates.map(async (scan) => {
      const summary = reports[scan.id]?.summary;
      if (!summary) {
        return;
      }

      const cachedRow = cachedRowsByScan.get(scan.id);
      if (
        cachedRow &&
        isFreshSummaryCache(
          cachedRow,
          scan,
          performanceSettings.summaryCacheTtlSeconds
        )
      ) {
        return;
      }

      await upsertScoreSummaryCache(scan, summary);
    })
  );
}

export async function getScanScoreSummaries(
  scansToLoad: ScanLike[]
): Promise<Record<string, ScanScoreSummary>> {
  if (scansToLoad.length === 0) {
    return {};
  }

  const scanIds = scansToLoad.map((scan) => scan.id);
  const [scanStates, performanceSettings, cachedRows] = await Promise.all([
    loadScanCacheStates(scanIds),
    getPerformanceSettings(),
    db
      .select()
      .from(scanScoreSummaryCache)
      .where(inArray(scanScoreSummaryCache.scanId, scanIds)),
  ]);

  const scanStateById = new Map(scanStates.map((scan) => [scan.id, scan]));
  const cachedRowsByScan = new Map(cachedRows.map((row) => [row.scanId, row]));
  const summaries: Record<string, ScanScoreSummary> = {};
  const missingScans: ScanCacheState[] = [];

  for (const scan of scanStates) {
    const cachedRow = cachedRowsByScan.get(scan.id);
    if (
      cachedRow &&
      isFreshSummaryCache(
        cachedRow,
        scan,
        performanceSettings.summaryCacheTtlSeconds
      )
    ) {
      summaries[scan.id] = cachedRowToSummary(cachedRow);
      continue;
    }

    missingScans.push(scan);
  }

  if (missingScans.length > 0) {
    const reports = await getScanAuditReports(missingScans);
    for (const scan of missingScans) {
      const summary = reports[scan.id]?.summary;
      if (summary) {
        summaries[scan.id] = summary;
      }
    }
  }

  for (const scan of scansToLoad) {
    if (!summaries[scan.id]) {
      const scanState = scanStateById.get(scan.id);
      if (!scanState) {
        continue;
      }

      const reports = await getScanAuditReports([scanState]);
      summaries[scan.id] = reports[scan.id].summary;
    }
  }

  return summaries;
}
