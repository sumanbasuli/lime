-- Restore complete ordered arrays before removing the new storage. An image
-- rollback alone is not a schema rollback; all backends must be stopped first.
DO $$ BEGIN
    IF EXISTS (
        SELECT 1 FROM link_check_results r
        WHERE r.sources_storage = 1 AND r.occurrence_count <>
            (SELECT COUNT(*) FROM link_check_sources s WHERE s.result_id = r.id)
    ) THEN
        RAISE EXCEPTION 'link source count mismatch; refusing a lossy storage downgrade';
    END IF;
END $$;

UPDATE link_check_results r SET sources_storage = 0,
    sources = COALESCE((SELECT jsonb_agg(s.source ORDER BY s.ordinal)
        FROM link_check_sources s WHERE s.result_id = r.id), '[]'::jsonb)
    WHERE r.sources_storage = 1;
DROP TABLE link_check_sources;
ALTER TABLE link_check_results DROP CONSTRAINT link_result_row_sources_empty;
ALTER TABLE link_check_results DROP COLUMN sources_storage;
