package repository

import "testing"

func TestPendingScanQueueAndConditionalPauseSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	var pendingIndexCount int
	if err := r.pool.QueryRow(ctx, `SELECT COUNT(*) FROM pg_indexes
		WHERE schemaname = current_schema() AND indexname = 'idx_scans_pending_created_id'`).Scan(&pendingIndexCount); err != nil || pendingIndexCount != 1 {
		t.Fatalf("pending queue index count = %d, err = %v", pendingIndexCount, err)
	}
	const first = "11111111-1111-4111-8111-111111111111"
	const second = "22222222-2222-4222-8222-222222222222"
	const running = "33333333-3333-4333-8333-333333333333"
	execMCPFixture(t, r, ctx, `INSERT INTO scans (id, sitemap_url, status, created_at)
		VALUES ($1, 'https://fixture.test/first', 'pending', '2026-01-01'),
		       ($2, 'https://fixture.test/second', 'pending', '2026-01-02'),
		       ($3, 'https://fixture.test/running', 'profiling', '2026-01-03')`,
		first, second, running)

	queued, err := r.ListPendingScans(ctx, 1)
	if err != nil || len(queued) != 1 || queued[0].ID != first {
		t.Fatalf("oldest pending scan = %v, err = %v", queued, err)
	}
	recoverable, err := r.ListRecoverableScans(ctx)
	if err != nil || len(recoverable) != 1 || recoverable[0].ID != running {
		t.Fatalf("recovery should not load ordinary pending scans: %v, err = %v", recoverable, err)
	}
	if _, err := r.RequestPause(ctx, first); err != nil {
		t.Fatal(err)
	}
	recoverable, err = r.ListRecoverableScans(ctx)
	if err != nil || len(recoverable) != 2 || recoverable[0].ID != first {
		t.Fatalf("recovery should include queued pause request: %v, err = %v", recoverable, err)
	}
	if err := r.FinalizeQueuedScanPause(ctx, first); err != nil {
		t.Fatal(err)
	}
	paused, err := r.GetScan(ctx, first)
	if err != nil || paused == nil || paused.Status != "paused" || paused.PauseRequested {
		t.Fatalf("queued pause = %v, err = %v", paused, err)
	}
	// A worker holding the old paused snapshot must not undo an immediate
	// resume after the queued pause has already been finalized.
	if resumed, err := r.ResumeScan(ctx, first); err != nil || resumed == nil || resumed.Status != "pending" {
		t.Fatalf("resume after queued pause = %v, err = %v", resumed, err)
	}
	if err := r.FinalizePausedScan(ctx, first); err != nil {
		t.Fatal(err)
	}
	resumed, err := r.GetScan(ctx, first)
	if err != nil || resumed == nil || resumed.Status != "pending" || resumed.PauseRequested {
		t.Fatalf("stale pause overwrote resume = %v, err = %v", resumed, err)
	}
	// A current pause request on active work must still finalize normally.
	if _, err := r.RequestPause(ctx, first); err != nil {
		t.Fatal(err)
	}
	if err := r.FinalizePausedScan(ctx, first); err != nil {
		t.Fatal(err)
	}
	paused, err = r.GetScan(ctx, first)
	if err != nil || paused == nil || paused.Status != "paused" || paused.PauseRequested {
		t.Fatalf("current pause did not finalize = %v, err = %v", paused, err)
	}

	// A completion between the handler's pause request and the scheduler's
	// callback must not be rewritten to paused.
	if _, err := r.RequestPause(ctx, running); err != nil {
		t.Fatal(err)
	}
	if err := r.UpdateScanStatus(ctx, running, "completed"); err != nil {
		t.Fatal(err)
	}
	if err := r.FinalizeQueuedScanPause(ctx, running); err != nil {
		t.Fatal(err)
	}
	completed, err := r.GetScan(ctx, running)
	if err != nil || completed == nil || completed.Status != "completed" {
		t.Fatalf("completed scan changed by queued pause = %v, err = %v", completed, err)
	}
	queued, err = r.ListPendingScans(ctx, 2)
	if err != nil || len(queued) != 1 || queued[0].ID != second {
		t.Fatalf("remaining pending scans = %v, err = %v", queued, err)
	}
}
