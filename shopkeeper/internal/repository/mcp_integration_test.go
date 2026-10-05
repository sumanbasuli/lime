package repository

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// These SQL regressions are opt-in and use a unique schema with real migrations.
// Supply an explicitly disposable PostgreSQL database, never application data:
// LIME_TEST_DATABASE_URL=postgres://... go test ./internal/repository -v
func mcpTestRepository(t *testing.T) (*Repository, context.Context) {
	t.Helper()
	databaseURL := os.Getenv("LIME_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set LIME_TEST_DATABASE_URL to a disposable PostgreSQL database for SQL regressions")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	t.Cleanup(cancel)
	admin, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	var suffix [8]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		t.Fatal(err)
	}
	schema := "mcp_test_" + hex.EncodeToString(suffix[:])
	quotedSchema := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+quotedSchema); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := admin.Exec(cleanupCtx, "DROP SCHEMA "+quotedSchema+" CASCADE"); err != nil {
			t.Errorf("failed to remove isolated test schema: %v", err)
		}
		admin.Close()
	})
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	migrations, err := filepath.Glob("../../migrations/*.up.sql")
	if err != nil || len(migrations) == 0 {
		t.Fatalf("cannot locate real SQL migrations: %v", err)
	}
	for _, path := range migrations {
		migration, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, string(migration)); err != nil {
			t.Fatalf("migration %s failed: %v", filepath.Base(path), err)
		}
	}
	return New(pool), ctx
}

const mcpScanID = "11111111-1111-4111-8111-111111111111"
const mcpOtherScanID = "99999999-9999-4999-8999-999999999999"
const mcpURLID = "22222222-2222-4222-8222-222222222222"

func execMCPFixture(t *testing.T, r *Repository, ctx context.Context, sql string, args ...any) {
	t.Helper()
	if _, err := r.pool.Exec(ctx, sql, args...); err != nil {
		t.Fatal(err)
	}
}

