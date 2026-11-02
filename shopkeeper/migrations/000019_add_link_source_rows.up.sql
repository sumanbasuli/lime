-- Historical results keep their JSONB arrays. New publications store each
-- ordered occurrence once, avoiding a growing JSONB rewrite on every page.
ALTER TABLE link_check_results ADD COLUMN sources_storage SMALLINT NOT NULL DEFAULT 0
    CHECK (sources_storage IN (0, 1));
ALTER TABLE link_check_results ADD CONSTRAINT link_result_row_sources_empty
    CHECK (sources_storage = 0 OR sources = '[]'::jsonb);

CREATE TABLE link_check_sources (
    result_id UUID NOT NULL REFERENCES link_check_results(id) ON DELETE CASCADE ON UPDATE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    source JSONB NOT NULL CHECK (jsonb_typeof(source) = 'object'),
    PRIMARY KEY (result_id, ordinal)
);
