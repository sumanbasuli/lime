package repository

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
	"github.com/sumanbasuli/lime/shopkeeper/internal/viewport"
)

// Repository provides database operations for the Shopkeeper API.
type Repository struct {
	pool *pgxpool.Pool
}

// New creates a new Repository wrapping the given connection pool.
func New(pool *pgxpool.Pool) *Repository {
	return &Repository{pool: pool}
}

// scanColumns is the SELECT column list for scans (used in all scan queries).
const scanColumns = `id, sitemap_url, status, pause_requested, scan_type, tag, viewport_preset, viewport_width, viewport_height, total_urls, scanned_urls, created_at, updated_at`

// issueColumns is the SELECT column list for issues (used in single-issue queries).
const issueColumns = `id, scan_id, violation_type, description, help_url, severity, is_false_positive, created_at`

// scanRow scans a row into a Scan struct. Must match scanColumns order.
func scanRow(row interface{ Scan(dest ...any) error }) (*models.Scan, error) {
	scan := &models.Scan{}
	err := row.Scan(
		&scan.ID, &scan.SitemapURL, &scan.Status, &scan.PauseRequested, &scan.ScanType, &scan.Tag,
		&scan.ViewportPreset, &scan.ViewportWidth, &scan.ViewportHeight,
		&scan.TotalURLs, &scan.ScannedURLs, &scan.CreatedAt, &scan.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	return scan, nil
}

// issueRow scans a row into an Issue struct. Must match issueColumns order.
func issueRow(row interface{ Scan(dest ...any) error }) (*models.Issue, error) {
	issue := &models.Issue{}
	err := row.Scan(
		&issue.ID, &issue.ScanID, &issue.ViolationType, &issue.Description, &issue.HelpURL,
		&issue.Severity, &issue.IsFalsePositive, &issue.CreatedAt,
	)
	if err != nil {
		return nil, err
	}
	return issue, nil
}

// CreateScan inserts a new scan record and returns it.
func (r *Repository) CreateScan(ctx context.Context, sitemapURL, scanType string, tag *string, scanViewport viewport.Settings) (*models.Scan, error) {
	scan := &models.Scan{}
	err := r.pool.QueryRow(ctx,
		`INSERT INTO scans (sitemap_url, status, scan_type, tag, viewport_preset, viewport_width, viewport_height)
		 VALUES ($1, 'pending', $2, $3, $4, $5, $6)
		 RETURNING `+scanColumns,
		sitemapURL, scanType, tag, scanViewport.Preset, scanViewport.Width, scanViewport.Height,
	).Scan(&scan.ID, &scan.SitemapURL, &scan.Status, &scan.PauseRequested, &scan.ScanType, &scan.Tag,
		&scan.ViewportPreset, &scan.ViewportWidth, &scan.ViewportHeight,
		&scan.TotalURLs, &scan.ScannedURLs, &scan.CreatedAt, &scan.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("failed to create scan: %w", err)
	}
	return scan, nil
}

// GetScan retrieves a single scan by its ID.
func (r *Repository) GetScan(ctx context.Context, id string) (*models.Scan, error) {
	row := r.pool.QueryRow(ctx,
		`SELECT `+scanColumns+` FROM scans WHERE id = $1`, id,
	)
	scan, err := scanRow(row)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("failed to get scan: %w", err)
	}
	return scan, nil
}

// DeleteScan removes a scan and all related rows via ON DELETE CASCADE.
// It returns true when a scan record was deleted.
func (r *Repository) DeleteScan(ctx context.Context, id string) (bool, error) {
	result, err := r.pool.Exec(ctx, `DELETE FROM scans WHERE id = $1`, id)
	if err != nil {
		return false, fmt.Errorf("failed to delete scan: %w", err)
	}
	return result.RowsAffected() > 0, nil
}

// ListRecoverableScans returns all scans that were left in a non-terminal state.
func (r *Repository) ListRecoverableScans(ctx context.Context) ([]models.Scan, error) {
	rows, err := r.pool.Query(ctx,
		`SELECT `+scanColumns+`
		 FROM scans
		 WHERE status IN ('pending', 'profiling', 'scanning', 'processing')
		 ORDER BY created_at ASC`,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to list recoverable scans: %w", err)
	}
	defer rows.Close()

	var scans []models.Scan
	for rows.Next() {
		var s models.Scan
		if err := rows.Scan(&s.ID, &s.SitemapURL, &s.Status, &s.PauseRequested, &s.ScanType, &s.Tag,
			&s.ViewportPreset, &s.ViewportWidth, &s.ViewportHeight,
			&s.TotalURLs, &s.ScannedURLs, &s.CreatedAt, &s.UpdatedAt); err != nil {
			return nil, fmt.Errorf("failed to scan recoverable scan row: %w", err)
		}
		scans = append(scans, s)
	}
	if scans == nil {
		scans = []models.Scan{}
	}
	return scans, nil
}

