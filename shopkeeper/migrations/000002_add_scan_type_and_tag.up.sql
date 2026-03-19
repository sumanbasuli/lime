-- Add scan_type column: 'sitemap' for full sitemap scans, 'single' for single page scans
ALTER TABLE scans ADD COLUMN scan_type TEXT NOT NULL DEFAULT 'sitemap';

-- Add tag column for grouping/filtering scans
ALTER TABLE scans ADD COLUMN tag TEXT;

-- Indexes for filtering
CREATE INDEX idx_scans_tag ON scans(tag);
CREATE INDEX idx_scans_scan_type ON scans(scan_type);
