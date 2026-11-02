import { eq, getTableColumns, sql } from "drizzle-orm";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { db } from "@/db";
import { appSettings } from "@/db/schema";
import { readReportQuery, type ReportReadContext } from "@/lib/mcp-report-read";
import {
  DEFAULT_INTEGRATION_SETTINGS,
  DEFAULT_PERFORMANCE_SETTINGS,
  DEFAULT_REPORT_SETTINGS,
  DEFAULT_SYSTEM_SETTINGS,
  type IntegrationSettings,
  type PerformanceSettings,
  type ReportSettings,
  type SystemSettings,
  type SystemSettingsPatch,
} from "@/lib/report-settings-config";

const REPORT_SETTINGS_KEY = "global";

const REPORT_LIMIT_MIN = 1;
const REPORT_LIMIT_MAX = 20000;
const CACHE_TTL_MIN = 5;
const CACHE_TTL_MAX = 86400;
const REPORT_CONCURRENCY_MIN = 1;
const REPORT_CONCURRENCY_MAX = 10;
const SETTINGS_CACHE_TTL_MS = 5000;

let cachedSystemSettings:
  | {
      value: SystemSettings;
      expiresAt: number;
    }
  | null = null;

function clampLimit(value: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(
    REPORT_LIMIT_MAX,
    Math.max(REPORT_LIMIT_MIN, Math.trunc(value))
  );
}

