package repository

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/sumanbasuli/lime/shopkeeper/internal/viewport"
)

func requireCapacity(t *testing.T, err error, kind string) {
	t.Helper()
	var capacity *AdmissionCapacityError
	if !errors.As(err, &capacity) || capacity.Kind != kind {
		t.Fatalf("capacity error = %v, want %s", err, kind)
	}
}

func activeCounts(t *testing.T, r *Repository, ctx context.Context) (int, int) {
	t.Helper()
	var scans, links int
	if err := r.pool.QueryRow(ctx, `SELECT
		(SELECT COUNT(*) FROM scans WHERE status IN ('pending','profiling','scanning','processing')),
		(SELECT COUNT(*) FROM link_checks WHERE status IN ('queued','running'))`).Scan(&scans, &links); err != nil {
		t.Fatal(err)
	}
	return scans, links
}

func TestAdmissionTransactionUsesReadCommittedSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	config := r.pool.Config()
	config.ConnConfig.RuntimeParams["default_transaction_isolation"] = "repeatable read"
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	var defaultIsolation string
	if err := pool.QueryRow(ctx, `SHOW default_transaction_isolation`).Scan(&defaultIsolation); err != nil {
		t.Fatal(err)
	}
	if defaultIsolation != "repeatable read" {
		t.Fatalf("fixture isolation default = %q, want repeatable read", defaultIsolation)
	}
	tx, err := New(pool).beginAdmissionTx(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	var isolation string
	if err := tx.QueryRow(ctx, `SHOW transaction_isolation`).Scan(&isolation); err != nil {
		t.Fatal(err)
	}
	if isolation != "read committed" {
		t.Fatalf("admission transaction isolation = %q, want read committed", isolation)
	}
}

func TestAdmissionCapsBothResourcesAndKeepsPairedCreationAtomicSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	v, _ := viewport.ResolvePreset("")
	execMCPFixture(t, r, ctx, `INSERT INTO scans(sitemap_url,status)
		SELECT 'https://fixture.test/scan/' || n, 'pending' FROM generate_series(1,127) n`)
	execMCPFixture(t, r, ctx, `INSERT INTO link_checks(url,check_type,max_pages)
		SELECT 'https://fixture.test/link/' || n, 'single', 1 FROM generate_series(1,127) n`)
	paired, err := r.CreateScanWithLinkCheck(ctx, "https://fixture.test/paired", "single", nil, v)
	if err != nil || paired == nil {
		t.Fatalf("last paired slot = %v, %v", paired, err)
	}
	if scans, links := activeCounts(t, r, ctx); scans != 128 || links != 128 {
		t.Fatalf("active after paired admission = %d scans, %d links", scans, links)
	}
	_, err = r.CreateScan(ctx, "https://fixture.test/overflow", "single", nil, v)
	requireCapacity(t, err, "scan")
	_, err = r.CreateLinkCheck(ctx, "https://fixture.test/overflow", "single", 1, nil)
	requireCapacity(t, err, "link check")
	_, err = r.CreateScanWithLinkCheck(ctx, "https://fixture.test/overflow-paired", "single", nil, v)
	requireCapacity(t, err, "scan")

	// A freed scan slot cannot allow an atomic paired submission to exceed
	// link-check capacity, and the rejected scan must leave no row behind.
	if err := r.UpdateScanStatus(ctx, paired.ID, "completed"); err != nil {
		t.Fatal(err)
	}
	_, err = r.CreateScanWithLinkCheck(ctx, "https://fixture.test/link-full", "single", nil, v)
	requireCapacity(t, err, "link check")
	if scans, links := activeCounts(t, r, ctx); scans != 127 || links != 128 {
		t.Fatalf("rejected paired submission changed rows: %d scans, %d links", scans, links)
	}
	if scan, err := r.CreateScan(ctx, "https://fixture.test/plain", "single", nil, v); err != nil || scan == nil {
		t.Fatalf("plain scan should use free scan slot: %v, %v", scan, err)
	}
}

