"use client";

import { useState } from "react";
import { KeyRoundIcon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DEFAULT_SYSTEM_SETTINGS,
  type SystemSettings,
} from "@/lib/report-settings-config";

interface DashboardSettingsFormProps {
  initialSettings: SystemSettings;
}

type ReportSettingsNumericKey =
  | "reporting.fullPdfOccurrenceLimit"
  | "reporting.singleIssuePdfOccurrenceLimit"
  | "reporting.smallCsvOccurrenceLimit"
  | "reporting.llmOccurrenceLimit"
  | "performance.summaryCacheTtlSeconds"
  | "performance.reportDataCacheTtlSeconds"
  | "performance.reportGenerationConcurrency";

type ReportSettingsBooleanKey =
  | "reporting.pdfReportsEnabled"
  | "reporting.csvReportsEnabled"
  | "reporting.llmReportsEnabled"
  | "integrations.mcpEnabled";

interface NumericFieldConfig {
  key: ReportSettingsNumericKey;
  label: string;
  description: string;
}

interface ToggleFieldConfig {
  key: ReportSettingsBooleanKey;
  label: string;
  description: string;
}

const numericFields: NumericFieldConfig[] = [
  {
    key: "reporting.fullPdfOccurrenceLimit",
    label: "Full PDF occurrence cap",
    description: "Detailed occurrences shown per issue in the full scan PDF.",
  },
  {
    key: "reporting.singleIssuePdfOccurrenceLimit",
    label: "Single-issue PDF cap",
    description:
      "Detailed occurrences shown before a single-issue PDF truncates to CSV.",
  },
  {
    key: "reporting.smallCsvOccurrenceLimit",
    label: "Small CSV sample size",
    description: "Occurrences included per issue in the small CSV export.",
  },
  {
    key: "reporting.llmOccurrenceLimit",
    label: "LLM sample size",
    description: "Occurrences included per issue in the LLM text export.",
  },
];

const toggleFields: ToggleFieldConfig[] = [
  {
    key: "reporting.pdfReportsEnabled",
    label: "Enable PDF generation",
    description: "Allow full report and single-issue PDF downloads.",
  },
  {
    key: "reporting.csvReportsEnabled",
    label: "Enable CSV generation",
    description: "Allow small and full CSV report downloads.",
  },
  {
    key: "reporting.llmReportsEnabled",
    label: "Enable LLM export",
    description: "Allow compact text exports for LLM workflows.",
  },
];

const performanceFields: NumericFieldConfig[] = [
  {
    key: "performance.summaryCacheTtlSeconds",
    label: "Summary cache TTL",
    description: "Seconds to reuse score and issue summary read models.",
  },
  {
    key: "performance.reportDataCacheTtlSeconds",
    label: "Report data cache TTL",
    description: "Seconds to reuse derived report input metadata.",
  },
  {
    key: "performance.reportGenerationConcurrency",
    label: "Report concurrency",
    description: "Maximum PDF/report generation jobs allowed at once.",
  },
];

const integrationToggles: ToggleFieldConfig[] = [
  {
    key: "integrations.mcpEnabled",
    label: "Enable MCP",
    description: "Allow read-only third-party MCP clients to connect.",
  },
];

function buildErrorMessage(responseStatus: number, message: string): string {
  if (message) {
    return message;
  }

  return `Failed to save settings (${responseStatus})`;
}

function getNumericValue(settings: SystemSettings, key: ReportSettingsNumericKey) {
  switch (key) {
    case "reporting.fullPdfOccurrenceLimit":
      return settings.reporting.fullPdfOccurrenceLimit;
    case "reporting.singleIssuePdfOccurrenceLimit":
      return settings.reporting.singleIssuePdfOccurrenceLimit;
    case "reporting.smallCsvOccurrenceLimit":
      return settings.reporting.smallCsvOccurrenceLimit;
    case "reporting.llmOccurrenceLimit":
      return settings.reporting.llmOccurrenceLimit;
    case "performance.summaryCacheTtlSeconds":
      return settings.performance.summaryCacheTtlSeconds;
    case "performance.reportDataCacheTtlSeconds":
      return settings.performance.reportDataCacheTtlSeconds;
    case "performance.reportGenerationConcurrency":
      return settings.performance.reportGenerationConcurrency;
  }
}

