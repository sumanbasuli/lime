package repository

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
)

// ErrScanIssuesTooLarge means the selected issue response was rejected before
// fetching any issue or occurrence row into the API process.
var ErrScanIssuesTooLarge = errors.New("scan issues response is too large")

const (
	maxLegacyIssueEstimate = 32 << 20
	maxIssuePageEstimate   = 8 << 20
	issueACTAllowance      = 64 << 10
	issueRowAllowance      = 512
	occurrenceRowAllowance = 1024
)

// JSON may turn one stored byte into a six-byte escape. The issue allowance
// covers ACT metadata, UUIDs, timestamps, JSON field names, and Go structs;
// ACT expansion is also checked against this allowance before encoding.
func issueResponseFits(issueCount, occurrenceCount, textBytes, maxBytes int64) bool {
	if issueCount < 0 || occurrenceCount < 0 || textBytes < 0 || maxBytes < 0 {
		return false
	}
	issueCost := int64(issueACTAllowance + issueRowAllowance)
	return issueCount <= maxBytes/issueCost &&
		occurrenceCount <= (maxBytes-issueCount*issueCost)/occurrenceRowAllowance &&
		textBytes <= (maxBytes-issueCount*issueCost-occurrenceCount*occurrenceRowAllowance)/6
}

func (r *Repository) beginIssueRead(ctx context.Context) (pgx.Tx, error) {
	return r.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
}

const issueTextBytesSQL = `octet_length(i.violation_type)::bigint +
	octet_length(i.description)::bigint +
	COALESCE(octet_length(i.help_url), 0)::bigint +
	octet_length(i.severity::text)::bigint`

const occurrenceTextBytesSQL = `COALESCE(octet_length(io.html_snippet), 0)::bigint +
	COALESCE(octet_length(io.screenshot_path), 0)::bigint +
	COALESCE(octet_length(io.element_screenshot_path), 0)::bigint +
	COALESCE(octet_length(io.css_selector), 0)::bigint +
	octet_length(u.url)::bigint`

// admitLegacyScanIssues runs only scalar aggregates. Both this query and the
// subsequent row fetch use the same repeatable-read snapshot.
func admitLegacyScanIssues(ctx context.Context, tx pgx.Tx, scanID string) error {
	var issueCount, occurrenceCount, issueBytes, occurrenceBytes int64
	err := tx.QueryRow(ctx, `SELECT
		(SELECT COUNT(*) FROM issues i WHERE i.scan_id=$1),
		(SELECT COALESCE(SUM(`+issueTextBytesSQL+`),0) FROM issues i WHERE i.scan_id=$1),
		(SELECT COUNT(*) FROM issue_occurrences io JOIN issues i ON i.id=io.issue_id WHERE i.scan_id=$1),
		(SELECT COALESCE(SUM(`+occurrenceTextBytesSQL+`),0)
		 FROM issue_occurrences io JOIN issues i ON i.id=io.issue_id
		 JOIN urls u ON u.id=io.url_id WHERE i.scan_id=$1)`, scanID,
	).Scan(&issueCount, &issueBytes, &occurrenceCount, &occurrenceBytes)
	if err != nil {
		return fmt.Errorf("failed to measure scan issues: %w", err)
	}
	if !issueResponseFits(issueCount, occurrenceCount, issueBytes+occurrenceBytes, maxLegacyIssueEstimate) {
		return ErrScanIssuesTooLarge
	}
	return nil
}

// ListScanIssuesPage returns only failed issue groups. It uses the legacy Issue
// fields and order, with ID as a deterministic tie-breaker for pagination.
func (r *Repository) ListScanIssuesPage(ctx context.Context, scanID string, limit, offset int) ([]models.Issue, int64, error) {
	if limit < 1 || limit > 50 || offset < 0 || offset > 1_000_000 {
		return nil, 0, fmt.Errorf("invalid issue page limit or offset")
	}
	tx, err := r.beginIssueRead(ctx)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to begin issue page read: %w", err)
	}
	defer tx.Rollback(ctx)

	var total, pageCount, pageBytes int64
	// Materialize only page IDs. Aggregate stored TEXT lengths after LIMIT so
	// preflight does not build a page of full evidence-bearing tuples.
	err = tx.QueryRow(ctx, `WITH page_ids AS MATERIALIZED (
		SELECT i.id
		FROM issues i WHERE i.scan_id=$1
		ORDER BY CASE i.severity WHEN 'critical' THEN 1 WHEN 'serious' THEN 2
		 WHEN 'moderate' THEN 3 WHEN 'minor' THEN 4 END, i.id
		LIMIT $2 OFFSET $3
	)
	SELECT (SELECT COUNT(*) FROM issues WHERE scan_id=$1), COUNT(*),
		COALESCE(SUM(`+issueTextBytesSQL+`),0)
	FROM page_ids selected JOIN issues i ON i.id=selected.id`, scanID, limit, offset,
	).Scan(&total, &pageCount, &pageBytes)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to measure issue page: %w", err)
	}
	if !issueResponseFits(pageCount, 0, pageBytes, maxIssuePageEstimate) {
		return nil, 0, ErrScanIssuesTooLarge
	}

	rows, err := tx.Query(ctx, `SELECT i.id, i.scan_id, i.violation_type, i.description,
		i.help_url, i.severity, i.is_false_positive, i.created_at,
		(SELECT COUNT(*) FROM issue_occurrences io WHERE io.issue_id=i.id) AS occurrence_count
		FROM issues i WHERE i.scan_id=$1
		ORDER BY CASE i.severity WHEN 'critical' THEN 1 WHEN 'serious' THEN 2
		 WHEN 'moderate' THEN 3 WHEN 'minor' THEN 4 END, i.id
		LIMIT $2 OFFSET $3`, scanID, limit, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to get issue page: %w", err)
	}
	issues, err := readScanIssueRows(rows)
	if err != nil {
		return nil, 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, 0, fmt.Errorf("failed to finish issue page read: %w", err)
	}
	if issues == nil {
		issues = []models.Issue{}
	}
	return issues, total, nil
}