func TestAdmissionRejectsRescanResumeRetryAndRecheckWithoutMutationSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	execMCPFixture(t, r, ctx, `INSERT INTO scans(sitemap_url,status)
		SELECT 'https://fixture.test/active/' || n, 'pending' FROM generate_series(1,128) n`)
	execMCPFixture(t, r, ctx, `INSERT INTO link_checks(url,check_type,max_pages)
		SELECT 'https://fixture.test/active-link/' || n, 'single', 1 FROM generate_series(1,128) n`)
	var pausedID, retryID, sourceJobID string
	if err := r.pool.QueryRow(ctx, `INSERT INTO scans(sitemap_url,status)
		VALUES ('https://fixture.test/paused','paused') RETURNING id`).Scan(&pausedID); err != nil {
		t.Fatal(err)
	}
	if err := r.pool.QueryRow(ctx, `INSERT INTO scans(sitemap_url,status,include_link_check)
		VALUES ('https://fixture.test/retry','completed',true) RETURNING id`).Scan(&retryID); err != nil {
		t.Fatal(err)
	}
	execMCPFixture(t, r, ctx, `INSERT INTO urls(scan_id,url,status) VALUES
		($1,'https://fixture.test/ok','completed'),($1,'https://fixture.test/fail','failed')`, retryID)
	if err := r.pool.QueryRow(ctx, `INSERT INTO link_checks(scan_id,url,check_type,max_pages,status)
		VALUES ($1,'https://fixture.test/retry','scan',1,'failed') RETURNING id`, retryID).Scan(&sourceJobID); err != nil {
		t.Fatal(err)
	}
	_, err := r.CreateRescanFrom(ctx, retryID)
	requireCapacity(t, err, "scan")
	_, err = r.ResumeScan(ctx, pausedID)
	requireCapacity(t, err, "scan")
	_, _, err = r.RetryFailedURLs(ctx, retryID)
	requireCapacity(t, err, "scan")
	_, err = r.CreateLinkCheckFrom(ctx, sourceJobID)
	requireCapacity(t, err, "link check")

	paused, err := r.GetScan(ctx, pausedID)
	if err != nil || paused == nil || paused.Status != "paused" {
		t.Fatalf("rejected resume changed status: %v, %v", paused, err)
	}
	retry, err := r.GetScan(ctx, retryID)
	if err != nil || retry == nil || retry.Status != "completed" {
		t.Fatalf("rejected retry changed scan: %v, %v", retry, err)
	}
	var failedURLs int
	if err := r.pool.QueryRow(ctx, `SELECT COUNT(*) FROM urls WHERE scan_id=$1 AND status='failed'`, retryID).Scan(&failedURLs); err != nil || failedURLs != 1 {
		t.Fatalf("rejected retry changed URL status: %d, %v", failedURLs, err)
	}
	job, err := r.GetLinkCheck(ctx, sourceJobID)
	if err != nil || job == nil || job.Status != "failed" {
		t.Fatalf("rejected retry changed companion: %v, %v", job, err)
	}
	if scans, links := activeCounts(t, r, ctx); scans != 128 || links != 128 {
		t.Fatalf("rejected lifecycle transition changed counts: %d scans, %d links", scans, links)
	}
	// With scan room available, both paths that create a companion still need
	// link-check room. A failed retry must not requeue its URLs or companion.
	execMCPFixture(t, r, ctx, `UPDATE scans SET status='completed'
		WHERE id=(SELECT id FROM scans WHERE status='pending' LIMIT 1)`)
	_, err = r.CreateRescanFrom(ctx, retryID)
	requireCapacity(t, err, "link check")
	_, _, err = r.RetryFailedURLs(ctx, retryID)
	requireCapacity(t, err, "link check")
	if scans, links := activeCounts(t, r, ctx); scans != 127 || links != 128 {
		t.Fatalf("link capacity rejection changed rows: %d scans, %d links", scans, links)
	}
	execMCPFixture(t, r, ctx, `UPDATE link_checks SET status='completed'
		WHERE id=(SELECT id FROM link_checks WHERE status='queued' LIMIT 1)`)
	retried, count, err := r.RetryFailedURLs(ctx, retryID)
	if err != nil || retried == nil || retried.Status != "pending" || count != 1 {
		t.Fatalf("retry with capacity = %v, %d, %v", retried, count, err)
	}
	job, err = r.GetLinkCheck(ctx, sourceJobID)
	if err != nil || job == nil || job.Status != "queued" {
		t.Fatalf("retry did not requeue companion: %v, %v", job, err)
	}
	if scans, links := activeCounts(t, r, ctx); scans != 128 || links != 128 {
		t.Fatalf("successful retry counts = %d scans, %d links", scans, links)
	}
}