function getBooleanValue(settings: SystemSettings, key: ReportSettingsBooleanKey) {
  switch (key) {
    case "reporting.pdfReportsEnabled":
      return settings.reporting.pdfReportsEnabled;
    case "reporting.csvReportsEnabled":
      return settings.reporting.csvReportsEnabled;
    case "reporting.llmReportsEnabled":
      return settings.reporting.llmReportsEnabled;
    case "integrations.mcpEnabled":
      return settings.integrations.mcpEnabled;
  }
}

function setNumericValue(
  settings: SystemSettings,
  key: ReportSettingsNumericKey,
  value: number
): SystemSettings {
  if (key.startsWith("reporting.")) {
    return {
      ...settings,
      reporting: {
        ...settings.reporting,
        [key.replace("reporting.", "")]: value,
      },
    };
  }

  return {
    ...settings,
    performance: {
      ...settings.performance,
      [key.replace("performance.", "")]: value,
    },
  };
}

function setBooleanValue(
  settings: SystemSettings,
  key: ReportSettingsBooleanKey,
  value: boolean
): SystemSettings {
  if (key.startsWith("reporting.")) {
    return {
      ...settings,
      reporting: {
        ...settings.reporting,
        [key.replace("reporting.", "")]: value,
      },
    };
  }

  return {
    ...settings,
    integrations: {
      ...settings.integrations,
      [key.replace("integrations.", "")]: value,
    },
  };
}

