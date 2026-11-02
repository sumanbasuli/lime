CREATE INDEX idx_scans_active_status ON scans(status)
WHERE status IN ('pending', 'profiling', 'scanning', 'processing');