// ResetScan clears all derived data for a scan and resets its progress.
// This is used to recover interrupted non-terminal scans after a backend restart.
func (r *Repository) ResetScan(ctx context.Context, id string) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("failed to begin reset transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `DELETE FROM issues WHERE scan_id = $1`, id); err != nil {
		return fmt.Errorf("failed to delete scan issues: %w", err)
	}

	if _, err := tx.Exec(ctx, `DELETE FROM urls WHERE scan_id = $1`, id); err != nil {
		return fmt.Errorf("failed to delete scan URLs: %w", err)
	}

	if _, err := tx.Exec(ctx,
		`UPDATE scans
		 SET status = 'pending', pause_requested = false, total_urls = 0, scanned_urls = 0, updated_at = NOW()
		 WHERE id = $1`,
		id,
	); err != nil {
		return fmt.Errorf("failed to reset scan state: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("failed to commit reset transaction: %w", err)
	}

	return nil
}

// ListScans returns all scans ordered by creation date descending.
func (r *Repository) ListScans(ctx context.Context) ([]models.Scan, error) {
	rows, err := r.pool.Query(ctx,
		`SELECT `+scanColumns+` FROM scans ORDER BY created_at DESC`,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to list scans: %w", err)
	}
	defer rows.Close()

	var scans []models.Scan
	for rows.Next() {
		var s models.Scan
		if err := rows.Scan(&s.ID, &s.SitemapURL, &s.Status, &s.PauseRequested, &s.ScanType, &s.Tag,
			&s.ViewportPreset, &s.ViewportWidth, &s.ViewportHeight,
			&s.TotalURLs, &s.ScannedURLs, &s.CreatedAt, &s.UpdatedAt); err != nil {
			return nil, fmt.Errorf("failed to scan row: %w", err)
		}
		scans = append(scans, s)
	}
	if scans == nil {
		scans = []models.Scan{}
	}
	return scans, nil
}

// ListScansByTag returns scans matching the given tag, ordered by creation date descending.
func (r *Repository) ListScansByTag(ctx context.Context, tag string) ([]models.Scan, error) {
	rows, err := r.pool.Query(ctx,
		`SELECT `+scanColumns+` FROM scans WHERE tag = $1 ORDER BY created_at DESC`,
		tag,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to list scans by tag: %w", err)
	}
	defer rows.Close()

	var scans []models.Scan
	for rows.Next() {
		var s models.Scan
		if err := rows.Scan(&s.ID, &s.SitemapURL, &s.Status, &s.PauseRequested, &s.ScanType, &s.Tag,
			&s.ViewportPreset, &s.ViewportWidth, &s.ViewportHeight,
			&s.TotalURLs, &s.ScannedURLs, &s.CreatedAt, &s.UpdatedAt); err != nil {
			return nil, fmt.Errorf("failed to scan row: %w", err)
		}
		scans = append(scans, s)
	}
	if scans == nil {
		scans = []models.Scan{}
	}
	return scans, nil
}

// UpdateScanStatus updates the status of a scan.
func (r *Repository) UpdateScanStatus(ctx context.Context, id string, status string) error {
	_, err := r.pool.Exec(ctx,
		`UPDATE scans
		 SET status = $1::scan_status,
		     pause_requested = CASE
		         WHEN $1::text IN ('completed', 'failed', 'paused') THEN false
		         ELSE pause_requested
		     END,
		     updated_at = NOW()
		 WHERE id = $2`,
		status, id,
	)
	if err != nil {
		return fmt.Errorf("failed to update scan status: %w", err)
	}
	return nil
}

// RequestPause marks an active scan so the running scanner can stop at the next safe point.
func (r *Repository) RequestPause(ctx context.Context, id string) (*models.Scan, error) {
	row := r.pool.QueryRow(ctx,
		`UPDATE scans
		 SET pause_requested = true, updated_at = NOW()
		 WHERE id = $1
		   AND status IN ('pending', 'profiling', 'scanning', 'processing')
		   AND pause_requested = false
		 RETURNING `+scanColumns,
		id,
	)
	scan, err := scanRow(row)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("failed to request scan pause: %w", err)
	}
	return scan, nil
}

// ResumeScan reactivates a paused scan so it can continue from persisted state.
func (r *Repository) ResumeScan(ctx context.Context, id string) (*models.Scan, error) {
	row := r.pool.QueryRow(ctx,
		`UPDATE scans
		 SET status = 'pending', pause_requested = false, updated_at = NOW()
		 WHERE id = $1
		   AND status = 'paused'
		 RETURNING `+scanColumns,
		id,
	)
	scan, err := scanRow(row)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("failed to resume scan: %w", err)
	}
	return scan, nil
}

