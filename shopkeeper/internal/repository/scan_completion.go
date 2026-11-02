package repository

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

// CompleteReadyScan is the final page-work transition. It locks the parent
// before inspecting discovery and URLs so a concurrent pause wins atomically.
func (r *Repository) CompleteReadyScan(ctx context.Context, id string) (string, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	var status, kind string
	var pause bool
	var total int
	if err := tx.QueryRow(ctx, `SELECT status,scan_type,pause_requested,total_urls FROM scans WHERE id=$1 FOR UPDATE`, id).Scan(&status, &kind, &pause, &total); err != nil {
		return "", err
	}
	if status != "pending" && status != "scanning" && status != "processing" {
		return "", ErrDiscoveryInvariant
	}
	if kind != "single" {
		var phase string
		err = tx.QueryRow(ctx, `SELECT phase FROM scan_discoveries WHERE scan_id=$1`, id).Scan(&phase)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return "", err
		}
		if err == nil && phase != "complete" {
			return "", ErrDiscoveryInvariant
		}
	}
	var count, unfinished, successful int
	if err := tx.QueryRow(ctx, `SELECT COUNT(*),COUNT(*) FILTER (WHERE status NOT IN ('completed','failed')),
		COUNT(*) FILTER (WHERE status='completed') FROM urls WHERE scan_id=$1`, id).Scan(&count, &unfinished, &successful); err != nil {
		return "", err
	}
	if count == 0 || count != total || unfinished != 0 || successful == 0 {
		return "", ErrDiscoveryInvariant
	}
	next := "completed"
	if pause {
		next = "paused"
	}
	if _, err := tx.Exec(ctx, `UPDATE scans SET status=$2,pause_requested=FALSE,updated_at=NOW() WHERE id=$1`, id, next); err != nil {
		return "", err
	}
	return next, tx.Commit(ctx)
}
