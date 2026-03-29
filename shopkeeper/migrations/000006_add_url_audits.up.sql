CREATE TYPE audit_outcome AS ENUM (
    'passed',
    'failed',
    'not_applicable',
    'incomplete'
);

CREATE TABLE url_audits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    url_id UUID NOT NULL REFERENCES urls(id) ON DELETE CASCADE,
    rule_id TEXT NOT NULL,
    outcome audit_outcome NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (url_id, rule_id)
);

CREATE INDEX idx_url_audits_url_id ON url_audits(url_id);
CREATE INDEX idx_url_audits_rule_id ON url_audits(rule_id);
