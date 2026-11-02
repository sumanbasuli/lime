package repository

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
)

// linkSourceSliceSQL accepts only repository-owned SQL expressions. Legacy
// arrays remain readable; row-backed results use the indexed ordinal range.
func linkSourceSliceSQL(offset, limit string) string {
	return `CASE WHEN r.sources_storage=0 THEN jsonb_path_query_array(r.sources,
		format('$[%s to %s]', (` + offset + `)::int, (` + offset + `)::int+(` + limit + `)::int-1)::jsonpath)
		ELSE COALESCE((SELECT jsonb_agg(s.source ORDER BY s.ordinal) FROM link_check_sources s
			WHERE s.result_id=r.id AND s.ordinal >= (` + offset + `)::int
			AND s.ordinal < (` + offset + `)::int+(` + limit + `)::int),'[]'::jsonb) END`
}

const linkAllSourcesSQL = `CASE WHEN r.sources_storage=0 THEN r.sources
	ELSE COALESCE((SELECT jsonb_agg(s.source ORDER BY s.ordinal) FROM link_check_sources s
		WHERE s.result_id=r.id),'[]'::jsonb) END`

var linkSourcesPageSQL = `SELECT CASE WHEN r.sources_storage=0 THEN jsonb_array_length(r.sources)
	ELSE r.occurrence_count END AS total, ` + linkSourceSliceSQL("$3", "$4") + ` AS sources
	FROM link_check_results r WHERE r.link_check_id=$1 AND r.id=$2`

// The caller holds the job row lock. Source inserts, metadata, and counters
// commit together, so a retry reads the last committed prefix and adds no
// duplicate rows. A legacy result is converted once only if it is published
// again; completed historical checks need no bulk migration or rewrite.
func linkSourcePrefixes(ctx context.Context, tx pgx.Tx, jobID string, results []models.LinkResult) (map[string]int, error) {
	prefixes := make(map[string]int, len(results))
	if len(results) == 0 {
		return prefixes, nil
	}
	targets := make([]string, 0, len(results))
	seen := make(map[string]bool, len(results))
	for _, result := range results {
		if seen[result.TargetURL] {
			return nil, fmt.Errorf("duplicate link result target %q", result.TargetURL)
		}
		seen[result.TargetURL] = true
		targets = append(targets, result.TargetURL)
	}
	type legacyResult struct {
		id, target  string
		count, size int
	}
	var legacy []legacyResult
	rows, err := tx.Query(ctx, `SELECT id,target_url,occurrence_count,sources_storage,
		CASE WHEN sources_storage=0 THEN jsonb_array_length(sources) ELSE 0 END
		FROM link_check_results WHERE link_check_id=$1 AND target_url=ANY($2::text[])`, jobID, targets)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var item legacyResult
		var storage int
		if err := rows.Scan(&item.id, &item.target, &item.count, &storage, &item.size); err != nil {
			rows.Close()
			return nil, err
		}
		prefixes[item.target] = item.count
		if storage == 0 {
			legacy = append(legacy, item)
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	for _, item := range legacy {
		if item.count != item.size {
			return nil, fmt.Errorf("legacy link source count mismatch for result %s", item.id)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO link_check_sources(result_id,ordinal,source)
			SELECT r.id,(s.ordinal-1)::int,s.source FROM link_check_results r,
			LATERAL jsonb_array_elements(r.sources) WITH ORDINALITY AS s(source,ordinal)
			WHERE r.id=$1`, item.id); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `UPDATE link_check_results SET sources_storage=1,sources='[]'::jsonb WHERE id=$1`, item.id); err != nil {
			return nil, err
		}
	}
	return prefixes, nil
}
