package repository

import (
	"context"
	"fmt"

	"github.com/campuspress/lime/shopkeeper/internal/models"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
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
const scanColumns = `id, sitemap_url, status, scan_type, tag, total_urls, scanned_urls, created_at, updated_at`

// scanRow scans a row into a Scan struct. Must match scanColumns order.
func scanRow(row interface{ Scan(dest ...any) error }) (*models.Scan, error) {
	scan := &models.Scan{}
	err := row.Scan(
		&scan.ID, &scan.SitemapURL, &scan.Status, &scan.ScanType, &scan.Tag,
		&scan.TotalURLs, &scan.ScannedURLs, &scan.CreatedAt, &scan.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	return scan, nil
}

// CreateScan inserts a new scan record and returns it.
func (r *Repository) CreateScan(ctx context.Context, sitemapURL, scanType string, tag *string) (*models.Scan, error) {
	scan := &models.Scan{}
	err := r.pool.QueryRow(ctx,
		`INSERT INTO scans (sitemap_url, status, scan_type, tag) VALUES ($1, 'pending', $2, $3)
		 RETURNING `+scanColumns,
		sitemapURL, scanType, tag,
	).Scan(&scan.ID, &scan.SitemapURL, &scan.Status, &scan.ScanType, &scan.Tag,
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
		if err := rows.Scan(&s.ID, &s.SitemapURL, &s.Status, &s.ScanType, &s.Tag,
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
		if err := rows.Scan(&s.ID, &s.SitemapURL, &s.Status, &s.ScanType, &s.Tag,
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
		`UPDATE scans SET status = $1, updated_at = NOW() WHERE id = $2`,
		status, id,
	)
	if err != nil {
		return fmt.Errorf("failed to update scan status: %w", err)
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

// CreateIssue inserts a new issue record and returns it.
func (r *Repository) CreateIssue(ctx context.Context, scanID, violationType, description, severity string, helpURL *string) (*models.Issue, error) {
	issue := &models.Issue{}
	err := r.pool.QueryRow(ctx,
		`INSERT INTO issues (scan_id, violation_type, description, severity, help_url)
		 VALUES ($1, $2, $3, $4, $5)
		 RETURNING id, scan_id, violation_type, description, help_url, severity, created_at`,
		scanID, violationType, description, severity, helpURL,
	).Scan(&issue.ID, &issue.ScanID, &issue.ViolationType, &issue.Description, &issue.HelpURL, &issue.Severity, &issue.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("failed to create issue: %w", err)
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

// GetScanIssues retrieves all issues for a scan, each with its occurrences.
func (r *Repository) GetScanIssues(ctx context.Context, scanID string) ([]models.IssueWithOccurrences, error) {
	// First, get all issues for this scan
	issueRows, err := r.pool.Query(ctx,
		`SELECT i.id, i.scan_id, i.violation_type, i.description, i.help_url, i.severity, i.created_at,
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
		if err := issueRows.Scan(&i.ID, &i.ScanID, &i.ViolationType, &i.Description, &i.HelpURL, &i.Severity, &i.CreatedAt, &i.OccurrenceCount); err != nil {
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
