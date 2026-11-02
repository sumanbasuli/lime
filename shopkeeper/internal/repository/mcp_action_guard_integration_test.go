package repository

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"testing"
	"time"
)

func withMCPActionSQL(t *testing.T, r *Repository, parent context.Context, operation func(context.Context) error) error {
	t.Helper()
	actionCtx, finish, err := r.BeginMCPActionCall(parent)
	if err != nil {
		t.Fatal(err)
	}
	defer finish()
	return operation(actionCtx)
}

func TestMCPActionEntityProjectionSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	execMCPFixture(t, r, ctx, `INSERT INTO scans(id,sitemap_url,status,tag)
		VALUES($1,'https://fixture.test/'||repeat('t',6*1024*1024),'completed','small')`, mcpScanID)
	if scan, err := r.GetScan(ctx, mcpScanID); err != nil || scan == nil || len(scan.SitemapURL) < 6<<20 {
		t.Fatalf("ordinary saved scan changed: present=%v err=%v", scan != nil, err)
	}
	err := withMCPActionSQL(t, r, ctx, func(actionCtx context.Context) error {
		_, err := r.GetScan(actionCtx, mcpScanID)
		return err
	})
	if !errors.Is(err, ErrMCPReadTooLarge) {
		t.Fatalf("oversized action scan crossed projection: %v", err)
	}

	execMCPFixture(t, r, ctx, `UPDATE scans SET sitemap_url='https://fixture.test/scan' WHERE id=$1`, mcpScanID)
	execMCPFixture(t, r, ctx, `INSERT INTO link_checks(id,scan_id,url,check_type,status,summary)
		VALUES($1,$2,'https://fixture.test/links','scan','completed',
		jsonb_build_object('blob',repeat('s',6*1024*1024)))`, mcpBudgetJobID, mcpScanID)
	if job, err := r.GetScanLinkCheck(ctx, mcpScanID); err != nil || job == nil {
		t.Fatalf("ordinary companion lookup changed: present=%v err=%v", job != nil, err)
	}
	err = withMCPActionSQL(t, r, ctx, func(actionCtx context.Context) error {
		_, err := r.GetScanLinkCheck(actionCtx, mcpScanID)
		return err
	})
	if !errors.Is(err, ErrMCPReadTooLarge) {
		t.Fatalf("oversized action companion crossed projection: %v", err)
	}
	if err := withMCPActionSQL(t, r, ctx, func(actionCtx context.Context) error {
		scan, err := r.GetScan(actionCtx, mcpScanID)
		if err != nil || scan == nil || scan.Tag == nil || *scan.Tag != "small" {
			t.Fatalf("normal action scan failed: present=%v err=%v", scan != nil, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestMCPActionOversizeMutationsRollbackSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	const pauseID = "aaaaaaaa-1111-4111-8111-111111111111"
	const resumeID = "aaaaaaaa-2222-4222-8222-222222222222"
	const retryID = "aaaaaaaa-3333-4333-8333-333333333333"
	const rescanID = "aaaaaaaa-4444-4444-8444-444444444444"
	const completedURLID = "bbbbbbbb-1111-4111-8111-111111111111"
	const failedURLID = "bbbbbbbb-2222-4222-8222-222222222222"
	const issueID = "cccccccc-1111-4111-8111-111111111111"
	for _, fixture := range []struct{ id, status string }{
		{pauseID, "pending"}, {resumeID, "paused"}, {retryID, "completed"}, {rescanID, "completed"},
	} {
		execMCPFixture(t, r, ctx, `INSERT INTO scans(id,sitemap_url,status,tag)
			VALUES($1,'https://fixture.test/'||repeat('t',6*1024*1024),$2,'small')`, fixture.id, fixture.status)
	}
	execMCPFixture(t, r, ctx, `INSERT INTO urls(id,scan_id,url,status) VALUES
		($1,$3,'https://fixture.test/completed','completed'),
		($2,$3,'https://fixture.test/failed','failed')`, completedURLID, failedURLID, retryID)
	execMCPFixture(t, r, ctx, `INSERT INTO issues(id,scan_id,violation_type,description,severity)
		VALUES($1,$2,'image-alt',repeat('d',6*1024*1024),'serious')`, issueID, rescanID)

	mutations := []struct {
		name string
		call func(context.Context) error
	}{
		{"pause", func(c context.Context) error { _, err := r.RequestPause(c, pauseID); return err }},
		{"resume", func(c context.Context) error { _, err := r.ResumeScan(c, resumeID); return err }},
		{"retry", func(c context.Context) error { _, _, err := r.RetryFailedURLs(c, retryID); return err }},
		{"rescan", func(c context.Context) error { _, err := r.CreateRescanFrom(c, rescanID); return err }},
		{"false_positive", func(c context.Context) error {
			_, err := r.SetIssueFalsePositive(c, rescanID, issueID, true)
			return err
		}},
	}
	for _, mutation := range mutations {
		t.Run(mutation.name, func(t *testing.T) {
			err := withMCPActionSQL(t, r, ctx, mutation.call)
			if !errors.Is(err, ErrMCPReadTooLarge) {
				t.Fatalf("oversized action mutation was accepted: %v", err)
			}
		})
	}
	var pauseRequested, falsePositive bool
	var resumeStatus, retryStatus, failedURLStatus string
	var scans int
	if err := r.pool.QueryRow(ctx, `SELECT pause_requested FROM scans WHERE id=$1`, pauseID).Scan(&pauseRequested); err != nil {
		t.Fatal(err)
	}
	if err := r.pool.QueryRow(ctx, `SELECT status FROM scans WHERE id=$1`, resumeID).Scan(&resumeStatus); err != nil {
		t.Fatal(err)
	}
	if err := r.pool.QueryRow(ctx, `SELECT status FROM scans WHERE id=$1`, retryID).Scan(&retryStatus); err != nil {
		t.Fatal(err)
	}
	if err := r.pool.QueryRow(ctx, `SELECT status FROM urls WHERE id=$1`, failedURLID).Scan(&failedURLStatus); err != nil {
		t.Fatal(err)
	}
	if err := r.pool.QueryRow(ctx, `SELECT is_false_positive FROM issues WHERE id=$1`, issueID).Scan(&falsePositive); err != nil {
		t.Fatal(err)
	}
	if err := r.pool.QueryRow(ctx, `SELECT COUNT(*) FROM scans`).Scan(&scans); err != nil {
		t.Fatal(err)
	}
	if pauseRequested || resumeStatus != "paused" || retryStatus != "completed" || failedURLStatus != "failed" || falsePositive || scans != 4 {
		t.Fatalf("rejected action committed state: pause=%v resume=%s retry=%s url=%s false_positive=%v scans=%d",
			pauseRequested, resumeStatus, retryStatus, failedURLStatus, falsePositive, scans)
	}
	if scan, err := r.RequestPause(ctx, pauseID); err != nil || scan == nil || !scan.PauseRequested {
		t.Fatalf("ordinary pause changed: present=%v err=%v", scan != nil, err)
	}
	if scan, err := r.ResumeScan(ctx, resumeID); err != nil || scan == nil || scan.Status != "pending" {
		t.Fatalf("ordinary resume changed: present=%v err=%v", scan != nil, err)
	}
	if scan, count, err := r.RetryFailedURLs(ctx, retryID); err != nil || scan == nil || count != 1 || scan.Status != "pending" {
		t.Fatalf("ordinary retry changed: present=%v count=%d err=%v", scan != nil, count, err)
	}
	if scan, err := r.CreateRescanFrom(ctx, rescanID); err != nil || scan == nil || scan.Status != "pending" {
		t.Fatalf("ordinary rescan changed: present=%v err=%v", scan != nil, err)
	}
	if issue, err := r.SetIssueFalsePositive(ctx, rescanID, issueID, true); err != nil || issue == nil || !issue.IsFalsePositive {
		t.Fatalf("ordinary false-positive update changed: present=%v err=%v", issue != nil, err)
	}
}

func TestMCPActionRecheckCopiesLargeHiddenInventorySQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	const sourceID = "dddddddd-1111-4111-8111-111111111111"
	execMCPFixture(t, r, ctx, `INSERT INTO scans(id,sitemap_url,status,root_public)
		VALUES($1,'https://fixture.test/scan','completed',TRUE)`, mcpScanID)
	execMCPFixture(t, r, ctx, `INSERT INTO link_checks(id,scan_id,url,check_type,status,root_public,seed_urls)
		SELECT $1,$2,'https://fixture.test/links','scan','completed',FALSE,
		jsonb_agg('https://fixture.test/' || lpad(n::text,5,'0') || repeat('x',512))
		FROM generate_series(1,8000) n`, sourceID, mcpScanID)
	var sourceBytes int
	if err := r.pool.QueryRow(ctx, `SELECT octet_length(seed_urls::text) FROM link_checks WHERE id=$1`, sourceID).Scan(&sourceBytes); err != nil || sourceBytes < 4<<20 {
		t.Fatalf("large seed fixture missing: bytes=%d err=%v", sourceBytes, err)
	}
	err := withMCPActionSQL(t, r, ctx, func(actionCtx context.Context) error {
		visible, err := r.GetScanLinkCheck(actionCtx, mcpScanID)
		if err != nil || visible == nil {
			t.Fatalf("action prerequisite failed: present=%v err=%v", visible != nil, err)
		}
		if len(visible.SeedURLs) != 0 {
			t.Fatalf("action prerequisite transferred %d hidden seeds", len(visible.SeedURLs))
		}
		copied, err := r.CreateLinkCheckFrom(actionCtx, sourceID)
		if err != nil {
			return err
		}
		if copied == nil || copied.ScanID != nil || len(copied.SeedURLs) != 0 || !copied.RootPublic {
			t.Fatalf("recheck result changed: copied=%+v", copied)
		}
		var same, public bool
		var length int
		if err := r.pool.QueryRow(ctx, `SELECT source.seed_urls=copied.seed_urls,
			jsonb_array_length(copied.seed_urls),copied.root_public
			FROM link_checks source,link_checks copied WHERE source.id=$1 AND copied.id=$2`, sourceID, copied.ID).
			Scan(&same, &length, &public); err != nil {
			return err
		}
		if !same || length != 8000 || !public {
			t.Fatalf("SQL recheck copy lost inventory or DNS policy: same=%v length=%d public=%v", same, length, public)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestMCPActionSQLReadCommittedAndShrinkingTimeout(t *testing.T) {
	r, fixtureCtx := mcpTestRepository(t)
	parent, cancel := context.WithTimeout(fixtureCtx, 3*time.Second)
	defer cancel()
	actionCtx, finish, err := r.BeginMCPActionCall(parent)
	if err != nil {
		t.Fatal(err)
	}
	defer finish()
	tx, err := r.actionTx(actionCtx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(actionCtx)
	var isolation, first, second string
	if err := tx.QueryRow(actionCtx, `SELECT current_setting('transaction_isolation'),current_setting('statement_timeout')`).
		Scan(&isolation, &first); err != nil {
		t.Fatal(err)
	}
	if isolation != "read committed" {
		t.Fatalf("action transaction isolation=%s", isolation)
	}
	time.Sleep(125 * time.Millisecond)
	if err := tx.QueryRow(actionCtx, `SELECT current_setting('statement_timeout')`).Scan(&second); err != nil {
		t.Fatal(err)
	}
	firstMS, firstErr := strconv.Atoi(strings.TrimSuffix(first, "ms"))
	secondMS, secondErr := strconv.Atoi(strings.TrimSuffix(second, "ms"))
	if firstErr != nil || secondErr != nil || firstMS-secondMS < 50 {
		t.Fatalf("action SQL timeout did not shrink: first=%q second=%q errors=%v/%v", first, second, firstErr, secondErr)
	}
}

func TestMCPActionDetachedCompletionRetainsUncertainSQLLease(t *testing.T) {
	r, fixtureCtx := mcpTestRepository(t)
	const id = "eeeeeeee-1111-4111-8111-111111111111"
	parent, cancel := context.WithCancel(fixtureCtx)
	defer cancel()
	actionCtx, finish, err := r.BeginMCPActionCall(parent)
	if err != nil {
		t.Fatal(err)
	}
	if _, created, err := r.BeginMCPAction(actionCtx, id, "create_scan", strings.Repeat("a", 64)); err != nil || !created {
		finish()
		t.Fatalf("could not reserve action: created=%v err=%v", created, err)
	}
	lock, err := r.pool.Begin(fixtureCtx)
	if err != nil {
		finish()
		t.Fatal(err)
	}
	defer lock.Rollback(fixtureCtx)
	if err := lock.QueryRow(fixtureCtx, `SELECT request_id FROM mcp_action_requests WHERE request_id=$1 FOR UPDATE`, id).Scan(new(string)); err != nil {
		finish()
		t.Fatal(err)
	}
	completionCtx, completionCancel := context.WithTimeout(context.WithoutCancel(actionCtx), 200*time.Millisecond)
	err = r.CompleteMCPAction(completionCtx, id, []byte(`{"action":"create_scan","http_status":201}`))
	completionCancel()
	if !errors.Is(err, context.DeadlineExceeded) {
		finish()
		t.Fatalf("locked detached completion did not respect fresh deadline: %v", err)
	}
	if actionCtx.Err() != nil {
		finish()
		t.Fatalf("original action context expired during detached completion: %v", actionCtx.Err())
	}
	retainUntil := finish()
	if retainUntil.Before(time.Now().Add(75 * time.Millisecond)) {
		t.Fatalf("uncertain detached SQL released lease early: %s", retainUntil)
	}
	if err := lock.Rollback(fixtureCtx); err != nil {
		t.Fatal(err)
	}
	var completed bool
	if err := r.pool.QueryRow(fixtureCtx, `SELECT response IS NOT NULL FROM mcp_action_requests WHERE request_id=$1`, id).Scan(&completed); err != nil || completed {
		t.Fatalf("timed-out completion wrote response: completed=%v err=%v", completed, err)
	}
}
