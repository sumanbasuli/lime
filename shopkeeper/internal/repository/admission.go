package repository

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
)

const (
	maxActiveScans      = 128
	maxActiveLinkChecks = 128
)

// AdmissionCapacityError means the durable queue has no room for another
// active scan or link check. Existing rows are never discarded to make room.
type AdmissionCapacityError struct {
	Kind  string
	Limit int
}

func (e *AdmissionCapacityError) Error() string {
	return fmt.Sprintf("active %s capacity of %d reached", e.Kind, e.Limit)
}

// Each admission query needs a fresh snapshot after the advisory lock is
// acquired. Explicitly select READ COMMITTED so a database-wide isolation
// override cannot make a source-row read freeze the capacity count.
func (r *Repository) beginAdmissionTx(ctx context.Context) (pgx.Tx, error) {
	if r.mcpAction(ctx) != nil {
		return r.actionTx(ctx)
	}
	return r.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
}

// admitActiveWork serializes all transitions that add durable active work,
// including reactivations. The transaction-scoped lock is shared by both
// resource types so an atomic scan-and-link-check creation has one gate.
func admitActiveWork(ctx context.Context, tx pgx.Tx, scans, linkChecks int) error {
	// "LIME" plus a dedicated admission lock namespace.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(1279872325, 1)`); err != nil {
		return fmt.Errorf("failed to lock admission gate: %w", err)
	}

	var activeScans, activeLinkChecks int
	if err := tx.QueryRow(ctx, `SELECT
		(SELECT COUNT(*) FROM scans WHERE status IN ('pending', 'profiling', 'scanning', 'processing')),
		(SELECT COUNT(*) FROM link_checks WHERE status IN ('queued', 'running'))`,
	).Scan(&activeScans, &activeLinkChecks); err != nil {
		return fmt.Errorf("failed to count active work: %w", err)
	}
	if scans > 0 && activeScans+scans > maxActiveScans {
		return &AdmissionCapacityError{Kind: "scan", Limit: maxActiveScans}
	}
	if linkChecks > 0 && activeLinkChecks+linkChecks > maxActiveLinkChecks {
		return &AdmissionCapacityError{Kind: "link check", Limit: maxActiveLinkChecks}
	}
	return nil
}
