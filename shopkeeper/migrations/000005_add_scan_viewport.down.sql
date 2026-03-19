ALTER TABLE scans
    DROP COLUMN IF EXISTS viewport_height,
    DROP COLUMN IF EXISTS viewport_width,
    DROP COLUMN IF EXISTS viewport_preset;
