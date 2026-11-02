package repository

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestIssueResponseBudgetBoundaries(t *testing.T) {
	if !issueResponseFits(1, 1, 64, maxLegacyIssueEstimate) {
		t.Fatal("one ordinary issue and occurrence should fit")
	}
	if issueResponseFits(513, 0, 0, maxLegacyIssueEstimate) {
		t.Fatal("issue count above the conservative ACT allowance was admitted")
	}
	if issueResponseFits(1, 32768, 0, maxLegacyIssueEstimate) {
		t.Fatal("occurrence count above the row allowance was admitted")
	}
	if issueResponseFits(1, 1, 6<<20, maxLegacyIssueEstimate) {
		t.Fatal("one oversized TEXT field was admitted")
	}
	if issueResponseFits(-1, 0, 0, maxLegacyIssueEstimate) {
		t.Fatal("negative aggregates were admitted")
	}
}

func TestLegacyScanIssueReadAdmissionSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	const scanID = "a1111111-1111-4111-8111-111111111111"
	const urlID = "a2222222-2222-4222-8222-222222222222"
	const issueID = "a3333333-3333-4333-8333-333333333333"
	execMCPFixture(t, r, ctx, `INSERT INTO scans(id,sitemap_url,status) VALUES($1,'https://fixture.test','completed')`, scanID)
	execMCPFixture(t, r, ctx, `INSERT INTO urls(id,scan_id,url,status) VALUES($1,$2,'https://fixture.test/page','completed')`, urlID, scanID)
	execMCPFixture(t, r, ctx, `INSERT INTO issues(id,scan_id,violation_type,description,severity)
		VALUES($1,$2,'image-alt','Missing alt','serious')`, issueID, scanID)
	execMCPFixture(t, r, ctx, `INSERT INTO issue_occurrences(issue_id,url_id,html_snippet)
		VALUES($1,$2,'<img>')`, issueID, urlID)
	issues, err := r.GetScanIssues(ctx, scanID)
	if err != nil || len(issues) != 1 || len(issues[0].Occurrences) != 1 {
		t.Fatalf("ordinary legacy read: issues=%d error=%v", len(issues), err)
	}

	// A single historical TEXT value can outweigh a small row count. The large
	// field is generated inside PostgreSQL; no issue row is transferred to Go.
	execMCPFixture(t, r, ctx, `UPDATE issue_occurrences SET html_snippet=repeat('x', 6*1024*1024) WHERE issue_id=$1`, issueID)
	if _, err := r.GetScanIssues(ctx, scanID); !errors.Is(err, ErrScanIssuesTooLarge) {
		t.Fatalf("oversized occurrence text: %v", err)
	}
	if _, _, _, err := r.GetScanIssueOccurrencePage(ctx, scanID, issueID, 1, 0); !errors.Is(err, ErrScanIssuesTooLarge) {
		t.Fatalf("oversized occurrence page text: %v", err)
	}
	execMCPFixture(t, r, ctx, `INSERT INTO issue_occurrences(id,issue_id,url_id,html_snippet,created_at)
		VALUES('a4444444-4444-4444-8444-444444444444',$1,$2,'<small>','2000-01-01')`, issueID, urlID)
	_, smallOccurrences, total, err := r.GetScanIssueOccurrencePage(ctx, scanID, issueID, 1, 0)
	if err != nil || total != 2 || len(smallOccurrences) != 1 || smallOccurrences[0].ID != "a4444444-4444-4444-8444-444444444444" {
		t.Fatalf("selected small occurrence page: total=%d rows=%v error=%v", total, smallOccurrences, err)
	}
	if _, _, _, err := r.GetScanIssueOccurrencePage(ctx, scanID, issueID, 1, 1); !errors.Is(err, ErrScanIssuesTooLarge) {
		t.Fatalf("selected oversized occurrence page: %v", err)
	}
	execMCPFixture(t, r, ctx, `UPDATE issue_occurrences SET html_snippet='<img>' WHERE issue_id=$1`, issueID)
	execMCPFixture(t, r, ctx, `UPDATE issues SET description=repeat('y', 6*1024*1024) WHERE id=$1`, issueID)
	if _, err := r.GetScanIssues(ctx, scanID); !errors.Is(err, ErrScanIssuesTooLarge) {
		t.Fatalf("oversized issue text: %v", err)
	}
	if _, _, err := r.ListScanIssuesPage(ctx, scanID, 1, 0); !errors.Is(err, ErrScanIssuesTooLarge) {
		t.Fatalf("oversized issue page text: %v", err)
	}
	execMCPFixture(t, r, ctx, `INSERT INTO issues(id,scan_id,violation_type,description,severity)
		VALUES('a0000000-0000-4000-8000-000000000000',$1,'small','Small group','serious')`, scanID)
	smallIssues, total, err := r.ListScanIssuesPage(ctx, scanID, 1, 0)
	if err != nil || total != 2 || len(smallIssues) != 1 || smallIssues[0].ID != "a0000000-0000-4000-8000-000000000000" {
		t.Fatalf("selected small issue page: total=%d rows=%v error=%v", total, smallIssues, err)
	}
	if _, _, err := r.ListScanIssuesPage(ctx, scanID, 1, 1); !errors.Is(err, ErrScanIssuesTooLarge) {
		t.Fatalf("selected oversized issue page: %v", err)
	}
}