export function DashboardSettingsForm({
  initialSettings,
}: DashboardSettingsFormProps) {
  const [settings, setSettings] = useState<SystemSettings>(initialSettings);
  const [saving, setSaving] = useState(false);
  const [generatingKey, setGeneratingKey] = useState(false);
  const [generatedMcpKey, setGeneratedMcpKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const handleNumberChange = (
    key: ReportSettingsNumericKey,
    value: string
  ) => {
    const fallback = getNumericValue(DEFAULT_SYSTEM_SETTINGS, key);
    setSettings((current) => ({
      ...setNumericValue(
        current,
        key,
        value.trim() === ""
          ? fallback
          : Math.max(1, Math.trunc(Number(value) || fallback))
      ),
    }));
    setError(null);
    setSuccess(null);
  };

  const handleToggleChange = (key: ReportSettingsBooleanKey, checked: boolean) => {
    setSettings((current) => setBooleanValue(current, key, checked));
    setError(null);
    setSuccess(null);
  };

  const handleReset = () => {
    setSettings(DEFAULT_SYSTEM_SETTINGS);
    setGeneratedMcpKey(null);
    setError(null);
    setSuccess(null);
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    setSaving(true);
    setError(null);
    setSuccess(null);

    try {
      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        cache: "no-store",
        body: JSON.stringify(settings),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          buildErrorMessage(response.status, payload.error ?? "")
        );
      }

      const nextSettings = (await response.json()) as SystemSettings;
      setSettings(nextSettings);
      setSuccess("Settings saved. New requests use these values immediately.");
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : "Failed to save settings"
      );
    } finally {
      setSaving(false);
    }
  };

  const handleGenerateMcpKey = async () => {
    setGeneratingKey(true);
    setError(null);
    setSuccess(null);
    setGeneratedMcpKey(null);

    try {
      const response = await fetch("/api/settings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        cache: "no-store",
        body: JSON.stringify({ action: "generate_mcp_key" }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          buildErrorMessage(response.status, payload.error ?? "")
        );
      }

      const payload = (await response.json()) as {
        settings: SystemSettings;
        mcpKey: string;
      };
      setSettings(payload.settings);
      setGeneratedMcpKey(payload.mcpKey);
      setSuccess("MCP key generated. Store it now; it will not be shown again.");
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Failed to generate MCP key"
      );
    } finally {
      setGeneratingKey(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <section className="space-y-3">
        <div>
          <h3 className="font-heading text-xl font-bold">Reporting</h3>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          {numericFields.map((field) => (
            <label
              key={field.key}
              className="rounded-xl border border-black/10 bg-white p-4"
            >
              <div className="space-y-1.5">
                <div className="text-sm font-medium text-foreground">
                  {field.label}
                </div>
                <p className="text-xs leading-5 text-muted-foreground">
                  {field.description}
                </p>
              </div>
              <Input
                type="number"
                min={1}
                step={1}
                value={getNumericValue(settings, field.key)}
                disabled={saving}
                onChange={(event) =>
                  handleNumberChange(field.key, event.target.value)
                }
                className="mt-3 h-10"
              />
            </label>
          ))}
        </div>

        <div className="grid gap-3 lg:grid-cols-3">
          {toggleFields.map((field) => (
            <label
              key={field.key}
              className="flex gap-3 rounded-xl border border-black/10 bg-white p-4"
            >
              <input
                type="checkbox"
                checked={getBooleanValue(settings, field.key)}
                disabled={saving}
                onChange={(event) =>
                  handleToggleChange(field.key, event.target.checked)
                }
                className="mt-0.5 h-4 w-4 shrink-0 accent-black"
              />
              <span className="space-y-1">
                <span className="block text-sm font-medium text-foreground">
                  {field.label}
                </span>
                <span className="block text-xs leading-5 text-muted-foreground">
                  {field.description}
                </span>
              </span>
            </label>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h3 className="font-heading text-xl font-bold">Performance</h3>
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          {performanceFields.map((field) => (
            <label
              key={field.key}
              className="rounded-xl border border-black/10 bg-white p-4"
            >
              <div className="space-y-1.5">
                <div className="text-sm font-medium text-foreground">
                  {field.label}
                </div>
                <p className="text-xs leading-5 text-muted-foreground">
                  {field.description}
                </p>
              </div>
              <Input
                type="number"
                min={1}
                step={1}
                value={getNumericValue(settings, field.key)}
                disabled={saving}
                onChange={(event) =>
                  handleNumberChange(field.key, event.target.value)
                }
                className="mt-3 h-10"
              />
            </label>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h3 className="font-heading text-xl font-bold">Integrations</h3>
        </div>

        <div className="grid gap-3 lg:grid-cols-2">
          {integrationToggles.map((field) => (
            <label
              key={field.key}
              className="flex gap-3 rounded-xl border border-black/10 bg-white p-4"
            >
              <input
                type="checkbox"
                checked={getBooleanValue(settings, field.key)}
                disabled={saving || generatingKey}
                onChange={(event) =>
                  handleToggleChange(field.key, event.target.checked)
                }
                className="mt-0.5 h-4 w-4 shrink-0 accent-black"
              />
              <span className="space-y-1">
                <span className="block text-sm font-medium text-foreground">
                  {field.label}
                </span>
                <span className="block text-xs leading-5 text-muted-foreground">
                  {field.description}
                </span>
              </span>
            </label>
          ))}

          <div className="rounded-xl border border-black/10 bg-white p-4">
            <div className="space-y-1.5">
              <div className="text-sm font-medium text-foreground">
                MCP key
              </div>
              <p className="text-xs leading-5 text-muted-foreground">
                {settings.integrations.mcpConfigured
                  ? `Configured ${settings.integrations.mcpKeyHint ?? ""}`
                  : "No MCP key generated yet."}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={saving || generatingKey}
              onClick={() => void handleGenerateMcpKey()}
              className="mt-3"
            >
              {generatingKey ? (
                <>
                  <Loader2Icon className="h-4 w-4 animate-spin" />
                  Generating...
                </>
              ) : (
                <>
                  <KeyRoundIcon className="h-4 w-4" />
                  Generate MCP key
                </>
              )}
            </Button>
          </div>
        </div>

        {generatedMcpKey ? (
          <div className="rounded-xl border border-[#0E5A4A]/20 bg-[#E7FFF6] p-4">
            <p className="text-sm font-medium text-[#0F172A]">
              New MCP key
            </p>
            <code className="mt-2 block break-all rounded-lg bg-white p-3 text-xs text-[#0F172A]">
              {generatedMcpKey}
            </code>
          </div>
        ) : null}
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={saving || generatingKey}>
          {saving ? (
            <>
              <Loader2Icon className="h-4 w-4 animate-spin" />
              Saving…
            </>
          ) : (
            "Save settings"
          )}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={saving}
          onClick={handleReset}
        >
          Reset to defaults
        </Button>
        <p className="text-xs text-muted-foreground">
          These settings apply across the whole server and affect future exports.
        </p>
      </div>

      <div className="min-h-5">
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : success ? (
          <p className="text-sm text-[#0E5A4A]">{success}</p>
        ) : null}
      </div>
    </form>
  );
}