// RetryFailedURLs requeues failed URLs on a completed partial scan and reopens the
// existing scan record so the scanner can resume only those pages.
func (r *Repository) RetryFailedURLs(ctx context.Context, id string) (*models.Scan, int, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to begin retry-failed transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	row := tx.QueryRow(ctx,
		`SELECT `+scanColumns+`
		 FROM scans
		 WHERE id = $1
		 FOR UPDATE`,
		id,
	)
	scan, err := scanRow(row)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, 0, nil
		}
		return nil, 0, fmt.Errorf("failed to lock scan: %w", err)
	}

	if scan.Status != "completed" {
		return scan, 0, nil
	}

	var completedURLs int
	var failedURLs int
	if err := tx.QueryRow(ctx,
		`SELECT
		    COUNT(*) FILTER (WHERE status = 'completed'),
		    COUNT(*) FILTER (WHERE status = 'failed')
		 FROM urls
		 WHERE scan_id = $1`,
		id,
	).Scan(&completedURLs, &failedURLs); err != nil {
		return nil, 0, fmt.Errorf("failed to count URL statuses: %w", err)
	}

	if completedURLs == 0 || failedURLs == 0 {
		return scan, 0, nil
	}

	result, err := tx.Exec(ctx,
		`UPDATE urls
		 SET status = 'pending'
		 WHERE scan_id = $1
		   AND status = 'failed'`,
		id,
	)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to requeue failed URLs: %w", err)
	}

	row = tx.QueryRow(ctx,
		`UPDATE scans
		 SET status = 'pending',
		     pause_requested = false,
		     scanned_urls = $2,
		     updated_at = NOW()
		 WHERE id = $1
		 RETURNING `+scanColumns,
		id, completedURLs,
	)
	updatedScan, err := scanRow(row)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to reopen scan: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, 0, fmt.Errorf("failed to commit retry-failed transaction: %w", err)
	}

	return updatedScan, int(result.RowsAffected()), nil
}

// FinalizePausedScan marks a scan as paused and clears any pending pause request.
func (r *Repository) FinalizePausedScan(ctx context.Context, id string) error {
	_, err := r.pool.Exec(ctx,
		`UPDATE scans
		 SET status = 'paused', pause_requested = false, updated_at = NOW()
		 WHERE id = $1`,
		id,
	)
	if err != nil {
		return fmt.Errorf("failed to finalize paused scan: %w", err)
	}
	return nil
}

// UpdateScanProgress updates the scanned URL count and total URL count.
func (r *Repository) UpdateScanProgress(ctx context.Context, id string, scannedURLs, totalURLs int) error {
	_, err := r.pool.Exec(ctx,
		`UPDATE scans SET scanned_urls = $1, total_urls = $2, updated_at = NOW() WHERE id = $3`,
		scannedURLs, totalURLs, id,
	)
	if err != nil {
		return fmt.Errorf("failed to update scan progress: %w", err)
	}
	return nil
}

// BulkInsertURLs inserts multiple URLs for a scan and returns the created records.
func (r *Repository) BulkInsertURLs(ctx context.Context, scanID string, urls []string) ([]models.URL, error) {
	if len(urls) == 0 {
		return []models.URL{}, nil
	}

	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	var result []models.URL
	for _, u := range urls {
		var urlRecord models.URL
		err := tx.QueryRow(ctx,
			`INSERT INTO urls (scan_id, url, status) VALUES ($1, $2, 'pending')
			 RETURNING id, scan_id, url, status, created_at`,
			scanID, u,
		).Scan(&urlRecord.ID, &urlRecord.ScanID, &urlRecord.URL, &urlRecord.Status, &urlRecord.CreatedAt)
		if err != nil {
			return nil, fmt.Errorf("failed to insert URL %s: %w", u, err)
		}
		result = append(result, urlRecord)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("failed to commit transaction: %w", err)
	}
	return result, nil
}

// UpdateURLStatus updates the status of a URL record.
func (r *Repository) UpdateURLStatus(ctx context.Context, urlID string, status string) error {
	_, err := r.pool.Exec(ctx,
		`UPDATE urls SET status = $1 WHERE id = $2`,
		status, urlID,
	)
	if err != nil {
		return fmt.Errorf("failed to update URL status: %w", err)
	}
	return nil
}

// GetInheritedFalsePositiveStates returns the latest false-positive state for the
// given rules from prior terminal scans with the same target and viewport.
func (r *Repository) GetInheritedFalsePositiveStates(ctx context.Context, scanID string, violationTypes []string) (map[string]bool, error) {
	if len(violationTypes) == 0 {
		return map[string]bool{}, nil
	}

	rows, err := r.pool.Query(ctx,
		`SELECT DISTINCT ON (i.violation_type)
		    i.violation_type,
		    i.is_false_positive
		 FROM scans current_scan
		 JOIN scans previous_scan
		   ON previous_scan.sitemap_url = current_scan.sitemap_url
		  AND previous_scan.scan_type = current_scan.scan_type
		  AND previous_scan.viewport_preset = current_scan.viewport_preset
		  AND previous_scan.viewport_width = current_scan.viewport_width
		  AND previous_scan.viewport_height = current_scan.viewport_height
		 JOIN issues i ON i.scan_id = previous_scan.id
		 WHERE current_scan.id = $1
		   AND previous_scan.id <> current_scan.id
		   AND previous_scan.status IN ('completed', 'paused', 'failed')
		   AND i.violation_type = ANY($2)
		 ORDER BY i.violation_type, previous_scan.created_at DESC, previous_scan.id DESC`,
		scanID, violationTypes,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to get inherited false-positive states: %w", err)
	}
	defer rows.Close()

	states := make(map[string]bool)
	for rows.Next() {
		var violationType string
		var isFalsePositive bool
		if err := rows.Scan(&violationType, &isFalsePositive); err != nil {
			return nil, fmt.Errorf("failed to scan inherited false-positive state: %w", err)
		}

		states[violationType] = isFalsePositive
	}

	return states, nil
}

