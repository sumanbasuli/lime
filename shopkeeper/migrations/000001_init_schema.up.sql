-- Create custom enum types
CREATE TYPE scan_status AS ENUM (
    'pending', 'profiling', 'scanning', 'processing', 'completed', 'failed'
);

CREATE TYPE url_status AS ENUM (
    'pending', 'scanning', 'completed', 'failed'
);

CREATE TYPE severity AS ENUM (
    'critical', 'serious', 'moderate', 'minor'
);

-- Scans table: top-level scan record
CREATE TABLE scans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sitemap_url TEXT NOT NULL,
    status scan_status NOT NULL DEFAULT 'pending',
    total_urls INTEGER NOT NULL DEFAULT 0,
    scanned_urls INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- URLs table: individual URLs discovered during a scan
CREATE TABLE urls (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scan_id UUID NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    status url_status NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Issues table: deduplicated accessibility violations
CREATE TABLE issues (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scan_id UUID NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
    violation_type TEXT NOT NULL,
    description TEXT NOT NULL,
    severity severity NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Issue occurrences: specific instances of an issue on a URL
CREATE TABLE issue_occurrences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    url_id UUID NOT NULL REFERENCES urls(id) ON DELETE CASCADE,
    html_snippet TEXT,
    screenshot_path TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Indexes for common query patterns
CREATE INDEX idx_urls_scan_id ON urls(scan_id);
CREATE INDEX idx_issues_scan_id ON issues(scan_id);
CREATE INDEX idx_issues_severity ON issues(severity);
CREATE INDEX idx_issue_occurrences_issue_id ON issue_occurrences(issue_id);
CREATE INDEX idx_issue_occurrences_url_id ON issue_occurrences(url_id);