func TestLegacyScanIssueCountAdmissionAndSnapshotSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	const scanID = "b1111111-1111-4111-8111-111111111111"
	const urlID = "b2222222-2222-4222-8222-222222222222"
	execMCPFixture(t, r, ctx, `INSERT INTO scans(id,sitemap_url,status) VALUES($1,'https://fixture.test','completed')`, scanID)
	execMCPFixture(t, r, ctx, `INSERT INTO urls(id,scan_id,url,status) VALUES($1,$2,'https://fixture.test/page','completed')`, urlID, scanID)
	execMCPFixture(t, r, ctx, `INSERT INTO issues(scan_id,violation_type,description,severity)
		VALUES($1,'first','Original','moderate')`, scanID)
	tx, err := r.beginIssueRead(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if err := admitLegacyScanIssues(ctx, tx, scanID); err != nil {
		t.Fatal(err)
	}
	// Commit a writer on another connection after preflight. The reader must
	// still see only its admitted snapshot.
	execMCPFixture(t, r, ctx, `INSERT INTO issues(scan_id,violation_type,description,severity)
		VALUES($1,'second',repeat('z',6*1024*1024),'moderate')`, scanID)
	var count int
	var description string
	if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM issues WHERE scan_id=$1`, scanID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if err := tx.QueryRow(ctx, `SELECT description FROM issues WHERE scan_id=$1`, scanID).Scan(&description); err != nil {
		t.Fatal(err)
	}
	if count != 1 || description != "Original" {
		t.Fatalf("admitted snapshot changed: count=%d description=%q", count, description)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := r.GetScanIssues(ctx, scanID); !errors.Is(err, ErrScanIssuesTooLarge) {
		t.Fatalf("new read did not see oversized committed row: %v", err)
	}

	// Counts alone also reject a response whose stored text is tiny.
	execMCPFixture(t, r, ctx, `DELETE FROM issues WHERE scan_id=$1`, scanID)
	execMCPFixture(t, r, ctx, `INSERT INTO issues(scan_id,violation_type,description,severity)
		SELECT $1,'rule-' || n,'D','minor' FROM generate_series(1,513) n`, scanID)
	if _, err := r.GetScanIssues(ctx, scanID); !errors.Is(err, ErrScanIssuesTooLarge) {
		t.Fatalf("oversized issue count: %v", err)
	}
	page, total, err := r.ListScanIssuesPage(ctx, scanID, 50, 500)
	if err != nil || total != 513 || len(page) != 13 {
		t.Fatalf("large scan page: total=%d rows=%d error=%v", total, len(page), err)
	}
	for i := 1; i < len(page); i++ {
		if strings.Compare(page[i-1].ID, page[i].ID) >= 0 {
			t.Fatal("paged issue ordering is unstable")
		}
	}
}

func TestScanIssuePagedOwnershipAndCountsSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	const scanID = "c1111111-1111-4111-8111-111111111111"
	const otherScanID = "c9999999-9999-4999-8999-999999999999"
	const urlID = "c2222222-2222-4222-8222-222222222222"
	const issueID = "c3333333-3333-4333-8333-333333333333"
	execMCPFixture(t, r, ctx, `INSERT INTO scans(id,sitemap_url,status) VALUES($1,'https://fixture.test','completed'),($2,'https://other.test','completed')`, scanID, otherScanID)
	execMCPFixture(t, r, ctx, `INSERT INTO urls(id,scan_id,url,status) VALUES($1,$2,'https://user:secret@fixture.test/page','completed')`, urlID, scanID)
	execMCPFixture(t, r, ctx, `INSERT INTO issues(id,scan_id,violation_type,description,severity)
		VALUES($1,$2,'image-alt','Missing alt','serious')`, issueID, scanID)
	execMCPFixture(t, r, ctx, `INSERT INTO issue_occurrences(issue_id,url_id,html_snippet)
		SELECT $1,$2,'<img>' FROM generate_series(1,3)`, issueID, urlID)
	issue, occurrences, total, err := r.GetScanIssueOccurrencePage(ctx, scanID, issueID, 2, 0)
	if err != nil || issue == nil || total != 3 || len(occurrences) != 2 {
		t.Fatalf("first occurrence page: issue=%v total=%d rows=%d error=%v", issue, total, len(occurrences), err)
	}
	lastIssue, last, total, err := r.GetScanIssueOccurrencePage(ctx, scanID, issueID, 2, 2)
	if err != nil || lastIssue == nil || total != 3 || len(last) != 1 || occurrences[1].ID >= last[0].ID {
		t.Fatalf("last occurrence page: issue=%v total=%d rows=%d error=%v", lastIssue, total, len(last), err)
	}
	missing, _, _, err := r.GetScanIssueOccurrencePage(ctx, otherScanID, issueID, 1, 0)
	if err != nil || missing != nil {
		t.Fatalf("cross-scan issue escaped ownership: issue=%v error=%v", missing, err)
	}
	if _, _, err := r.ListScanIssuesPage(context.Background(), scanID, 51, 0); err == nil {
		t.Fatal("invalid group limit accepted")
	}
}

func TestLegacyOccurrenceCountAdmissionSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	const scanID = "d1111111-1111-4111-8111-111111111111"
	const urlID = "d2222222-2222-4222-8222-222222222222"
	const issueID = "d3333333-3333-4333-8333-333333333333"
	execMCPFixture(t, r, ctx, `INSERT INTO scans(id,sitemap_url,status) VALUES($1,'https://fixture.test','completed')`, scanID)
	execMCPFixture(t, r, ctx, `INSERT INTO urls(id,scan_id,url,status) VALUES($1,$2,'https://fixture.test/page','completed')`, urlID, scanID)
	execMCPFixture(t, r, ctx, `INSERT INTO issues(id,scan_id,violation_type,description,severity)
		VALUES($1,$2,'image-alt','Missing alt','serious')`, issueID, scanID)
	execMCPFixture(t, r, ctx, `INSERT INTO issue_occurrences(issue_id,url_id)
		SELECT $1,$2 FROM generate_series(1,33000)`, issueID, urlID)
	if _, err := r.GetScanIssues(ctx, scanID); !errors.Is(err, ErrScanIssuesTooLarge) {
		t.Fatalf("oversized occurrence count: %v", err)
	}
	issue, page, total, err := r.GetScanIssueOccurrencePage(ctx, scanID, issueID, 2, 32998)
	if err != nil || issue == nil || len(page) != 2 || total != 33000 {
		t.Fatalf("large occurrence count remains paged: issue=%v rows=%d total=%d error=%v", issue, len(page), total, err)
	}
}
