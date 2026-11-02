CREATE INDEX idx_scans_pending_created_id ON scans(created_at, id) WHERE status = 'pending';