// GetScanIssueMap returns existing issue IDs for a scan keyed by violation type.
func (r *Repository) GetScanIssueMap(ctx context.Context, scanID string) (map[string]string, error) {
	rows, err := r.pool.Query(ctx,
		`SELECT DISTINCT ON (violation_type) violation_type, id
		 FROM issues
		 WHERE scan_id = $1
		 ORDER BY violation_type, created_at ASC, id ASC`,
		scanID,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to get scan issue map: %w", err)
	}
	defer rows.Close()

	issueMap := make(map[string]string)
	for rows.Next() {
		var violationType string
		var issueID string
		if err := rows.Scan(&violationType, &issueID); err != nil {
			return nil, fmt.Errorf("failed to scan issue map row: %w", err)
		}

		issueMap[violationType] = issueID
	}

	return issueMap, nil
}

// CreateIssue inserts a new issue record and returns it.
func (r *Repository) CreateIssue(ctx context.Context, scanID, violationType, description, severity string, helpURL *string, isFalsePositive bool) (*models.Issue, error) {
	row := r.pool.QueryRow(ctx,
		`INSERT INTO issues (scan_id, violation_type, description, severity, help_url, is_false_positive)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 RETURNING `+issueColumns,
		scanID, violationType, description, severity, helpURL, isFalsePositive,
	)
	issue, err := issueRow(row)
	if err != nil {
		return nil, fmt.Errorf("failed to create issue: %w", err)
	}
	return issue, nil
}

// SetIssueFalsePositive updates the false-positive flag for an issue in the given scan.
func (r *Repository) SetIssueFalsePositive(ctx context.Context, scanID, issueID string, isFalsePositive bool) (*models.Issue, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to begin false-positive transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	row := tx.QueryRow(ctx,
		`UPDATE issues
		 SET is_false_positive = $1
		 WHERE id = $2 AND scan_id = $3
		 RETURNING `+issueColumns,
		isFalsePositive, issueID, scanID,
	)

	issue, err := issueRow(row)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("failed to update false-positive state: %w", err)
	}

	if _, err := tx.Exec(ctx, `UPDATE scans SET updated_at = NOW() WHERE id = $1`, scanID); err != nil {
		return nil, fmt.Errorf("failed to touch scan after false-positive update: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("failed to commit false-positive transaction: %w", err)
	}

	return issue, nil
}

// CreateIssueOccurrence inserts a new issue occurrence record.
func (r *Repository) CreateIssueOccurrence(ctx context.Context, issueID, urlID string, htmlSnippet, screenshotPath, elementScreenshotPath, cssSelector *string) error {
	_, err := r.pool.Exec(ctx,
		`INSERT INTO issue_occurrences (issue_id, url_id, html_snippet, screenshot_path, element_screenshot_path, css_selector)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		issueID, urlID, htmlSnippet, screenshotPath, elementScreenshotPath, cssSelector,
	)
	if err != nil {
		return fmt.Errorf("failed to create issue occurrence: %w", err)
	}
	return nil
}

// CreateURLAudits inserts one audit outcome per page/rule pair.
func (r *Repository) CreateURLAudits(ctx context.Context, audits []models.URLAudit) error {
	if len(audits) == 0 {
		return nil
	}

	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("failed to begin URL audit transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	for _, audit := range audits {
		if _, err := tx.Exec(ctx,
			`INSERT INTO url_audits (url_id, rule_id, outcome)
			 VALUES ($1, $2, $3)
			 ON CONFLICT (url_id, rule_id)
			 DO UPDATE SET outcome = EXCLUDED.outcome`,
			audit.URLID, audit.RuleID, audit.Outcome,
		); err != nil {
			return fmt.Errorf("failed to insert URL audit %s for URL %s: %w", audit.RuleID, audit.URLID, err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("failed to commit URL audit transaction: %w", err)
	}

	return nil
}

// CreateURLAuditOccurrences inserts node-level context for automated audit outcomes.
func (r *Repository) CreateURLAuditOccurrences(ctx context.Context, occurrences []models.URLAuditOccurrence) error {
	if len(occurrences) == 0 {
		return nil
	}

	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("failed to begin URL audit occurrence transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	for _, occurrence := range occurrences {
		if _, err := tx.Exec(ctx,
			`INSERT INTO url_audit_occurrences (url_id, rule_id, outcome, html_snippet, screenshot_path, element_screenshot_path, css_selector)
			 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			occurrence.URLID,
			occurrence.RuleID,
			occurrence.Outcome,
			occurrence.HTMLSnippet,
			occurrence.ScreenshotPath,
			occurrence.ElementScreenshotPath,
			occurrence.CSSSelector,
		); err != nil {
			return fmt.Errorf(
				"failed to insert URL audit occurrence %s for URL %s: %w",
				occurrence.RuleID,
				occurrence.URLID,
				err,
			)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("failed to commit URL audit occurrence transaction: %w", err)
	}

	return nil
}