// GetScanIssueOccurrencePage returns one scan-owned failed issue and a bounded
// occurrence page. The preflight measures selected stored TEXT before fetching.
func (r *Repository) GetScanIssueOccurrencePage(ctx context.Context, scanID, issueID string, limit, offset int) (*models.Issue, []models.IssueOccurrence, int64, error) {
	if limit < 1 || limit > 100 || offset < 0 || offset > 1_000_000 {
		return nil, nil, 0, fmt.Errorf("invalid occurrence page limit or offset")
	}
	tx, err := r.beginIssueRead(ctx)
	if err != nil {
		return nil, nil, 0, fmt.Errorf("failed to begin occurrence page read: %w", err)
	}
	defer tx.Rollback(ctx)

	var issueCount, issueBytes, total, pageCount, pageBytes int64
	// Keep the CTEs to IDs only; the scalar aggregate measures the selected
	// rows before the separate full-row fetch in this same read snapshot.
	err = tx.QueryRow(ctx, `WITH selected_issue AS MATERIALIZED (
		SELECT i.id
		FROM issues i WHERE i.scan_id=$1 AND i.id=$2
	), page_ids AS MATERIALIZED (
		SELECT io.id
		FROM issue_occurrences io JOIN urls u ON u.id=io.url_id
		WHERE io.issue_id=$2 AND EXISTS (SELECT 1 FROM selected_issue)
		ORDER BY u.url, io.created_at, io.id LIMIT $3 OFFSET $4
	)
	SELECT (SELECT COUNT(*) FROM selected_issue),
		(SELECT COALESCE(SUM(`+issueTextBytesSQL+`),0)
		 FROM selected_issue selected JOIN issues i ON i.id=selected.id),
		(SELECT COUNT(*) FROM issue_occurrences io
		 WHERE io.issue_id=$2 AND EXISTS (SELECT 1 FROM selected_issue)),
		(SELECT COUNT(*) FROM page_ids),
		(SELECT COALESCE(SUM(`+occurrenceTextBytesSQL+`),0)
		 FROM page_ids selected JOIN issue_occurrences io ON io.id=selected.id
		 JOIN urls u ON u.id=io.url_id)`,
		scanID, issueID, limit, offset,
	).Scan(&issueCount, &issueBytes, &total, &pageCount, &pageBytes)
	if err != nil {
		return nil, nil, 0, fmt.Errorf("failed to measure occurrence page: %w", err)
	}
	if issueCount == 0 {
		return nil, nil, 0, nil
	}
	if !issueResponseFits(issueCount, pageCount, issueBytes+pageBytes, maxIssuePageEstimate) {
		return nil, nil, 0, ErrScanIssuesTooLarge
	}

	issue, err := issueRow(tx.QueryRow(ctx, `SELECT `+issueColumns+` FROM issues WHERE scan_id=$1 AND id=$2`, scanID, issueID))
	if err != nil {
		return nil, nil, 0, fmt.Errorf("failed to get issue for occurrence page: %w", err)
	}
	issue.OccurrenceCount = int(total)
	rows, err := tx.Query(ctx, `SELECT io.id, io.issue_id, io.url_id, io.html_snippet, io.screenshot_path,
		io.element_screenshot_path, io.css_selector, io.created_at, u.url
		FROM issue_occurrences io JOIN urls u ON u.id=io.url_id
		WHERE io.issue_id=$1
		ORDER BY u.url, io.created_at, io.id LIMIT $2 OFFSET $3`, issueID, limit, offset)
	if err != nil {
		return nil, nil, 0, fmt.Errorf("failed to get occurrence page: %w", err)
	}
	occurrences, err := readIssueOccurrenceRows(rows)
	if err != nil {
		return nil, nil, 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, nil, 0, fmt.Errorf("failed to finish occurrence page read: %w", err)
	}
	if occurrences == nil {
		occurrences = []models.IssueOccurrence{}
	}
	return issue, occurrences, total, nil
}
