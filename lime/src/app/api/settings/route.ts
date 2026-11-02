import {
  generateMcpKey,
  getSystemSettings,
  saveSystemSettings,
} from "@/lib/report-settings";
import { rejectCrossOriginWrite } from "@/lib/ordinary-api-origin";
import { readBoundedJSONBody } from "@/lib/bounded-json-body";
import type {
  IntegrationSettings,
  PerformanceSettings,
  ReportSettings,
  SystemSettingsPatch,
} from "@/lib/report-settings-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const settingsBodyOptions = { maxBytes: 1024 * 1024, timeoutMs: 60_000 };

function rejectedSettingsBody(kind: "too_large" | "timed_out" | "invalid") {
  if (kind === "too_large") {
    return Response.json(
      { error: "Request body too large" },
      { status: 413, headers: { Connection: "close" } }
    );
  }
  if (kind === "timed_out") {
    return Response.json(
      { error: "Request body timed out" },
      { status: 408, headers: { Connection: "close" } }
    );
  }
  return null;
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseReportingPayload(
  candidate: Record<string, unknown>
): Partial<ReportSettings> {
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

function parsePerformancePayload(
  candidate: Record<string, unknown>
): Partial<PerformanceSettings> {
  const nextSettings: Partial<PerformanceSettings> = {};

  if (isFiniteNumber(candidate.summaryCacheTtlSeconds)) {
    nextSettings.summaryCacheTtlSeconds = candidate.summaryCacheTtlSeconds;
  }
  if (isFiniteNumber(candidate.reportDataCacheTtlSeconds)) {
    nextSettings.reportDataCacheTtlSeconds =
      candidate.reportDataCacheTtlSeconds;
  }
  if (isFiniteNumber(candidate.reportGenerationConcurrency)) {
    nextSettings.reportGenerationConcurrency =
      candidate.reportGenerationConcurrency;
  }

  return nextSettings;
}

function parseIntegrationPayload(
  candidate: Record<string, unknown>
): Partial<IntegrationSettings> {
  const nextSettings: Partial<IntegrationSettings> = {};

  if (isBoolean(candidate.mcpEnabled)) {
    nextSettings.mcpEnabled = candidate.mcpEnabled;
  }
  if (isBoolean(candidate.mcpAllowWrites)) {
    nextSettings.mcpAllowWrites = candidate.mcpAllowWrites;
  }

  return nextSettings;
}

function parseSettingsPayload(payload: unknown): SystemSettingsPatch | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const candidate = payload as Record<string, unknown>;

  if (
    "reporting" in candidate ||
    "performance" in candidate ||
    "integrations" in candidate
  ) {
    return {
      reporting:
        candidate.reporting && typeof candidate.reporting === "object"
          ? parseReportingPayload(candidate.reporting as Record<string, unknown>)
          : undefined,
      performance:
        candidate.performance && typeof candidate.performance === "object"
          ? parsePerformancePayload(
              candidate.performance as Record<string, unknown>
            )
          : undefined,
      integrations:
        candidate.integrations && typeof candidate.integrations === "object"
          ? parseIntegrationPayload(
              candidate.integrations as Record<string, unknown>
            )
          : undefined,
    };
  }

  return {
    reporting: parseReportingPayload(candidate),
  };
}

export async function GET() {
  const settings = await getSystemSettings();
  return Response.json(settings, { status: 200 });
}

export async function PUT(request: Request) {
  const rejected = rejectCrossOriginWrite(request);
  if (rejected) return rejected;
  const body = await readBoundedJSONBody(request, settingsBodyOptions);
  if (body.kind !== "ok") {
    const rejection = rejectedSettingsBody(body.kind);
    if (rejection) return rejection;
  }
  const payload = parseSettingsPayload(body.kind === "ok" ? body.value : null);

  if (payload === null) {
    return Response.json(
      { error: "Invalid settings payload" },
      { status: 400 }
    );
  }

  const settings = await saveSystemSettings(payload);
  return Response.json(settings, { status: 200 });
}

export async function POST(request: Request) {
  const rejected = rejectCrossOriginWrite(request);
  if (rejected) return rejected;
  const body = await readBoundedJSONBody(request, settingsBodyOptions);
  if (body.kind !== "ok") {
    const rejection = rejectedSettingsBody(body.kind);
    if (rejection) return rejection;
  }
  const payload = (body.kind === "ok" ? body.value : {}) as {
    action?: string;
  };

  if (payload.action !== "generate_mcp_key") {
    return Response.json({ error: "Unsupported action" }, { status: 400 });
  }

  const result = await generateMcpKey();
  return Response.json(result, { status: 200 });
}
