package repository

import (
	"context"
	"testing"
)

func TestRecoverScanPagesPreservesCompletedAndClearsUnfinishedEvidence(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	const scanID = "11111111-1111-4111-8111-111111111111"
	const completedURL = "22222222-2222-4222-8222-222222222222"
	const pendingURL = "33333333-3333-4333-8333-333333333333"
	const sharedIssue = "44444444-4444-4444-8444-444444444444"
	const pendingIssue = "55555555-5555-4555-8555-555555555555"
	execMCPFixture(t, r, ctx, `INSERT INTO scans(id,sitemap_url,status,total_urls,scanned_urls)
		VALUES($1,'https://fixture.test/sitemap.xml','processing',2,2)`, scanID)
	execMCPFixture(t, r, ctx, `INSERT INTO urls(id,scan_id,url,status) VALUES
		($1,$3,'https://fixture.test/done','completed'),
		($2,$3,'https://fixture.test/retry','pending')`, completedURL, pendingURL, scanID)
	execMCPFixture(t, r, ctx, `INSERT INTO issues(id,scan_id,violation_type,description,severity) VALUES
		($1,$3,'shared','Shared','serious'),($2,$3,'partial','Partial','serious')`, sharedIssue, pendingIssue, scanID)
	execMCPFixture(t, r, ctx, `INSERT INTO issue_occurrences(issue_id,url_id) VALUES
		($1,$3),($1,$4),($2,$4)`, sharedIssue, pendingIssue, completedURL, pendingURL)
	execMCPFixture(t, r, ctx, `INSERT INTO url_audits(url_id,rule_id,outcome) VALUES
		($1,'rule','passed'),($2,'rule','failed')`, completedURL, pendingURL)
	execMCPFixture(t, r, ctx, `INSERT INTO url_audit_occurrences(url_id,rule_id,outcome) VALUES
		($1,'rule','incomplete'),($2,'rule','incomplete')`, completedURL, pendingURL)

	if err := r.RecoverScanPages(ctx, scanID); err != nil {
		t.Fatal(err)
	}
	if err := r.RecoverScanPages(ctx, scanID); err != nil {
		t.Fatalf("second recovery: %v", err)
	}
	scan, err := r.GetScan(ctx, scanID)
	if err != nil || scan.Status != "pending" || scan.ScannedURLs != 1 || scan.TotalURLs != 2 {
		t.Fatalf("recovered scan = %#v, err = %v", scan, err)
	}
	for _, table := range []string{"issue_occurrences", "url_audits", "url_audit_occurrences"} {
		assertEvidenceCount(t, ctx, r, table, completedURL, 1)
		assertEvidenceCount(t, ctx, r, table, pendingURL, 0)
	}
	var issueCount int
	if err := r.pool.QueryRow(ctx, `SELECT COUNT(*) FROM issues WHERE scan_id=$1`, scanID).Scan(&issueCount); err != nil || issueCount != 1 {
		t.Fatalf("retained issue groups = %d, err = %v", issueCount, err)
	}
}

func TestRecoverScanPagesHonorsInterruptedPause(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	const scanID = "11111111-1111-4111-8111-111111111111"
	execMCPFixture(t, r, ctx, `INSERT INTO scans(id,sitemap_url,status,pause_requested)
		VALUES($1,'https://fixture.test/sitemap.xml','scanning',true)`, scanID)
	if err := r.RecoverScanPages(ctx, scanID); err != nil {
		t.Fatal(err)
	}
	scan, err := r.GetScan(ctx, scanID)
	if err != nil || scan.Status != "paused" || scan.PauseRequested {
		t.Fatalf("recovered pause = %#v, err = %v", scan, err)
	}
}

func TestFailScanWithPageCleanupRemovesPartialEvidence(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	const scanID = "11111111-1111-4111-8111-111111111111"
	const pendingURL = "22222222-2222-4222-8222-222222222222"
	const issueID = "33333333-3333-4333-8333-333333333333"
	execMCPFixture(t, r, ctx, `INSERT INTO scans(id,sitemap_url,status)
		VALUES($1,'https://fixture.test/sitemap.xml','scanning')`, scanID)
	execMCPFixture(t, r, ctx, `INSERT INTO urls(id,scan_id,url,status)
		VALUES($1,$2,'https://fixture.test/partial','pending')`, pendingURL, scanID)
	execMCPFixture(t, r, ctx, `INSERT INTO issues(id,scan_id,violation_type,description,severity)
		VALUES($1,$2,'partial','Partial','serious')`, issueID, scanID)
	execMCPFixture(t, r, ctx, `INSERT INTO issue_occurrences(issue_id,url_id)
		VALUES($1,$2)`, issueID, pendingURL)
	execMCPFixture(t, r, ctx, `INSERT INTO url_audits(url_id,rule_id,outcome)
		VALUES($1,'partial','failed')`, pendingURL)
	if err := r.FailScanWithPageCleanup(ctx, scanID); err != nil {
		t.Fatal(err)
	}
	scan, err := r.GetScan(ctx, scanID)
	if err != nil || scan.Status != "failed" {
		t.Fatalf("failed scan = %#v, err = %v", scan, err)
	}
	assertEvidenceCount(t, ctx, r, "issue_occurrences", pendingURL, 0)
	assertEvidenceCount(t, ctx, r, "url_audits", pendingURL, 0)
	var issueCount int
	if err := r.pool.QueryRow(ctx, `SELECT COUNT(*) FROM issues WHERE scan_id=$1`, scanID).Scan(&issueCount); err != nil || issueCount != 0 {
		t.Fatalf("partial issue groups = %d, err = %v", issueCount, err)
	}
}

func assertEvidenceCount(t *testing.T, ctx context.Context, r *Repository, table, urlID string, want int) {
	t.Helper()
	var got int
	if err := r.pool.QueryRow(ctx, `SELECT COUNT(*) FROM `+table+` WHERE url_id=$1`, urlID).Scan(&got); err != nil || got != want {
		t.Fatalf("%s for URL %s = %d, want %d, err = %v", table, urlID, got, want, err)
	}
}
