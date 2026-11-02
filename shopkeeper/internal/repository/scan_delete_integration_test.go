package repository

import (
	"context"
	"testing"
	"time"
)

func insertDeleteTestScan(t *testing.T, r *Repository, ctx context.Context, status string) string {
	t.Helper()
	var id string
	if err := r.pool.QueryRow(ctx,
		`INSERT INTO scans (sitemap_url, status) VALUES ('https://fixture.test/', $1) RETURNING id`,
		status,
	).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func TestDeleteScanOnlyRemovesTerminalRows(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	for _, status := range []string{"pending", "profiling", "scanning", "processing", "completed", "paused", "failed"} {
		t.Run(status, func(t *testing.T) {
			id := insertDeleteTestScan(t, r, ctx, status)
			deleted, err := r.DeleteScan(ctx, id)
			if err != nil {
				t.Fatal(err)
			}
			terminal := status == "completed" || status == "paused" || status == "failed"
			if deleted != terminal {
				t.Fatalf("DeleteScan(%s) = %v, want %v", status, deleted, terminal)
			}
			remaining, err := r.GetScan(ctx, id)
			if err != nil || (remaining != nil) == terminal {
				t.Fatalf("remaining scan after %s delete = %v, %v", status, remaining, err)
			}
		})
	}
}

func TestDeleteScanRechecksTerminalPredicateAfterConcurrentReactivation(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	id := insertDeleteTestScan(t, r, ctx, "paused")
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `UPDATE scans SET status='pending' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}

	type outcome struct {
		deleted bool
		err     error
	}
	result := make(chan outcome, 1)
	go func() {
		deleted, err := r.DeleteScan(ctx, id)
		result <- outcome{deleted, err}
	}()
	select {
	case got := <-result:
		t.Fatalf("delete returned before reactivation committed: %+v", got)
	case <-time.After(25 * time.Millisecond):
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-result:
		if got.err != nil || got.deleted {
			t.Fatalf("reactivated scan deleted: %+v", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("delete did not finish after reactivation committed")
	}
	scan, err := r.GetScan(ctx, id)
	if err != nil || scan == nil || scan.Status != "pending" {
		t.Fatalf("reactivated scan was not retained: %v, %v", scan, err)
	}
}

func TestDeleteScanCannotRemoveRetryOrResumeWork(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	pausedID := insertDeleteTestScan(t, r, ctx, "paused")
	if scan, err := r.ResumeScan(ctx, pausedID); err != nil || scan == nil || scan.Status != "pending" {
		t.Fatalf("resume = %v, %v", scan, err)
	}
	if deleted, err := r.DeleteScan(ctx, pausedID); err != nil || deleted {
		t.Fatalf("resumed scan delete = %v, %v", deleted, err)
	}

	retryID := insertDeleteTestScan(t, r, ctx, "completed")
	if _, err := r.pool.Exec(ctx, `INSERT INTO urls (scan_id, url, status) VALUES
		($1, 'https://fixture.test/ok', 'completed'), ($1, 'https://fixture.test/fail', 'failed')`, retryID); err != nil {
		t.Fatal(err)
	}
	if scan, count, err := r.RetryFailedURLs(ctx, retryID); err != nil || scan == nil || scan.Status != "pending" || count != 1 {
		t.Fatalf("retry = %v, %d, %v", scan, count, err)
	}
	if deleted, err := r.DeleteScan(ctx, retryID); err != nil || deleted {
		t.Fatalf("retried scan delete = %v, %v", deleted, err)
	}
}