// GetScanIssues retrieves all issues for a scan, each with its occurrences.
func (r *Repository) GetScanIssues(ctx context.Context, scanID string) ([]models.IssueWithOccurrences, error) {
	// First, get all issues for this scan
	issueRows, err := r.pool.Query(ctx,
		`SELECT i.id, i.scan_id, i.violation_type, i.description, i.help_url, i.severity, i.is_false_positive, i.created_at,
		        COUNT(io.id) as occurrence_count
		 FROM issues i
		 LEFT JOIN issue_occurrences io ON io.issue_id = i.id
		 WHERE i.scan_id = $1
		 GROUP BY i.id
		 ORDER BY
		   CASE i.severity
		     WHEN 'critical' THEN 1
		     WHEN 'serious' THEN 2
		     WHEN 'moderate' THEN 3
		     WHEN 'minor' THEN 4
		   END`,
		scanID,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to get scan issues: %w", err)
	}
	defer issueRows.Close()

	var issues []models.Issue
	for issueRows.Next() {
		var i models.Issue
		if err := issueRows.Scan(&i.ID, &i.ScanID, &i.ViolationType, &i.Description, &i.HelpURL, &i.Severity, &i.IsFalsePositive, &i.CreatedAt, &i.OccurrenceCount); err != nil {
			return nil, fmt.Errorf("failed to scan issue row: %w", err)
		}
		issues = append(issues, i)
	}

	// For each issue, get its occurrences
	var result []models.IssueWithOccurrences
	for _, issue := range issues {
		occRows, err := r.pool.Query(ctx,
			`SELECT io.id, io.issue_id, io.url_id, io.html_snippet, io.screenshot_path,
			        io.element_screenshot_path, io.css_selector, io.created_at, u.url
			 FROM issue_occurrences io
			 JOIN urls u ON u.id = io.url_id
			 WHERE io.issue_id = $1
			 ORDER BY u.url`,
			issue.ID,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to get occurrences for issue %s: %w", issue.ID, err)
		}

		var occurrences []models.IssueOccurrence
		for occRows.Next() {
			var o models.IssueOccurrence
			if err := occRows.Scan(&o.ID, &o.IssueID, &o.URLID, &o.HTMLSnippet, &o.ScreenshotPath,
				&o.ElementScreenshotPath, &o.CSSSelector, &o.CreatedAt, &o.PageURL); err != nil {
				occRows.Close()
				return nil, fmt.Errorf("failed to scan occurrence row: %w", err)
			}
			occurrences = append(occurrences, o)
		}
		occRows.Close()

		if occurrences == nil {
			occurrences = []models.IssueOccurrence{}
		}

		result = append(result, models.IssueWithOccurrences{
			Issue:       issue,
			Occurrences: occurrences,
		})
	}

	if result == nil {
		result = []models.IssueWithOccurrences{}
	}
	return result, nil
}

// GetStats returns aggregate statistics for the dashboard.
func (r *Repository) GetStats(ctx context.Context) (*models.Stats, error) {
	stats := &models.Stats{}

	err := r.pool.QueryRow(ctx,
		`SELECT
		   (SELECT COUNT(*) FROM scans) AS total_scans,
		   (SELECT COUNT(*) FROM issues) AS total_issues,
		   (SELECT COALESCE(SUM(scanned_urls), 0) FROM scans) AS total_pages`,
	).Scan(&stats.TotalScans, &stats.TotalIssues, &stats.TotalPages)
	if err != nil {
		return nil, fmt.Errorf("failed to get stats: %w", err)
	}
	return stats, nil
}

// GetMCPAuthSettings returns the current MCP enablement and key hash.
func (r *Repository) GetMCPAuthSettings(ctx context.Context) (*models.MCPAuthSettings, error) {
	settings := &models.MCPAuthSettings{}
	err := r.pool.QueryRow(ctx,
		`SELECT mcp_enabled, mcp_key_hash, mcp_sessions_revoked_at
		 FROM app_settings
		 WHERE key = 'global'`,
	).Scan(&settings.Enabled, &settings.KeyHash, &settings.RevokedAt)
	if err != nil {
		if err == pgx.ErrNoRows {
			return &models.MCPAuthSettings{}, nil
		}
		return nil, fmt.Errorf("failed to get MCP settings: %w", err)
	}
	return settings, nil
}

