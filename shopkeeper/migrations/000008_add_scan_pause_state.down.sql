UPDATE scans
SET status = 'failed'
WHERE status = 'paused';

ALTER TABLE scans
DROP COLUMN IF EXISTS pause_requested;

ALTER TYPE scan_status RENAME TO scan_status_old;

CREATE TYPE scan_status AS ENUM (
    'pending', 'profiling', 'scanning', 'processing', 'completed', 'failed'
);

ALTER TABLE scans
ALTER COLUMN status DROP DEFAULT,
ALTER COLUMN status TYPE scan_status
USING status::text::scan_status,
ALTER COLUMN status SET DEFAULT 'pending';

DROP TYPE scan_status_old;
