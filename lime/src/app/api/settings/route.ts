import {
  getReportSettings,
  saveReportSettings,
} from "@/lib/report-settings";
import type { ReportSettings } from "@/lib/report-settings-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseSettingsPayload(payload: unknown): Partial<ReportSettings> | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const candidate = payload as Record<string, unknown>;
  const nextSettings: Partial<ReportSettings> = {};

  if (isFiniteNumber(candidate.fullPdfOccurrenceLimit)) {
    nextSettings.fullPdfOccurrenceLimit = candidate.fullPdfOccurrenceLimit;
  }
  if (isFiniteNumber(candidate.singleIssuePdfOccurrenceLimit)) {
    nextSettings.singleIssuePdfOccurrenceLimit =
      candidate.singleIssuePdfOccurrenceLimit;
  }
  if (isFiniteNumber(candidate.smallCsvOccurrenceLimit)) {
    nextSettings.smallCsvOccurrenceLimit = candidate.smallCsvOccurrenceLimit;
  }
  if (isFiniteNumber(candidate.llmOccurrenceLimit)) {
    nextSettings.llmOccurrenceLimit = candidate.llmOccurrenceLimit;
  }
  if (isBoolean(candidate.pdfReportsEnabled)) {
    nextSettings.pdfReportsEnabled = candidate.pdfReportsEnabled;
  }
  if (isBoolean(candidate.csvReportsEnabled)) {
    nextSettings.csvReportsEnabled = candidate.csvReportsEnabled;
  }
  if (isBoolean(candidate.llmReportsEnabled)) {
    nextSettings.llmReportsEnabled = candidate.llmReportsEnabled;
  }

  return nextSettings;
}

export async function GET() {
  const settings = await getReportSettings();
  return Response.json(settings, { status: 200 });
}

export async function PUT(request: Request) {
  const payload = parseSettingsPayload(await request.json().catch(() => null));

  if (payload === null) {
    return Response.json(
      { error: "Invalid settings payload" },
      { status: 400 }
    );
  }

  const settings = await saveReportSettings(payload);
  return Response.json(settings, { status: 200 });
}