// GetMCPScanScoreSummary returns the cached score summary for a scan when one exists.
func (r *Repository) GetMCPScanScoreSummary(ctx context.Context, scanID string) (*models.MCPScanScoreSummary, error) {
	var summary models.MCPScanScoreSummary
	var score int
	var scorePresent bool
	var updatedAt time.Time

	err := r.pool.QueryRow(ctx,
		`SELECT
		   COALESCE(score, 0),
		   score IS NOT NULL,
		   has_score,
		   has_audit_data,
		   completed_url_count,
		   failed_url_count,
		   total_url_count,
		   has_full_coverage,
		   is_partial_scan,
		   passed_count,
		   failed_count,
		   not_applicable_count,
		   needs_review_count,
		   excluded_count,
		   weighted_passed,
		   weighted_failed,
		   weighted_total,
		   scored_audit_count,
		   updated_at
		 FROM scan_score_summary_cache
		 WHERE scan_id = $1`,
		scanID,
	).Scan(
		&score,
		&scorePresent,
		&summary.HasScore,
		&summary.HasAuditData,
		&summary.CompletedURLCount,
		&summary.FailedURLCount,
		&summary.TotalURLCount,
		&summary.HasFullCoverage,
		&summary.IsPartialScan,
		&summary.PassedCount,
		&summary.FailedCount,
		&summary.NotApplicableCount,
		&summary.NeedsReviewCount,
		&summary.ExcludedCount,
		&summary.WeightedPassed,
		&summary.WeightedFailed,
		&summary.WeightedTotal,
		&summary.ScoredAuditCount,
		&updatedAt,
	)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("failed to get MCP scan score summary: %w", err)
	}

	if scorePresent {
		summary.Score = &score
	}
	summary.UpdatedAt = updatedAt.UTC().Format(time.RFC3339)
	return &summary, nil
}

// GetMCPVisibleSettings returns non-sensitive reporting, performance, and MCP settings.
func (r *Repository) GetMCPVisibleSettings(ctx context.Context) (*models.MCPVisibleSettings, error) {
	var fullPDFOccurrenceLimit int
	var singleIssuePDFOccurrenceLimit int
	var smallCSVOccurrenceLimit int
	var llmOccurrenceLimit int
	var pdfReportsEnabled bool
	var csvReportsEnabled bool
	var llmReportsEnabled bool
	var summaryCacheTTLSeconds int
	var reportDataCacheTTLSeconds int
	var reportGenerationConcurrency int
	var mcpEnabled bool
	var mcpConfigured bool
	var mcpKeyHint sql.NullString
	var mcpKeyGeneratedAt sql.NullTime

	err := r.pool.QueryRow(ctx,
		`SELECT
		   full_pdf_occurrence_limit,
		   single_issue_pdf_occurrence_limit,
		   small_csv_occurrence_limit,
		   llm_occurrence_limit,
		   pdf_reports_enabled,
		   csv_reports_enabled,
		   llm_reports_enabled,
		   summary_cache_ttl_seconds,
		   report_data_cache_ttl_seconds,
		   report_generation_concurrency,
		   mcp_enabled,
		   mcp_key_hash IS NOT NULL,
		   mcp_key_hint,
		   mcp_key_generated_at
		 FROM app_settings
		 WHERE key = 'global'`,
	).Scan(
		&fullPDFOccurrenceLimit,
		&singleIssuePDFOccurrenceLimit,
		&smallCSVOccurrenceLimit,
		&llmOccurrenceLimit,
		&pdfReportsEnabled,
		&csvReportsEnabled,
		&llmReportsEnabled,
		&summaryCacheTTLSeconds,
		&reportDataCacheTTLSeconds,
		&reportGenerationConcurrency,
		&mcpEnabled,
		&mcpConfigured,
		&mcpKeyHint,
		&mcpKeyGeneratedAt,
	)
	if err != nil {
		if err == pgx.ErrNoRows {
			return defaultMCPVisibleSettings(), nil
		}
		return nil, fmt.Errorf("failed to get MCP visible settings: %w", err)
	}

	var keyHint any
	if mcpKeyHint.Valid {
		keyHint = mcpKeyHint.String
	}
	var keyGeneratedAt any
	if mcpKeyGeneratedAt.Valid {
		keyGeneratedAt = mcpKeyGeneratedAt.Time.UTC().Format(time.RFC3339)
	}

	return &models.MCPVisibleSettings{
		Reporting: map[string]any{
			"full_pdf_occurrence_limit":         fullPDFOccurrenceLimit,
			"single_issue_pdf_occurrence_limit": singleIssuePDFOccurrenceLimit,
			"small_csv_occurrence_limit":        smallCSVOccurrenceLimit,
			"llm_occurrence_limit":              llmOccurrenceLimit,
			"pdf_reports_enabled":               pdfReportsEnabled,
			"csv_reports_enabled":               csvReportsEnabled,
			"llm_reports_enabled":               llmReportsEnabled,
		},
		Performance: map[string]any{
			"summary_cache_ttl_seconds":       summaryCacheTTLSeconds,
			"report_data_cache_ttl_seconds":   reportDataCacheTTLSeconds,
			"report_generation_concurrency":   reportGenerationConcurrency,
			"cache_storage":                   "postgres",
			"report_generation_limiter_scope": "ui_process",
		},
		Integrations: map[string]any{
			"mcp_enabled":          mcpEnabled,
			"mcp_configured":       mcpConfigured,
			"mcp_key_hint":         keyHint,
			"mcp_key_generated_at": keyGeneratedAt,
			"mcp_mode":             "read_only",
		},
	}, nil
}

