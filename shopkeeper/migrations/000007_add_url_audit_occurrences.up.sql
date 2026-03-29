CREATE TABLE url_audit_occurrences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    url_id UUID NOT NULL REFERENCES urls(id) ON DELETE CASCADE,
    rule_id TEXT NOT NULL,
    outcome audit_outcome NOT NULL,
    html_snippet TEXT,
    screenshot_path TEXT,
    element_screenshot_path TEXT,
    css_selector TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_url_audit_occurrences_url_id ON url_audit_occurrences(url_id);
CREATE INDEX idx_url_audit_occurrences_rule_id ON url_audit_occurrences(rule_id);
CREATE INDEX idx_url_audit_occurrences_outcome ON url_audit_occurrences(outcome);
