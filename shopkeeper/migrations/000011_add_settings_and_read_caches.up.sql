ALTER TABLE app_settings
  ADD COLUMN summary_cache_ttl_seconds INTEGER NOT NULL DEFAULT 60 CHECK (summary_cache_ttl_seconds > 0),
  ADD COLUMN report_data_cache_ttl_seconds INTEGER NOT NULL DEFAULT 300 CHECK (report_data_cache_ttl_seconds > 0),
  ADD COLUMN report_generation_concurrency INTEGER NOT NULL DEFAULT 1 CHECK (report_generation_concurrency > 0),
  ADD COLUMN mcp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN mcp_key_hash TEXT,
  ADD COLUMN mcp_key_hint TEXT,
  ADD COLUMN mcp_key_generated_at TIMESTAMP,
  ADD COLUMN mcp_sessions_revoked_at TIMESTAMP NOT NULL DEFAULT NOW();

CREATE TABLE scan_score_summary_cache (
  scan_id UUID PRIMARY KEY REFERENCES scans(id) ON DELETE CASCADE,
  scan_updated_at TIMESTAMP NOT NULL,
  scan_status scan_status NOT NULL,
  score INTEGER,
  has_score BOOLEAN NOT NULL,
  has_audit_data BOOLEAN NOT NULL,
  completed_url_count INTEGER NOT NULL,
  failed_url_count INTEGER NOT NULL,
  total_url_count INTEGER NOT NULL,
  has_full_coverage BOOLEAN NOT NULL,
  is_partial_scan BOOLEAN NOT NULL,
  passed_count INTEGER NOT NULL,
  failed_count INTEGER NOT NULL,
  not_applicable_count INTEGER NOT NULL,
  needs_review_count INTEGER NOT NULL,
  excluded_count INTEGER NOT NULL,
  weighted_passed INTEGER NOT NULL,
  weighted_failed INTEGER NOT NULL,
  weighted_total INTEGER NOT NULL,
  scored_audit_count INTEGER NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_scan_score_summary_cache_updated_at
  ON scan_score_summary_cache(updated_at);

CREATE TABLE scan_issue_summary_cache (
  scan_id UUID NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('failed', 'needs_review')),
  item_key TEXT NOT NULL,
  issue_id UUID REFERENCES issues(id) ON DELETE CASCADE,
  rule_id TEXT,
  title TEXT NOT NULL,
  help_url TEXT,
  severity severity,
  is_false_positive BOOLEAN NOT NULL DEFAULT FALSE,
  occurrence_count INTEGER NOT NULL,
  weight INTEGER NOT NULL,
  scored BOOLEAN NOT NULL,
  sort_bucket INTEGER NOT NULL,
  sort_severity INTEGER NOT NULL,
  sort_title TEXT NOT NULL,
  scan_updated_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (scan_id, kind, item_key)
);

CREATE INDEX idx_scan_issue_summary_cache_page
  ON scan_issue_summary_cache(scan_id, sort_bucket, weight DESC, sort_severity, sort_title, item_key);

CREATE INDEX idx_scan_issue_summary_cache_updated_at
  ON scan_issue_summary_cache(updated_at);