func defaultMCPVisibleSettings() *models.MCPVisibleSettings {
	return &models.MCPVisibleSettings{
		Reporting: map[string]any{
			"full_pdf_occurrence_limit":         30,
			"single_issue_pdf_occurrence_limit": 2000,
			"small_csv_occurrence_limit":        5,
			"llm_occurrence_limit":              3,
			"pdf_reports_enabled":               true,
			"csv_reports_enabled":               true,
			"llm_reports_enabled":               true,
		},
		Performance: map[string]any{
			"summary_cache_ttl_seconds":       60,
			"report_data_cache_ttl_seconds":   300,
			"report_generation_concurrency":   1,
			"cache_storage":                   "postgres",
			"report_generation_limiter_scope": "ui_process",
		},
		Integrations: map[string]any{
			"mcp_enabled":          false,
			"mcp_configured":       false,
			"mcp_key_hint":         nil,
			"mcp_key_generated_at": nil,
			"mcp_mode":             "read_only",
		},
	}
}

// ListMCPScans returns a bounded list of scans for MCP clients.
func (r *Repository) ListMCPScans(ctx context.Context, limit, offset int) ([]models.Scan, error) {
	rows, err := r.pool.Query(ctx,
		`SELECT `+scanColumns+`
		 FROM scans
		 ORDER BY created_at DESC
		 LIMIT $1 OFFSET $2`,
		limit,
		offset,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to list MCP scans: %w", err)
	}
	defer rows.Close()

	var scans []models.Scan
	for rows.Next() {
		var s models.Scan
		if err := rows.Scan(&s.ID, &s.SitemapURL, &s.Status, &s.PauseRequested, &s.ScanType, &s.Tag,
			&s.ViewportPreset, &s.ViewportWidth, &s.ViewportHeight,
			&s.TotalURLs, &s.ScannedURLs, &s.CreatedAt, &s.UpdatedAt); err != nil {
			return nil, fmt.Errorf("failed to scan MCP scan row: %w", err)
		}
		scans = append(scans, s)
	}
	if scans == nil {
		scans = []models.Scan{}
	}
	return scans, nil
}

// GetMCPIssueSummaries returns failed and needs-review issue groups without loading occurrences.
func (r *Repository) GetMCPIssueSummaries(ctx context.Context, scanID string, limit, offset int) ([]models.MCPIssueSummary, int, error) {
	rows, err := r.pool.Query(ctx,
		`WITH failed AS (
		   SELECT
		     'failed' AS kind,
		     i.id::text AS key,
		     i.id AS issue_id,
		     i.violation_type AS rule_id,
		     i.description AS title,
		     i.help_url,
		     i.severity::text AS severity,
		     i.is_false_positive,
		     COUNT(io.id)::int AS occurrence_count
		   FROM issues i
		   LEFT JOIN issue_occurrences io ON io.issue_id = i.id
		   WHERE i.scan_id = $1
		   GROUP BY i.id
		 ),
		 incomplete_audits AS (
		   SELECT ua.rule_id, COUNT(*)::int AS audit_count
		   FROM url_audits ua
		   JOIN urls u ON u.id = ua.url_id
		   WHERE u.scan_id = $1
		     AND u.status = 'completed'
		     AND ua.outcome = 'incomplete'
		   GROUP BY ua.rule_id
		 ),
		 incomplete_occurrences AS (
		   SELECT uao.rule_id, COUNT(*)::int AS occurrence_count
		   FROM url_audit_occurrences uao
		   JOIN urls u ON u.id = uao.url_id
		   WHERE u.scan_id = $1
		     AND u.status = 'completed'
		     AND uao.outcome = 'incomplete'
		   GROUP BY uao.rule_id
		 ),
		 needs_review AS (
		   SELECT
		     'needs_review' AS kind,
		     COALESCE(io.rule_id, ia.rule_id) AS key,
		     NULL::uuid AS issue_id,
		     COALESCE(io.rule_id, ia.rule_id) AS rule_id,
		     COALESCE(io.rule_id, ia.rule_id) AS title,
		     NULL::text AS help_url,
		     NULL::text AS severity,
		     false AS is_false_positive,
		     COALESCE(io.occurrence_count, ia.audit_count, 0)::int AS occurrence_count
		   FROM incomplete_audits ia
		   FULL OUTER JOIN incomplete_occurrences io ON io.rule_id = ia.rule_id
		   WHERE NOT EXISTS (
		     SELECT 1
		     FROM issues i
		     WHERE i.scan_id = $1
		       AND i.violation_type = COALESCE(io.rule_id, ia.rule_id)
		   )
		 ),
		 combined AS (
		   SELECT * FROM failed
		   UNION ALL
		   SELECT * FROM needs_review
		 )
		 SELECT *, COUNT(*) OVER()::int AS total_count
		 FROM combined
		 ORDER BY
		   CASE
		     WHEN kind = 'failed' AND is_false_positive = false THEN 0
		     WHEN kind = 'needs_review' THEN 1
		     ELSE 2
		   END,
		   occurrence_count DESC,
		   title ASC
		 LIMIT $2 OFFSET $3`,
		scanID,
		limit,
		offset,
	)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to get MCP issue summaries: %w", err)
	}
	defer rows.Close()

	var summaries []models.MCPIssueSummary
	total := 0
	for rows.Next() {
		var summary models.MCPIssueSummary
		var totalCount int
		if err := rows.Scan(
			&summary.Kind,
			&summary.Key,
			&summary.IssueID,
			&summary.RuleID,
			&summary.Title,
			&summary.HelpURL,
			&summary.Severity,
			&summary.IsFalsePositive,
			&summary.OccurrenceCount,
			&totalCount,
		); err != nil {
			return nil, 0, fmt.Errorf("failed to scan MCP issue summary row: %w", err)
		}
		total = totalCount
		summaries = append(summaries, summary)
	}
	if summaries == nil {
		summaries = []models.MCPIssueSummary{}
	}
	return summaries, total, nil
}

