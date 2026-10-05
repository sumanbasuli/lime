"use client";

import { useEffect, useState } from "react";
import { MaterialSymbol } from "@/components/material-symbol";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DEFAULT_SYSTEM_SETTINGS,
  type SystemSettings,
} from "@/lib/report-settings-config";
import {
  readUpdateNoticeEnabled,
  writeUpdateNoticeEnabled,
} from "@/lib/update-notice-preference";

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
    description: "Allow read-only third-party MCP clients to connect. Save settings to apply this switch.",
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
  const [updateNoticeEnabled, setUpdateNoticeEnabled] = useState(true);
  const [mcpEndpoint, setMcpEndpoint] = useState("");
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const isBusy = saving || generatingKey;
  const mcpConnectionDetails = [
    "Transport: Streamable HTTP",
    `URL: ${mcpEndpoint || "https://your-lime-host/mcp"}`,
    "Authorization: Bearer <YOUR_MCP_KEY>",
  ].join("\n");
  const mcpConfig = [
    "[mcp_servers.lime]",
    `url = ${JSON.stringify(mcpEndpoint || "https://your-lime-host/mcp")}`,
    'bearer_token_env_var = "LIME_MCP_KEY"',
  ].join("\n");

  useEffect(() => {
    setUpdateNoticeEnabled(readUpdateNoticeEnabled());
    setMcpEndpoint(new URL("/mcp", window.location.origin).href);
  }, []);

  const copyMcpValue = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopyFeedback(`${label} copied.`);
    } catch {
      setCopyFeedback("Copy failed. Select the displayed text and copy it manually.");
    }
  };

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
    setSettings((current) => ({
      ...DEFAULT_SYSTEM_SETTINGS,
      integrations: {
        ...current.integrations,
        mcpEnabled: DEFAULT_SYSTEM_SETTINGS.integrations.mcpEnabled,
      },
    }));
    setUpdateNoticeEnabled(true);
    writeUpdateNoticeEnabled(true);
    setGeneratedMcpKey(null);
    setCopyFeedback(null);
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
    if (isBusy) return;
    if (
      settings.integrations.mcpConfigured &&
      !window.confirm(
        "Rotate the MCP key? The current key will stop working immediately. Update every connected client with the new key."
      )
    ) {
      return;
    }

    setGeneratingKey(true);
    setError(null);
    setSuccess(null);
    setGeneratedMcpKey(null);
    setCopyFeedback(null);

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
      setSettings((current) => ({
        ...current,
        integrations: {
          ...current.integrations,
          ...payload.settings.integrations,
        },
      }));
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
    <form onSubmit={handleSubmit} className="space-y-7">
      <section className="space-y-3" aria-labelledby="reporting-settings-title">
        <div>
          <h2 id="reporting-settings-title" className="lime-section-title">Reporting</h2>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          {numericFields.map((field) => (
            <label
              key={field.key}
              className="lime-card rounded-2xl p-4"
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
                disabled={isBusy}
                onChange={(event) =>
                  handleNumberChange(field.key, event.target.value)
                }
                className="mt-3 h-10 w-32 rounded-xl bg-[#FBFAF6] font-mono shadow-none focus:bg-white"
              />
            </label>
          ))}
        </div>

        <div className="lime-card divide-y divide-black/[0.07] overflow-hidden rounded-2xl">
          {toggleFields.map((field) => (
            <label
              key={field.key}
              className="flex items-center gap-3 px-5 py-4"
            >
              <input
                type="checkbox"
                checked={getBooleanValue(settings, field.key)}
                disabled={isBusy}
                onChange={(event) =>
                  handleToggleChange(field.key, event.target.checked)
                }
                className="peer sr-only"
              />
              <span className="space-y-1">
                <span className="block text-sm font-medium text-foreground">
                  {field.label}
                </span>
                <span className="block text-xs leading-5 text-muted-foreground">
                  {field.description}
                </span>
              </span>
              <span aria-hidden="true" className="relative ml-auto h-6 w-11 shrink-0 rounded-full bg-black/10 transition-colors after:absolute after:top-0.5 after:left-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:shadow-sm after:transition-all peer-checked:bg-black peer-checked:after:translate-x-5 peer-checked:after:bg-[#FFED00]" />
            </label>
          ))}
          <label className="flex items-center gap-3 px-5 py-4">
            <input
              type="checkbox"
              checked={updateNoticeEnabled}
              disabled={isBusy}
              onChange={(event) => {
                setUpdateNoticeEnabled(event.target.checked);
                writeUpdateNoticeEnabled(event.target.checked);
                setError(null);
                setSuccess(null);
              }}
              className="peer sr-only"
            />
            <span className="space-y-1">
              <span className="block text-sm font-medium text-foreground">
                Update notice
              </span>
              <span className="block text-xs leading-5 text-muted-foreground">
                Show a sidebar card when a newer LIME release is available on GitHub.
              </span>
            </span>
            <span aria-hidden="true" className="relative ml-auto h-6 w-11 shrink-0 rounded-full bg-black/10 transition-colors after:absolute after:top-0.5 after:left-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:shadow-sm after:transition-all peer-checked:bg-black peer-checked:after:translate-x-5 peer-checked:after:bg-[#FFED00]" />
          </label>
        </div>
      </section>

      <section className="space-y-3" aria-labelledby="performance-settings-title">
        <div>
          <h2 id="performance-settings-title" className="lime-section-title">Performance</h2>
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          {performanceFields.map((field) => (
            <label
              key={field.key}
              className="lime-card rounded-2xl p-4"
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
                disabled={isBusy}
                onChange={(event) =>
                  handleNumberChange(field.key, event.target.value)
                }
                className="mt-3 h-10 w-32 rounded-xl bg-[#FBFAF6] font-mono shadow-none focus:bg-white"
              />
            </label>
          ))}
        </div>
      </section>

      <section className="space-y-3" aria-labelledby="integration-settings-title">
        <div>
          <h2 id="integration-settings-title" className="lime-section-title">Integrations</h2>
        </div>

        <div className="grid gap-3 lg:grid-cols-2">
          {integrationToggles.map((field) => (
            <label
              key={field.key}
              className="lime-card flex items-start gap-3 rounded-2xl p-4"
            >
              <input
                type="checkbox"
                checked={getBooleanValue(settings, field.key)}
                disabled={isBusy}
                onChange={(event) =>
                  handleToggleChange(field.key, event.target.checked)
                }
                className="peer sr-only"
              />
              <span className="space-y-1">
                <span className="block text-sm font-medium text-foreground">
                  {field.label}
                </span>
                <span className="block text-xs leading-5 text-muted-foreground">
                  {field.description}
                </span>
              </span>
              <span aria-hidden="true" className="relative ml-auto h-6 w-11 shrink-0 rounded-full bg-black/10 transition-colors after:absolute after:top-0.5 after:left-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:shadow-sm after:transition-all peer-checked:bg-black peer-checked:after:translate-x-5 peer-checked:after:bg-[#FFED00]" />
            </label>
          ))}

          <div className="lime-card rounded-2xl p-4">
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
              disabled={isBusy}
              onClick={() => void handleGenerateMcpKey()}
              className="mt-3 rounded-full border-black/14 bg-white hover:bg-black hover:text-[#FFED00]"
            >
              {generatingKey ? (
                <>
                  <MaterialSymbol name="progress_activity" size={16} className="animate-spin" />
                  Generating...
                </>
              ) : (
                <>
                  <MaterialSymbol name="key" size={16} />
                  {settings.integrations.mcpConfigured ? "Rotate MCP key" : "Generate MCP key"}
                </>
              )}
            </Button>
            <p className="mt-3 text-xs leading-5 text-muted-foreground">
              Generating or rotating a key enables MCP immediately; no save is
              needed. Rotating revokes the current key.
            </p>
          </div>
        </div>

        <div className="lime-card min-w-0 space-y-4 rounded-2xl p-4 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-1.5">
              <h3 className="text-sm font-semibold text-foreground">Connect an AI tool</h3>
              <p className="text-xs leading-5 text-muted-foreground">
                MCP can read scans, saved findings, report metadata, and saved
                link checks with their destinations and source references. It cannot
                create scans or change your data.
              </p>
            </div>
            <a
              href="https://lime.heysuman.com/docs/user/mcp/"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs font-semibold text-foreground hover:underline"
            >
              MCP setup guide
              <MaterialSymbol name="open_in_new" size={14} />
            </a>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-medium text-foreground">Streamable HTTP endpoint</p>
            <code className="block break-all rounded-xl border border-black/10 bg-[#FBFAF6] p-3 text-xs text-foreground">
              {mcpEndpoint || "/mcp"}
            </code>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!mcpEndpoint}
              onClick={() => void copyMcpValue(mcpEndpoint, "Endpoint")}
              className="rounded-full border-black/14 bg-white"
            >
              <MaterialSymbol name="content_copy" size={15} />
              Copy MCP endpoint
            </Button>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-medium text-foreground">Bearer token authentication</p>
            <p className="text-xs leading-5 text-muted-foreground">
              Use any client that supports Streamable HTTP and custom headers.
              Replace the placeholder with your generated key and send this
              header on every request. Client configuration fields may differ.
            </p>
            <code className="block break-all rounded-xl border border-black/10 bg-[#FBFAF6] p-3 text-xs text-foreground">
              Authorization: Bearer &lt;YOUR_MCP_KEY&gt;
            </code>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!mcpEndpoint}
              onClick={() => void copyMcpValue(mcpConnectionDetails, "HTTP connection details")}
              className="rounded-full border-black/14 bg-white"
            >
              <MaterialSymbol name="content_copy" size={15} />
              Copy HTTP connection details
            </Button>
          </div>

          <div className="space-y-2 border-t border-black/8 pt-4">
            <p className="text-xs font-medium text-foreground">Codex configuration example (optional)</p>
            <p className="text-xs leading-5 text-muted-foreground">
              Set <code>LIME_MCP_KEY</code> to your generated key in the environment
              that starts Codex. Add this to <code>~/.codex/config.toml</code>, then
              reconnect or start a new session. Keep the key out of config files.
            </p>
            <pre className="whitespace-pre-wrap break-all rounded-xl border border-black/10 bg-[#FBFAF6] p-3 text-xs text-foreground">
              <code>{mcpConfig}</code>
            </pre>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!mcpEndpoint}
              onClick={() => void copyMcpValue(mcpConfig, "Codex config")}
              className="rounded-full border-black/14 bg-white"
            >
              <MaterialSymbol name="content_copy" size={15} />
              Copy Codex config
            </Button>
          </div>
        </div>

        {generatedMcpKey ? (
          <div className="rounded-2xl border border-[#0E5A4A]/20 bg-[#E7FFF6] p-4">
            <p className="text-sm font-medium text-[#0F172A]">
              New MCP key
            </p>
            <code className="mt-2 block break-all rounded-lg bg-white p-3 text-xs text-[#0F172A]">
              {generatedMcpKey}
            </code>
            <p className="mt-2 text-xs leading-5 text-[#0F172A]/75">
              Copy and store this key now. It will not be shown after you leave
              this page. Only share it with clients you trust.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isBusy}
              onClick={() => void copyMcpValue(generatedMcpKey, "MCP key")}
              className="mt-3 rounded-full border-black/14 bg-white"
            >
              <MaterialSymbol name="content_copy" size={15} />
              Copy MCP key
            </Button>
          </div>
        ) : null}
        {copyFeedback ? (
          <p role="status" className="text-xs text-muted-foreground">{copyFeedback}</p>
        ) : null}
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={isBusy} className="rounded-full bg-black px-[22px] text-white hover:bg-[#FFED00] hover:text-black">
          {saving ? (
            <>
              <MaterialSymbol name="progress_activity" size={16} className="animate-spin" />
              Saving…
            </>
          ) : (
            <>
              <MaterialSymbol name="save" size={16} />
              Save settings
            </>
          )}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={isBusy}
          onClick={handleReset}
          className="rounded-full border-black/14 bg-white px-5 hover:bg-black/5"
        >
          Reset to defaults
        </Button>
        <p className="text-xs text-muted-foreground">
          These settings apply across the whole server and affect future exports.
        </p>
      </div>

      <div className="min-h-5">
        {error ? (
          <p role="alert" className="text-sm text-destructive">{error}</p>
        ) : success ? (
          <p className="text-sm text-[#0E5A4A]">{success}</p>
        ) : null}
      </div>
    </form>
  );
}