function clampRange(
  value: number,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

function normalizeReportingSettings(
  settings: Partial<ReportSettings> | null | undefined
): ReportSettings {
  return {
    fullPdfOccurrenceLimit: clampLimit(
      settings?.fullPdfOccurrenceLimit ?? NaN,
      DEFAULT_REPORT_SETTINGS.fullPdfOccurrenceLimit
    ),
    singleIssuePdfOccurrenceLimit: clampLimit(
      settings?.singleIssuePdfOccurrenceLimit ?? NaN,
      DEFAULT_REPORT_SETTINGS.singleIssuePdfOccurrenceLimit
    ),
    smallCsvOccurrenceLimit: clampLimit(
      settings?.smallCsvOccurrenceLimit ?? NaN,
      DEFAULT_REPORT_SETTINGS.smallCsvOccurrenceLimit
    ),
    llmOccurrenceLimit: clampLimit(
      settings?.llmOccurrenceLimit ?? NaN,
      DEFAULT_REPORT_SETTINGS.llmOccurrenceLimit
    ),
    pdfReportsEnabled:
      settings?.pdfReportsEnabled ?? DEFAULT_REPORT_SETTINGS.pdfReportsEnabled,
    csvReportsEnabled:
      settings?.csvReportsEnabled ?? DEFAULT_REPORT_SETTINGS.csvReportsEnabled,
    llmReportsEnabled:
      settings?.llmReportsEnabled ?? DEFAULT_REPORT_SETTINGS.llmReportsEnabled,
  };
}

function normalizePerformanceSettings(
  settings: Partial<PerformanceSettings> | null | undefined
): PerformanceSettings {
  return {
    summaryCacheTtlSeconds: clampRange(
      settings?.summaryCacheTtlSeconds ?? NaN,
      DEFAULT_PERFORMANCE_SETTINGS.summaryCacheTtlSeconds,
      CACHE_TTL_MIN,
      CACHE_TTL_MAX
    ),
    reportDataCacheTtlSeconds: clampRange(
      settings?.reportDataCacheTtlSeconds ?? NaN,
      DEFAULT_PERFORMANCE_SETTINGS.reportDataCacheTtlSeconds,
      CACHE_TTL_MIN,
      CACHE_TTL_MAX
    ),
    reportGenerationConcurrency: clampRange(
      settings?.reportGenerationConcurrency ?? NaN,
      DEFAULT_PERFORMANCE_SETTINGS.reportGenerationConcurrency,
      REPORT_CONCURRENCY_MIN,
      REPORT_CONCURRENCY_MAX
    ),
  };
}

function normalizeIntegrationSettings(
  settings: Partial<IntegrationSettings> | null | undefined
): IntegrationSettings {
  return {
    mcpEnabled: settings?.mcpEnabled ?? DEFAULT_INTEGRATION_SETTINGS.mcpEnabled,
    mcpAllowWrites: settings?.mcpAllowWrites ?? DEFAULT_INTEGRATION_SETTINGS.mcpAllowWrites,
    mcpConfigured:
      settings?.mcpConfigured ?? DEFAULT_INTEGRATION_SETTINGS.mcpConfigured,
    mcpKeyHint: settings?.mcpKeyHint ?? DEFAULT_INTEGRATION_SETTINGS.mcpKeyHint,
    mcpKeyGeneratedAt:
      settings?.mcpKeyGeneratedAt ??
      DEFAULT_INTEGRATION_SETTINGS.mcpKeyGeneratedAt,
  };
}

function normalizeSystemSettings(
  settings: SystemSettingsPatch | null | undefined
): SystemSettings {
  return {
    reporting: normalizeReportingSettings(settings?.reporting),
    performance: normalizePerformanceSettings(settings?.performance),
    integrations: normalizeIntegrationSettings(settings?.integrations),
  };
}

function settingsFromRow(
  settings: typeof appSettings.$inferSelect | undefined
): SystemSettings {
  if (!settings) {
    return DEFAULT_SYSTEM_SETTINGS;
  }

  return normalizeSystemSettings({
    reporting: {
      fullPdfOccurrenceLimit: settings.fullPdfOccurrenceLimit,
      singleIssuePdfOccurrenceLimit: settings.singleIssuePdfOccurrenceLimit,
      smallCsvOccurrenceLimit: settings.smallCsvOccurrenceLimit,
      llmOccurrenceLimit: settings.llmOccurrenceLimit,
      pdfReportsEnabled: settings.pdfReportsEnabled,
      csvReportsEnabled: settings.csvReportsEnabled,
      llmReportsEnabled: settings.llmReportsEnabled,
    },
    performance: {
      summaryCacheTtlSeconds: settings.summaryCacheTtlSeconds,
      reportDataCacheTtlSeconds: settings.reportDataCacheTtlSeconds,
      reportGenerationConcurrency: settings.reportGenerationConcurrency,
    },
    integrations: {
      mcpEnabled: settings.mcpEnabled,
      mcpAllowWrites: settings.mcpAllowWrites,
      mcpConfigured: Boolean(settings.mcpKeyHash),
      mcpKeyHint: settings.mcpKeyHint,
      mcpKeyGeneratedAt: settings.mcpKeyGeneratedAt?.toISOString() ?? null,
    },
  });
}

function invalidateSystemSettingsCache() {
  cachedSystemSettings = null;
}

export async function getSystemSettings(context?: ReportReadContext): Promise<SystemSettings> {
  const now = Date.now();
  if (!context && cachedSystemSettings && cachedSystemSettings.expiresAt > now) {
    return cachedSystemSettings.value;
  }

  const [settings] = await readReportQuery((context?.db ?? db)
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, REPORT_SETTINGS_KEY))
    .limit(1), context, Object.keys(getTableColumns(appSettings)).length);

  const systemSettings = settingsFromRow(settings);
  if (!context) {
    cachedSystemSettings = {
      value: systemSettings,
      expiresAt: now + SETTINGS_CACHE_TTL_MS,
    };
  }

  return systemSettings;
}

export async function getReportSettings(context?: ReportReadContext): Promise<ReportSettings> {
  const settings = await getSystemSettings(context);
  return settings.reporting;
}

export async function getPerformanceSettings(context?: ReportReadContext): Promise<PerformanceSettings> {
  const settings = await getSystemSettings(context);
  return settings.performance;
}

export async function saveReportSettings(
  nextSettings: Partial<ReportSettings>
): Promise<ReportSettings> {
  const settings = await saveSystemSettings({
    reporting: nextSettings,
  });

  return settings.reporting;
}

