package repository

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
)

// StreamLinkExportRows visits one CSV row at a time. A single SQL statement
// gives even an active check one consistent result snapshot, while the LATERAL
// expansion avoids transferring every source array into Go memory at once.
// An empty source array still emits one row with a zero-value LinkSource.
func (r *Repository) StreamLinkExportRows(ctx context.Context, id string, emit func(models.LinkResult, models.LinkSource) error) error {
	rows, err := r.pool.Query(ctx, `SELECT r.id,r.target_url,r.status,r.status_code,r.final_url,r.redirect_count,
			r.link_type,r.occurrence_count,r.error,r.error_kind,src.source
		FROM link_check_results r
		LEFT JOIN LATERAL (
			SELECT s.source,s.ordinal-1 AS ordinal
			FROM jsonb_array_elements(r.sources) WITH ORDINALITY AS s(source,ordinal)
			WHERE r.sources_storage=0
			UNION ALL
			SELECT s.source,s.ordinal::bigint FROM link_check_sources s
			WHERE r.sources_storage=1 AND s.result_id=r.id
		) src ON TRUE
		WHERE r.link_check_id=$1
		ORDER BY r.target_url,r.id,src.ordinal`, id)
	if err != nil {
		return fmt.Errorf("query link export rows: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var result models.LinkResult
		var source models.LinkSource
		var encoded []byte
		if err := rows.Scan(&result.ID, &result.TargetURL, &result.Status, &result.StatusCode,
			&result.FinalURL, &result.RedirectCount, &result.LinkType, &result.OccurrenceCount,
			&result.Error, &result.ErrorKind, &encoded); err != nil {
			return fmt.Errorf("read link export row: %w", err)
		}
		if encoded != nil {
			if err := json.Unmarshal(encoded, &source); err != nil {
				return fmt.Errorf("decode link export source: %w", err)
			}
		}
		if err := emit(result, source); err != nil {
			return err
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("read link export rows: %w", err)
	}
	return ctx.Err()
}