// GetMCPIssueDetail returns a paginated issue detail for MCP clients.
func (r *Repository) GetMCPIssueDetail(ctx context.Context, scanID, kind, key string, limit, offset int) (*models.MCPIssueDetail, error) {
	summaries, _, err := r.GetMCPIssueSummaries(ctx, scanID, 1000, 0)
	if err != nil {
		return nil, err
	}

	var summary *models.MCPIssueSummary
	for _, candidate := range summaries {
		if candidate.Kind == kind && candidate.Key == key {
			copy := candidate
			summary = &copy
			break
		}
	}
	if summary == nil {
		return nil, nil
	}

	var occurrences []models.IssueOccurrence
	if kind == "failed" {
		rows, err := r.pool.Query(ctx,
			`SELECT io.id, io.issue_id, io.url_id, io.html_snippet, io.screenshot_path,
			        io.element_screenshot_path, io.css_selector, io.created_at, u.url
			 FROM issue_occurrences io
			 JOIN urls u ON u.id = io.url_id
			 WHERE io.issue_id = $1
			 ORDER BY u.url, io.created_at
			 LIMIT $2 OFFSET $3`,
			key,
			limit,
			offset,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to get MCP failed issue occurrences: %w", err)
		}
		defer rows.Close()

		for rows.Next() {
			var occurrence models.IssueOccurrence
			if err := rows.Scan(&occurrence.ID, &occurrence.IssueID, &occurrence.URLID, &occurrence.HTMLSnippet, &occurrence.ScreenshotPath,
				&occurrence.ElementScreenshotPath, &occurrence.CSSSelector, &occurrence.CreatedAt, &occurrence.PageURL); err != nil {
				return nil, fmt.Errorf("failed to scan MCP failed occurrence row: %w", err)
			}
			occurrences = append(occurrences, occurrence)
		}
	} else {
		rows, err := r.pool.Query(ctx,
			`SELECT uao.id, uao.url_id, uao.html_snippet, uao.screenshot_path,
			        uao.element_screenshot_path, uao.css_selector, uao.created_at, u.url
			 FROM url_audit_occurrences uao
			 JOIN urls u ON u.id = uao.url_id
			 WHERE u.scan_id = $1
			   AND u.status = 'completed'
			   AND uao.rule_id = $2
			   AND uao.outcome = 'incomplete'
			 ORDER BY u.url, uao.created_at
			 LIMIT $3 OFFSET $4`,
			scanID,
			key,
			limit,
			offset,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to get MCP needs-review occurrences: %w", err)
		}
		defer rows.Close()

		for rows.Next() {
			var occurrence models.IssueOccurrence
			if err := rows.Scan(&occurrence.ID, &occurrence.URLID, &occurrence.HTMLSnippet, &occurrence.ScreenshotPath,
				&occurrence.ElementScreenshotPath, &occurrence.CSSSelector, &occurrence.CreatedAt, &occurrence.PageURL); err != nil {
				return nil, fmt.Errorf("failed to scan MCP needs-review occurrence row: %w", err)
			}
			occurrence.RuleID = key
			occurrences = append(occurrences, occurrence)
		}
	}
	if occurrences == nil {
		occurrences = []models.IssueOccurrence{}
	}

	return &models.MCPIssueDetail{
		Summary:          *summary,
		Occurrences:      occurrences,
		OccurrenceOffset: offset,
		OccurrenceLimit:  limit,
		HasMore:          offset+len(occurrences) < summary.OccurrenceCount,
	}, nil
}

// GetScanURLs returns all URL records for a scan.
func (r *Repository) GetScanURLs(ctx context.Context, scanID string) ([]models.URL, error) {
	rows, err := r.pool.Query(ctx,
		`SELECT id, scan_id, url, status, created_at FROM urls WHERE scan_id = $1 ORDER BY created_at`,
		scanID,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to get scan URLs: %w", err)
	}
	defer rows.Close()

	var urls []models.URL
	for rows.Next() {
		var u models.URL
		if err := rows.Scan(&u.ID, &u.ScanID, &u.URL, &u.Status, &u.CreatedAt); err != nil {
			return nil, fmt.Errorf("failed to scan URL row: %w", err)
		}
		urls = append(urls, u)
	}
	if urls == nil {
		urls = []models.URL{}
	}
	return urls, nil
}

// IncrementScannedURLs atomically increments the scanned_urls counter.
func (r *Repository) IncrementScannedURLs(ctx context.Context, scanID string) error {
	_, err := r.pool.Exec(ctx,
		`UPDATE scans SET scanned_urls = scanned_urls + 1, updated_at = NOW() WHERE id = $1`,
		scanID,
	)
	if err != nil {
		return fmt.Errorf("failed to increment scanned URLs: %w", err)
	}
	return nil
}
