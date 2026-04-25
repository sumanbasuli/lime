DROP INDEX IF EXISTS idx_scan_issue_summary_cache_updated_at;
DROP INDEX IF EXISTS idx_scan_issue_summary_cache_page;
DROP TABLE IF EXISTS scan_issue_summary_cache;

DROP INDEX IF EXISTS idx_scan_score_summary_cache_updated_at;
DROP TABLE IF EXISTS scan_score_summary_cache;

ALTER TABLE app_settings
  DROP COLUMN IF EXISTS mcp_sessions_revoked_at,
  DROP COLUMN IF EXISTS mcp_key_generated_at,
  DROP COLUMN IF EXISTS mcp_key_hint,
  DROP COLUMN IF EXISTS mcp_key_hash,
  DROP COLUMN IF EXISTS mcp_enabled,
  DROP COLUMN IF EXISTS report_generation_concurrency,
  DROP COLUMN IF EXISTS report_data_cache_ttl_seconds,
  DROP COLUMN IF EXISTS summary_cache_ttl_seconds;
