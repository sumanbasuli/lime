export interface ReportingSettings {
  fullPdfOccurrenceLimit: number;
  singleIssuePdfOccurrenceLimit: number;
  smallCsvOccurrenceLimit: number;
  llmOccurrenceLimit: number;
  pdfReportsEnabled: boolean;
  csvReportsEnabled: boolean;
  llmReportsEnabled: boolean;
}

export interface PerformanceSettings {
  summaryCacheTtlSeconds: number;
  reportDataCacheTtlSeconds: number;
  reportGenerationConcurrency: number;
}

export interface IntegrationSettings {
  mcpEnabled: boolean;
  mcpConfigured: boolean;
  mcpKeyHint: string | null;
  mcpKeyGeneratedAt: string | null;
}

export interface SystemSettings {
  reporting: ReportingSettings;
  performance: PerformanceSettings;
  integrations: IntegrationSettings;
}

export type ReportSettings = ReportingSettings;

export interface SystemSettingsPatch {
  reporting?: Partial<ReportingSettings>;
  performance?: Partial<PerformanceSettings>;
  integrations?: Partial<IntegrationSettings>;
}

export const DEFAULT_REPORT_SETTINGS: ReportingSettings = {
  fullPdfOccurrenceLimit: 30,
  singleIssuePdfOccurrenceLimit: 2000,
  smallCsvOccurrenceLimit: 5,
  llmOccurrenceLimit: 3,
  pdfReportsEnabled: true,
  csvReportsEnabled: true,
  llmReportsEnabled: true,
};

export const DEFAULT_PERFORMANCE_SETTINGS: PerformanceSettings = {
  summaryCacheTtlSeconds: 60,
  reportDataCacheTtlSeconds: 300,
  reportGenerationConcurrency: 1,
};

export const DEFAULT_INTEGRATION_SETTINGS: IntegrationSettings = {
  mcpEnabled: false,
  mcpConfigured: false,
  mcpKeyHint: null,
  mcpKeyGeneratedAt: null,
};

export const DEFAULT_SYSTEM_SETTINGS: SystemSettings = {
  reporting: DEFAULT_REPORT_SETTINGS,
  performance: DEFAULT_PERFORMANCE_SETTINGS,
  integrations: DEFAULT_INTEGRATION_SETTINGS,
};