func TestMCPIssuePaginationAndUnboundedDetailSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	execMCPFixture(t, r, ctx, `INSERT INTO scans (id, sitemap_url, status, created_at)
		VALUES ($1, 'https://fixture.test/a', 'completed', '2026-01-01'),
		       ($2, 'https://fixture.test/b', 'completed', '2026-01-01')`, mcpScanID, mcpOtherScanID)
	execMCPFixture(t, r, ctx, `INSERT INTO urls (id, scan_id, url, status)
		VALUES ($1, $2, 'https://fixture.test/page', 'completed')`, mcpURLID, mcpScanID)
	execMCPFixture(t, r, ctx, `INSERT INTO issues (id, scan_id, violation_type, description, severity)
		SELECT md5(n::text)::uuid, $1, 'rule-' || n, 'Same title', 'serious'
		FROM generate_series(1, 1005) n`, mcpScanID)
	groups, total, err := r.GetMCPIssueSummaries(ctx, mcpScanID, 5, 1000)
	if err != nil || total != 1005 || len(groups) != 5 {
		t.Fatalf("last page = %d/%d (%v)", len(groups), total, err)
	}
	// Equal counts and titles must have a deterministic final key tie-breaker.
	for i := 1; i < len(groups); i++ {
		if groups[i-1].Key >= groups[i].Key {
			t.Fatal("equal-title groups have unstable ordering")
		}
	}
	last := groups[len(groups)-1]
	detail, err := r.GetMCPIssueDetail(ctx, mcpScanID, "failed", last.Key, 25, 0)
	if err != nil || detail == nil || detail.Summary.Key != last.Key {
		t.Fatalf("group beyond original 1,000-group ceiling is inaccessible: %v / %v", detail, err)
	}
	upperCaseDetail, err := r.GetMCPIssueDetail(ctx, mcpScanID, "failed", strings.ToUpper(last.Key), 25, 0)
	if err != nil || upperCaseDetail == nil || upperCaseDetail.Summary.Key != last.Key {
		t.Fatalf("uppercase UUID key should address the same group: %v / %v", upperCaseDetail, err)
	}
	groups, total, err = r.GetMCPIssueSummaries(ctx, mcpScanID, 5, 2000)
	if err != nil || len(groups) != 0 || total != 1005 {
		t.Fatalf("past-end page lost total: %d/%d (%v)", len(groups), total, err)
	}
	detail, err = r.GetMCPIssueDetail(ctx, mcpOtherScanID, "failed", last.Key, 25, 0)
	if err != nil || detail != nil {
		t.Fatalf("cross-scan detail escaped ownership: %v / %v", detail, err)
	}
	execMCPFixture(t, r, ctx, `INSERT INTO issue_occurrences (id, issue_id, url_id, html_snippet,
		screenshot_path, element_screenshot_path, created_at)
		SELECT md5('occurrence-' || n)::uuid, $1, $2, '<img>',
		       '/app/screenshots/' || $3::text || '/page.png',
		       '/app/screenshots/' || $3::text || '/element.png', '2026-01-01'
		FROM generate_series(1, 3) n`, last.Key, mcpURLID, mcpScanID)
	first, err := r.GetMCPIssueDetail(ctx, mcpScanID, "failed", last.Key, 2, 0)
	if err != nil || first == nil || len(first.Occurrences) != 2 || !first.HasMore {
		t.Fatalf("first occurrence page = %v / %v", first, err)
	}
	for _, occurrence := range first.Occurrences {
		if occurrence.ScreenshotURL == nil || *occurrence.ScreenshotURL != "/api/screenshots/"+mcpScanID+"/page.png" ||
			occurrence.ElementScreenshotURL == nil || *occurrence.ElementScreenshotURL != "/api/screenshots/"+mcpScanID+"/element.png" ||
			occurrence.ScreenshotPath == nil || *occurrence.ScreenshotPath != "/app/screenshots/"+mcpScanID+"/page.png" {
			t.Fatalf("MCP failed detail must expose public URLs while preserving stored paths: %v", occurrence)
		}
	}
	second, err := r.GetMCPIssueDetail(ctx, mcpScanID, "failed", last.Key, 2, 2)
	if err != nil || second == nil || len(second.Occurrences) != 1 || second.HasMore {
		t.Fatalf("last occurrence page = %v / %v", second, err)
	}
	if first.Occurrences[0].ID >= first.Occurrences[1].ID || first.Occurrences[1].ID >= second.Occurrences[0].ID {
		t.Fatal("equal-URL/equal-timestamp occurrence pages are not stable")
	}
	execMCPFixture(t, r, ctx, `INSERT INTO url_audits (url_id, rule_id, outcome)
		VALUES ($1, 'review-rule', 'incomplete'), ($1, 'rule-1', 'incomplete'),
		       ($1, 'legacy-audit-only', 'incomplete')`, mcpURLID)
	execMCPFixture(t, r, ctx, `INSERT INTO url_audit_occurrences (url_id, rule_id, outcome, html_snippet)
		VALUES ($1, 'review-rule', 'incomplete', '<a>')`, mcpURLID)
	review, err := r.GetMCPIssueDetail(ctx, mcpScanID, "needs_review", "review-rule", 25, 0)
	if err != nil || review == nil || review.Summary.OccurrenceCount != 1 || len(review.Occurrences) != 1 || review.Occurrences[0].RuleID != "review-rule" {
		t.Fatalf("needs-review detail = %v / %v", review, err)
	}
	if review.Occurrences[0].ScreenshotURL != nil || review.Occurrences[0].ElementScreenshotURL != nil {
		t.Fatal("review occurrence without stored screenshots must not invent public URLs")
	}
	suppressed, err := r.GetMCPIssueDetail(ctx, mcpScanID, "needs_review", "rule-1", 25, 0)
	if err != nil || suppressed != nil {
		t.Fatalf("failed rule should not appear again as needs-review: %v / %v", suppressed, err)
	}
	legacy, err := r.GetMCPIssueDetail(ctx, mcpScanID, "needs_review", "legacy-audit-only", 25, 0)
	if err != nil || legacy == nil || legacy.Summary.OccurrenceCount != 1 || len(legacy.Occurrences) != 0 || legacy.HasMore {
		t.Fatalf("audit-only legacy group must not advertise unreachable occurrence pages: %v / %v", legacy, err)
	}
	scans, err := r.ListMCPScans(ctx, 2, 0)
	if err != nil || len(scans) != 2 || scans[0].ID != mcpOtherScanID {
		t.Fatalf("equal-timestamp scan ordering = %v / %v", scans, err)
	}
}

func TestMCPScoreCacheFreshnessSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	execMCPFixture(t, r, ctx, `INSERT INTO scans (id, sitemap_url, status, updated_at)
		VALUES ($1, 'https://fixture.test/score', 'completed', '2026-01-01 00:00:00.123456')`, mcpScanID)
	assertScore := func(wantPresent bool) {
		t.Helper()
		score, err := r.GetMCPScanScoreSummary(ctx, mcpScanID)
		if err != nil || (score != nil) != wantPresent {
			t.Fatalf("score presence wanted %v: %v / %v", wantPresent, score, err)
		}
		if score != nil && (score.Score == nil || *score.Score != 85) {
			t.Fatalf("unexpected cached score: %v", score)
		}
	}
	assertScore(false)
	execMCPFixture(t, r, ctx, `INSERT INTO scan_score_summary_cache (
		scan_id, scan_updated_at, scan_status, score, has_score, has_audit_data,
		completed_url_count, failed_url_count, total_url_count, has_full_coverage, is_partial_scan,
		passed_count, failed_count, not_applicable_count, needs_review_count, excluded_count,
		weighted_passed, weighted_failed, weighted_total, scored_audit_count)
		SELECT id, date_trunc('milliseconds', updated_at), status, 85, true, true,
		       1, 0, 1, true, false, 85, 15, 0, 0, 0, 85, 15, 100, 100
		FROM scans WHERE id = $1`, mcpScanID)
	assertScore(true) // Timestamp truncated by TS Date is a valid matching snapshot.
	execMCPFixture(t, r, ctx, `UPDATE scan_score_summary_cache SET scan_updated_at = scan_updated_at - INTERVAL '1 second'`)
	assertScore(false)
	execMCPFixture(t, r, ctx, `UPDATE scan_score_summary_cache SET scan_updated_at = '2026-01-01 00:00:00.123', scan_status = 'failed'`)
	assertScore(false)
	execMCPFixture(t, r, ctx, `UPDATE scan_score_summary_cache SET scan_status = 'completed', updated_at = NOW() - INTERVAL '120 seconds'`)
	assertScore(false)
	execMCPFixture(t, r, ctx, `UPDATE app_settings SET summary_cache_ttl_seconds = 300 WHERE key = 'global'`)
	assertScore(true) // Configured TTL, not a hard-coded lifetime.
	execMCPFixture(t, r, ctx, `UPDATE scan_score_summary_cache SET score = NULL, has_score = false`)
	noScore, err := r.GetMCPScanScoreSummary(ctx, mcpScanID)
	if err != nil || noScore == nil || noScore.Score != nil || noScore.HasScore {
		t.Fatalf("fresh snapshot with no score must not invent a zero score: %v / %v", noScore, err)
	}
	execMCPFixture(t, r, ctx, `UPDATE scan_score_summary_cache SET score = 85, has_score = true`)
	execMCPFixture(t, r, ctx, `UPDATE scans SET updated_at = updated_at + INTERVAL '1 second' WHERE id = $1`, mcpScanID)
	assertScore(false)
	execMCPFixture(t, r, ctx, `DELETE FROM scans WHERE id = $1`, mcpScanID)
	assertScore(false)
}

func TestMCPReadsCancelBlockedSQLAndRecoverPool(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	lock, err := r.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Rollback(context.Background())
	// Block reads using only the isolated migrated test schema, forcing context
	// cancellation to interrupt actual PostgreSQL queries rather than a stub.
	if _, err := lock.Exec(ctx, `LOCK TABLE scans, issues, app_settings IN ACCESS EXCLUSIVE MODE`); err != nil {
		t.Fatal(err)
	}
	reads := []struct {
		name string
		read func(context.Context) error
	}{
		{"scan", func(ctx context.Context) error { _, err := r.GetScan(ctx, mcpScanID); return err }},
		{"score", func(ctx context.Context) error { _, err := r.GetMCPScanScoreSummary(ctx, mcpScanID); return err }},
		{"issue list", func(ctx context.Context) error {
			_, _, err := r.GetMCPIssueSummaries(ctx, mcpScanID, 20, 0)
			return err
		}},
		{"issue detail", func(ctx context.Context) error {
			_, err := r.GetMCPIssueDetail(ctx, mcpScanID, "needs_review", "label", 25, 0)
			return err
		}},
		{"auth settings", func(ctx context.Context) error { _, err := r.GetMCPAuthSettings(ctx); return err }},
		{"visible settings", func(ctx context.Context) error { _, err := r.GetMCPVisibleSettings(ctx); return err }},
	}
	for _, read := range reads {
		t.Run(read.name, func(t *testing.T) {
			deadline, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
			defer cancel()
			if err := read.read(deadline); !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("blocked read must honor its deadline: %v", err)
			}
		})
	}
	if err := lock.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if err := r.pool.Ping(ctx); err != nil {
		t.Fatalf("pool did not recover after canceled reads: %v", err)
	}
	settings, err := r.GetMCPVisibleSettings(ctx)
	if err != nil || settings == nil {
		t.Fatalf("subsequent read should succeed after locks are released: %v / %v", settings, err)
	}
}