export async function saveSystemSettings(
  nextSettings: SystemSettingsPatch,
  mcpAuthorization?: string
): Promise<SystemSettings> {
  const normalizedSettings = await db.transaction(async (tx) => {
    if (mcpAuthorization !== undefined) {
      // Apply only to this MCP write transaction, never the pooled connection
      // or normal dashboard saves. PostgreSQL aborts timed-out statements and
      // Drizzle awaits rollback before this operation can report failure.
      await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
      await tx.execute(sql`SET LOCAL statement_timeout = '20s'`);
    }
    await tx.insert(appSettings).values({ key: REPORT_SETTINGS_KEY }).onConflictDoNothing();
    // Merge partial changes against the locked, current row, not the UI cache.
    // This also serializes permission revocation/key rotation with MCP writes.
    const [row] = await tx.select().from(appSettings)
      .where(eq(appSettings.key, REPORT_SETTINGS_KEY)).for("update");
    if (mcpAuthorization !== undefined) {
      if (nextSettings.integrations || !hasMcpAccess(row, mcpAuthorization, true)) {
        throw new McpAccessError();
      }
    }
    const currentSettings = settingsFromRow(row);
    const normalized = normalizeSystemSettings({
      reporting: {
        ...currentSettings.reporting,
        ...nextSettings.reporting,
      },
      performance: {
        ...currentSettings.performance,
        ...nextSettings.performance,
      },
      integrations: {
        ...currentSettings.integrations,
        ...nextSettings.integrations,
      },
    });
    await tx.update(appSettings).set({
      ...normalized.reporting,
      ...normalized.performance,
      mcpEnabled: normalized.integrations.mcpEnabled,
      mcpAllowWrites: normalized.integrations.mcpAllowWrites,
      updatedAt: new Date(),
    }).where(eq(appSettings.key, REPORT_SETTINGS_KEY));
    return normalized;
  });

  invalidateSystemSettingsCache();
  return normalizedSettings;
}

export class McpAccessError extends Error {
  constructor() { super("MCP access is disabled, revoked, or lacks write permission."); }
}

function hasMcpAccess(
  row: typeof appSettings.$inferSelect | undefined,
  authorization: string,
  writes = false
): boolean {
  const match = /^Bearer ([^\s]{1,256})$/i.exec(authorization);
  if (!row?.mcpEnabled || !match || !row.mcpKeyHash || !/^[a-f0-9]{64}$/.test(row.mcpKeyHash)) return false;
  if (writes && !row.mcpAllowWrites) return false;
  const hash = createHash("sha256").update(match[1]).digest();
  return timingSafeEqual(hash, Buffer.from(row.mcpKeyHash, "hex"));
}

// Authorization must never use the five-second display-settings cache.
export async function requireMcpAccess(authorization: string, context?: ReportReadContext): Promise<void> {
  const [row] = await readReportQuery((context?.db ?? db).select().from(appSettings)
    .where(eq(appSettings.key, REPORT_SETTINGS_KEY)).limit(1), context, Object.keys(getTableColumns(appSettings)).length);
  if (!hasMcpAccess(row, authorization)) throw new McpAccessError();
}

export async function generateMcpKey(): Promise<{
  settings: SystemSettings;
  mcpKey: string;
}> {
  const mcpKey = `lime_mcp_${randomBytes(32).toString("base64url")}`;
  const keyHash = createHash("sha256").update(mcpKey).digest("hex");
  const keyHint = `...${mcpKey.slice(-6)}`;
  const now = new Date();

  await db
    .insert(appSettings)
    .values({
      key: REPORT_SETTINGS_KEY,
      ...DEFAULT_REPORT_SETTINGS,
      ...DEFAULT_PERFORMANCE_SETTINGS,
      mcpEnabled: true,
      mcpKeyHash: keyHash,
      mcpKeyHint: keyHint,
      mcpKeyGeneratedAt: now,
      mcpSessionsRevokedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: {
        mcpEnabled: true,
        mcpKeyHash: keyHash,
        mcpKeyHint: keyHint,
        mcpKeyGeneratedAt: now,
        mcpSessionsRevokedAt: now,
        updatedAt: now,
      },
    });

  invalidateSystemSettingsCache();
  const settings = await getSystemSettings();
  return { settings, mcpKey };
}
