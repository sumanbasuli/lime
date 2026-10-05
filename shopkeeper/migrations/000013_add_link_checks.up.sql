ALTER TABLE scans ADD COLUMN include_link_check BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE link_checks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scan_id UUID UNIQUE REFERENCES scans(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    check_type TEXT NOT NULL CHECK (check_type IN ('single', 'crawl', 'scan')),
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
    max_pages INTEGER NOT NULL DEFAULT 100 CHECK (max_pages BETWEEN 1 AND 500),
    pages_checked INTEGER NOT NULL DEFAULT 0,
    pages_failed INTEGER NOT NULL DEFAULT 0,
    links_checked INTEGER NOT NULL DEFAULT 0,
    total_links INTEGER NOT NULL DEFAULT 0,
    truncated BOOLEAN NOT NULL DEFAULT false,
    error TEXT,
    summary JSONB NOT NULL DEFAULT '{"healthy":0,"redirected":0,"broken":0,"error":0,"blocked":0,"unchecked":0,"timeout":0}',
    seed_urls JSONB NOT NULL DEFAULT '[]',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE TABLE link_check_results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    link_check_id UUID NOT NULL REFERENCES link_checks(id) ON DELETE CASCADE,
    target_url TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('healthy', 'redirected', 'broken', 'error', 'blocked', 'unchecked')),
    status_code INTEGER,
    final_url TEXT,
    redirect_count INTEGER NOT NULL DEFAULT 0,
    link_type TEXT NOT NULL CHECK (link_type IN ('internal', 'external', 'document', 'media')),
    occurrence_count INTEGER NOT NULL DEFAULT 0,
    sources JSONB NOT NULL DEFAULT '[]',
    error TEXT,
    error_kind TEXT,
    UNIQUE (link_check_id, target_url)
);
CREATE INDEX idx_link_checks_created ON link_checks(created_at DESC, id DESC);
CREATE INDEX idx_link_checks_active ON link_checks(status) WHERE status IN ('queued', 'running');
CREATE INDEX idx_link_check_results_status ON link_check_results(link_check_id, status, target_url);