func TestAdmissionSerializesConcurrentScanSubmissionsSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	v, _ := viewport.ResolvePreset("")
	execMCPFixture(t, r, ctx, `INSERT INTO scans(sitemap_url,status)
		SELECT 'https://fixture.test/active/' || n, 'pending' FROM generate_series(1,127) n`)
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := r.CreateScan(ctx, "https://fixture.test/concurrent", "single", nil, v)
			results <- err
		}()
	}
	wg.Wait()
	close(results)
	accepted, rejected := 0, 0
	for err := range results {
		if err == nil {
			accepted++
		} else {
			requireCapacity(t, err, "scan")
			rejected++
		}
	}
	if accepted != 1 || rejected != 1 {
		t.Fatalf("concurrent submissions = %d accepted, %d rejected", accepted, rejected)
	}
	if scans, _ := activeCounts(t, r, ctx); scans != 128 {
		t.Fatalf("concurrent submissions left %d active scans", scans)
	}
}

func TestAdmissionSerializesMixedAndReactivatedWorkSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	v, _ := viewport.ResolvePreset("")
	execMCPFixture(t, r, ctx, `INSERT INTO scans(sitemap_url,status)
		SELECT 'https://fixture.test/active/' || n, 'pending' FROM generate_series(1,127) n`)
	execMCPFixture(t, r, ctx, `INSERT INTO link_checks(url,check_type,max_pages)
		SELECT 'https://fixture.test/active-link/' || n, 'single', 1 FROM generate_series(1,127) n`)
	var pausedIDs [2]string
	for i := range pausedIDs {
		if err := r.pool.QueryRow(ctx, `INSERT INTO scans(sitemap_url,status)
			VALUES ('https://fixture.test/paused','paused') RETURNING id`).Scan(&pausedIDs[i]); err != nil {
			t.Fatal(err)
		}
	}

	results := make(chan error, 2)
	var wg sync.WaitGroup
	for _, run := range []func() error{
		func() error { _, err := r.CreateScanWithLinkCheck(ctx, "https://fixture.test/paired", "single", nil, v); return err },
		func() error { _, err := r.CreateLinkCheck(ctx, "https://fixture.test/standalone", "single", 1, nil); return err },
	} {
		wg.Add(1)
		go func(run func() error) { defer wg.Done(); results <- run() }(run)
	}
	wg.Wait()
	close(results)
	accepted, rejected := 0, 0
	for err := range results {
		if err == nil {
			accepted++
		} else {
			requireCapacity(t, err, "link check")
			rejected++
		}
	}
	if accepted != 1 || rejected != 1 {
		t.Fatalf("mixed admissions = %d accepted, %d rejected", accepted, rejected)
	}
	scans, links := activeCounts(t, r, ctx)
	if scans > 128 || links != 128 {
		t.Fatalf("mixed admissions left %d scans, %d links", scans, links)
	}

	// If the paired operation won, free one scan slot. If the standalone
	// check won, the scan pool already has exactly one slot free.
	if scans == 128 {
		execMCPFixture(t, r, ctx, `UPDATE scans SET status='completed'
			WHERE id=(SELECT id FROM scans WHERE status='pending' LIMIT 1)`)
	}
	results = make(chan error, 2)
	for _, id := range pausedIDs {
		wg.Add(1)
		go func(id string) { defer wg.Done(); _, err := r.ResumeScan(ctx, id); results <- err }(id)
	}
	wg.Wait()
	close(results)
	accepted, rejected = 0, 0
	for err := range results {
		if err == nil {
			accepted++
		} else {
			requireCapacity(t, err, "scan")
			rejected++
		}
	}
	if accepted != 1 || rejected != 1 {
		t.Fatalf("concurrent resumes = %d accepted, %d rejected", accepted, rejected)
	}
	if scans, links := activeCounts(t, r, ctx); scans > 128 || links != 128 {
		t.Fatalf("concurrent resumes left %d scans, %d links", scans, links)
	}
}
