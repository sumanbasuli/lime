CREATE INDEX idx_scans_created_at_desc ON scans(created_at DESC);
CREATE INDEX idx_scans_tag_created_at_desc ON scans(tag, created_at DESC);

CREATE INDEX idx_urls_scan_status ON urls(scan_id, status);
CREATE INDEX idx_urls_scan_url ON urls(scan_id, url);

CREATE INDEX idx_issues_scan_false_positive ON issues(scan_id, is_false_positive);
CREATE INDEX idx_issues_scan_violation_type ON issues(scan_id, violation_type);

CREATE INDEX idx_issue_occurrences_issue_url_created ON issue_occurrences(issue_id, url_id, created_at);

CREATE INDEX idx_url_audits_url_outcome_rule ON url_audits(url_id, outcome, rule_id);
CREATE INDEX idx_url_audit_occurrences_url_outcome_rule_created ON url_audit_occurrences(url_id, outcome, rule_id, created_at);
