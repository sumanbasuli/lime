"use client";

import { useState } from "react";
import { Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DEFAULT_REPORT_SETTINGS,
  type ReportSettings,
} from "@/lib/report-settings-config";

interface DashboardSettingsFormProps {
  initialSettings: ReportSettings;
}

type ReportSettingsNumericKey =
  | "fullPdfOccurrenceLimit"
  | "singleIssuePdfOccurrenceLimit"
  | "smallCsvOccurrenceLimit"
  | "llmOccurrenceLimit";

type ReportSettingsBooleanKey =
  | "pdfReportsEnabled"
  | "csvReportsEnabled"
  | "llmReportsEnabled";

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
    key: "fullPdfOccurrenceLimit",
    label: "Full PDF occurrence cap",
    description: "Detailed occurrences shown per issue in the full scan PDF.",
  },
  {
    key: "singleIssuePdfOccurrenceLimit",
    label: "Single-issue PDF cap",
    description:
      "Detailed occurrences shown before a single-issue PDF truncates to CSV.",
  },
  {
    key: "smallCsvOccurrenceLimit",
    label: "Small CSV sample size",
    description: "Occurrences included per issue in the small CSV export.",
  },
  {
    key: "llmOccurrenceLimit",
    label: "LLM sample size",
    description: "Occurrences included per issue in the LLM text export.",
  },
];

const toggleFields: ToggleFieldConfig[] = [
  {
    key: "pdfReportsEnabled",
    label: "Enable PDF generation",
    description: "Allow full report and single-issue PDF downloads.",
  },
  {
    key: "csvReportsEnabled",
    label: "Enable CSV generation",
    description: "Allow small and full CSV report downloads.",
  },
  {
    key: "llmReportsEnabled",
    label: "Enable LLM export",
    description: "Allow compact text exports for LLM workflows.",
  },
];

function buildErrorMessage(responseStatus: number, message: string): string {
  if (message) {
    return message;
  }

  return `Failed to save settings (${responseStatus})`;
}

export function DashboardSettingsForm({
  initialSettings,
}: DashboardSettingsFormProps) {
  const [settings, setSettings] = useState<ReportSettings>(initialSettings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const handleNumberChange = (
    key: ReportSettingsNumericKey,
    value: string
  ) => {
    setSettings((current) => ({
      ...current,
      [key]:
        value.trim() === ""
          ? DEFAULT_REPORT_SETTINGS[key]
          : Math.max(1, Math.trunc(Number(value) || DEFAULT_REPORT_SETTINGS[key])),
    }));
    setError(null);
    setSuccess(null);
  };

  const handleToggleChange = (key: ReportSettingsBooleanKey, checked: boolean) => {
    setSettings((current) => ({
      ...current,
      [key]: checked,
    }));
    setError(null);
    setSuccess(null);
  };

  const handleReset = () => {
    setSettings(DEFAULT_REPORT_SETTINGS);
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

      const nextSettings = (await response.json()) as ReportSettings;
      setSettings(nextSettings);
      setSuccess("Settings saved. New downloads use these values immediately.");
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : "Failed to save settings"
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
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
              value={settings[field.key]}
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
              checked={settings[field.key]}
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

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={saving}>
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
