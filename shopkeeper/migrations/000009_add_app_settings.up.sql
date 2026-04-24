CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  full_pdf_occurrence_limit INTEGER NOT NULL DEFAULT 30 CHECK (full_pdf_occurrence_limit > 0),
  single_issue_pdf_occurrence_limit INTEGER NOT NULL DEFAULT 2000 CHECK (single_issue_pdf_occurrence_limit > 0),
  small_csv_occurrence_limit INTEGER NOT NULL DEFAULT 5 CHECK (small_csv_occurrence_limit > 0),
  llm_occurrence_limit INTEGER NOT NULL DEFAULT 3 CHECK (llm_occurrence_limit > 0),
  pdf_reports_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  csv_reports_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  llm_reports_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

INSERT INTO app_settings (key)
VALUES ('global')
ON CONFLICT (key) DO NOTHING;
