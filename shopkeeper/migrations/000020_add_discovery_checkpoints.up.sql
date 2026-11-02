CREATE TABLE scan_discoveries (
  scan_id UUID PRIMARY KEY REFERENCES scans(id) ON DELETE CASCADE,
  phase TEXT NOT NULL DEFAULT 'fetch' CHECK (phase IN ('fetch', 'probe', 'complete')),
  admission_epoch BIGINT NOT NULL DEFAULT 0 CHECK (admission_epoch >= 0),
  requests_used INTEGER NOT NULL DEFAULT 0 CHECK (requests_used BETWEEN 0 AND 20000),
  xml_bytes_used BIGINT NOT NULL DEFAULT 0 CHECK (xml_bytes_used BETWEEN 0 AND 134217729),
  next_candidate_ordinal INTEGER NOT NULL DEFAULT 0 CHECK (next_candidate_ordinal BETWEEN 0 AND 10000),
  active_ms_used BIGINT NOT NULL DEFAULT 0 CHECK (active_ms_used >= 0),
  active_started_at TIMESTAMPTZ,
  active_reserved_ms BIGINT NOT NULL DEFAULT 0 CHECK (active_reserved_ms BETWEEN 0 AND 960000),
  active_heartbeat_at TIMESTAMPTZ,
  CHECK ((active_started_at IS NULL AND active_reserved_ms = 0 AND active_heartbeat_at IS NULL)
      OR (active_started_at IS NOT NULL AND active_reserved_ms > 0 AND active_heartbeat_at IS NOT NULL))
);

CREATE TABLE scan_discovery_sitemaps (
  scan_id UUID NOT NULL REFERENCES scan_discoveries(scan_id) ON DELETE CASCADE,
  canonical_url TEXT NOT NULL,
  canonical_hash BYTEA NOT NULL CHECK (octet_length(canonical_hash) = 32),
  fetch_url TEXT NOT NULL,
  dfs_path INTEGER[] NOT NULL,
  depth SMALLINT NOT NULL CHECK (depth BETWEEN 0 AND 11),
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'done', 'failed')),
  failure_kind TEXT CHECK (failure_kind IS NULL OR failure_kind IN ('invalid_url', 'authority', 'depth', 'fetch', 'xml')),
  PRIMARY KEY (scan_id, dfs_path),
  CHECK (cardinality(dfs_path) = depth),
  CHECK (array_position(dfs_path, NULL) IS NULL),
  CHECK (failure_kind IS NULL OR state = 'failed')
);
CREATE INDEX idx_discovery_sitemaps_next ON scan_discovery_sitemaps(scan_id, dfs_path) WHERE state = 'queued';
CREATE INDEX idx_discovery_sitemaps_hash ON scan_discovery_sitemaps(scan_id, canonical_hash);

CREATE TABLE scan_discovery_candidates (
  scan_id UUID NOT NULL REFERENCES scan_discoveries(scan_id) ON DELETE CASCADE,
  raw_url TEXT NOT NULL,
  raw_hash BYTEA NOT NULL CHECK (octet_length(raw_hash) = 32),
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 9999),
  outcome TEXT NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending', 'eligible', 'external', 'unresolved')),
  final_url TEXT,
  redirected BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (scan_id, ordinal),
  CHECK ((outcome = 'eligible') = (final_url IS NOT NULL))
);
CREATE INDEX idx_discovery_candidates_next ON scan_discovery_candidates(scan_id, ordinal) WHERE outcome = 'pending';
CREATE INDEX idx_discovery_candidates_hash ON scan_discovery_candidates(scan_id, raw_hash);
