import { eq } from "drizzle-orm";
import { createHash, randomBytes } from "crypto";
import { db } from "@/db";
import { appSettings } from "@/db/schema";
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
      mcpConfigured: Boolean(settings.mcpKeyHash),
      mcpKeyHint: settings.mcpKeyHint,
      mcpKeyGeneratedAt: settings.mcpKeyGeneratedAt?.toISOString() ?? null,
    },
  });
}

function invalidateSystemSettingsCache() {
  cachedSystemSettings = null;
}

export async function getSystemSettings(): Promise<SystemSettings> {
  const now = Date.now();
  if (cachedSystemSettings && cachedSystemSettings.expiresAt > now) {
    return cachedSystemSettings.value;
  }

  const [settings] = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, REPORT_SETTINGS_KEY))
    .limit(1);

  const systemSettings = settingsFromRow(settings);
  cachedSystemSettings = {
    value: systemSettings,
    expiresAt: now + SETTINGS_CACHE_TTL_MS,
  };

  return systemSettings;
}

export async function getReportSettings(): Promise<ReportSettings> {
  const settings = await getSystemSettings();
  return settings.reporting;
}

export async function getPerformanceSettings(): Promise<PerformanceSettings> {
  const settings = await getSystemSettings();
  return settings.performance;
}

export async function saveReportSettings(
  nextSettings: Partial<ReportSettings>
): Promise<ReportSettings> {
  const currentSettings = await getSystemSettings();
  const settings = await saveSystemSettings({
    ...currentSettings,
    reporting: {
      ...currentSettings.reporting,
      ...nextSettings,
    },
  });

  return settings.reporting;
}

export async function saveSystemSettings(
  nextSettings: SystemSettingsPatch
): Promise<SystemSettings> {
  const currentSettings = await getSystemSettings();
  const normalizedSettings = normalizeSystemSettings({
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
  const now = new Date();

  await db
    .insert(appSettings)
    .values({
      key: REPORT_SETTINGS_KEY,
      ...normalizedSettings.reporting,
      ...normalizedSettings.performance,
      mcpEnabled: normalizedSettings.integrations.mcpEnabled,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: {
        ...normalizedSettings.reporting,
        ...normalizedSettings.performance,
        mcpEnabled: normalizedSettings.integrations.mcpEnabled,
        updatedAt: now,
      },
    });

  invalidateSystemSettingsCache();
  return normalizedSettings;
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
