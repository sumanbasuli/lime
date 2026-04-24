import { eq } from "drizzle-orm";
import { db } from "@/db";
import { appSettings } from "@/db/schema";
import {
  DEFAULT_REPORT_SETTINGS,
  type ReportSettings,
} from "@/lib/report-settings-config";

const REPORT_SETTINGS_KEY = "global";

const REPORT_LIMIT_MIN = 1;
const REPORT_LIMIT_MAX = 20000;

function clampLimit(value: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(
    REPORT_LIMIT_MAX,
    Math.max(REPORT_LIMIT_MIN, Math.trunc(value))
  );
}

function normalizeSettings(
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

export async function getReportSettings(): Promise<ReportSettings> {
  const [settings] = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, REPORT_SETTINGS_KEY))
    .limit(1);

  if (!settings) {
    return DEFAULT_REPORT_SETTINGS;
  }

  return normalizeSettings(settings);
}

export async function saveReportSettings(
  nextSettings: Partial<ReportSettings>
): Promise<ReportSettings> {
  const normalizedSettings = normalizeSettings(nextSettings);
  const now = new Date();

  await db
    .insert(appSettings)
    .values({
      key: REPORT_SETTINGS_KEY,
      ...normalizedSettings,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: {
        ...normalizedSettings,
        updatedAt: now,
      },
    });

  return normalizedSettings;
}
