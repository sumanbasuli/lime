CREATE TABLE scan_report_data_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id UUID NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  scope_kind TEXT NOT NULL DEFAULT 'scan' CHECK (scope_kind IN ('scan', 'failed', 'needs_review')),
  scope_key TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL CHECK (format IN ('pdf', 'csv', 'llm')),
  settings_fingerprint TEXT NOT NULL,
  scan_updated_at TIMESTAMP NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (scan_id, scope_kind, scope_key, format, settings_fingerprint)
);

CREATE INDEX idx_scan_report_data_cache_lookup
  ON scan_report_data_cache(scan_id, format, scope_kind, scope_key, settings_fingerprint);

CREATE INDEX idx_scan_report_data_cache_expires_at
  ON scan_report_data_cache(expires_at);
