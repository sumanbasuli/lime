export interface ReportSettings {
  fullPdfOccurrenceLimit: number;
  singleIssuePdfOccurrenceLimit: number;
  smallCsvOccurrenceLimit: number;
  llmOccurrenceLimit: number;
  pdfReportsEnabled: boolean;
  csvReportsEnabled: boolean;
  llmReportsEnabled: boolean;
}

export const DEFAULT_REPORT_SETTINGS: ReportSettings = {
  fullPdfOccurrenceLimit: 30,
  singleIssuePdfOccurrenceLimit: 2000,
  smallCsvOccurrenceLimit: 5,
  llmOccurrenceLimit: 3,
  pdfReportsEnabled: true,
  csvReportsEnabled: true,
  llmReportsEnabled: true,
};
