package repository

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
)

var ErrMCPReadTooLarge = errors.New("selected MCP data exceeds its read budget")
var ErrMCPAuthBusy = errors.New("MCP authorization read capacity is busy")

var mcpAuthSlots = make(chan struct{}, 2)

const maxMCPReadEstimate int64 = 32 << 20
const mcpReadRowAllowance int64 = 4096

type mcpReadContextKey struct{}
type mcpRead struct {
	owner            *Repository
	tx               pgx.Tx
	remaining        int64
	rows             int64
	deadline         time.Time
	statementTimeout time.Duration
}

// BeginMCPRead isolates measurements and fetches from concurrent writers. The
// returned cleanup deadline keeps interrupted SQL charged until its server limit.
func (r *Repository) BeginMCPRead(ctx context.Context) (context.Context, func() time.Time, error) {
	if r.mcpRead(ctx) != nil {
		return ctx, func() time.Time { return time.Time{} }, nil
	}
	return r.beginMCPRead(ctx, pgx.RepeatableRead)
}

func (r *Repository) beginMCPRead(ctx context.Context, isolation pgx.TxIsoLevel) (context.Context, func() time.Time, error) {
	deadline := time.Now().Add(30 * time.Second)
	if earlier, ok := ctx.Deadline(); ok && earlier.Before(deadline) {
		deadline = earlier
	}
	readCtx, cancel := context.WithDeadline(ctx, deadline)
	if err := readCtx.Err(); err != nil {
		cancel()
		return ctx, func() time.Time { return time.Time{} }, err
	}
	read := &mcpRead{owner: r, remaining: maxMCPReadEstimate, deadline: deadline, statementTimeout: 30 * time.Second}
	tx, err := r.pool.BeginTx(readCtx, pgx.TxOptions{IsoLevel: isolation, AccessMode: pgx.ReadOnly})
	read.tx = tx
	finish := func() time.Time {
		interrupted := readCtx.Err() != nil
		if tx != nil {
			cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 3*time.Second)
			if err := tx.Rollback(cleanupCtx); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
				interrupted = true
			}
			cleanupCancel()
		}
		cancel()
		if interrupted {
			// PostgreSQL starts its relative timeout after receiving the query,
			// not when the client computed it. Allow the full last SQL interval.
			return time.Now().Add(read.statementTimeout)
		}
		return time.Time{}
	}
	if err != nil {
		return ctx, finish, err
	}
	if err := read.prepareQuery(readCtx); err != nil {
		return ctx, finish, err
	}
	return context.WithValue(readCtx, mcpReadContextKey{}, read), finish, nil
}

func (r *Repository) mcpRead(ctx context.Context) *mcpRead {
	read, _ := ctx.Value(mcpReadContextKey{}).(*mcpRead)
	if read != nil && read.owner == r {
		return read
	}
	return nil
}

type mcpQueryer interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

func (r *Repository) mcpQueryer(ctx context.Context) mcpQueryer {
	if read := r.mcpRead(ctx); read != nil {
		return read
	}
	return r.pool
}

func (read *mcpRead) prepareQuery(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if !time.Now().Before(read.deadline) {
		return context.DeadlineExceeded
	}
	milliseconds := max(int64(1), time.Until(read.deadline).Milliseconds())
	_, err := read.tx.Exec(ctx, `SELECT set_config('statement_timeout',$1,true)`, fmt.Sprintf("%dms", milliseconds))
	if err == nil {
		read.statementTimeout = time.Duration(milliseconds) * time.Millisecond
	}
	return mcpReadError(err)
}

type mcpErrorRow struct{ err error }

func (row mcpErrorRow) Scan(...any) error { return row.err }

func mcpReadError(err error) error {
	var sqlError *pgconn.PgError
	if errors.As(err, &sqlError) && sqlError.Code == "57014" {
		return errors.Join(context.DeadlineExceeded, err)
	}
	return err
}

type mcpReadRow struct{ pgx.Row }

func (row mcpReadRow) Scan(dest ...any) error { return mcpReadError(row.Row.Scan(dest...)) }

type mcpReadRows struct{ pgx.Rows }

func (rows mcpReadRows) Err() error { return mcpReadError(rows.Rows.Err()) }

func (read *mcpRead) QueryRow(ctx context.Context, query string, args ...any) pgx.Row {
	if err := read.prepareQuery(ctx); err != nil {
		return mcpErrorRow{err}
	}
	return mcpReadRow{read.tx.QueryRow(ctx, query, args...)}
}

func (read *mcpRead) Query(ctx context.Context, query string, args ...any) (pgx.Rows, error) {
	if err := read.prepareQuery(ctx); err != nil {
		return nil, err
	}
	rows, err := read.tx.Query(ctx, query, args...)
	if err != nil {
		return nil, mcpReadError(err)
	}
	return mcpReadRows{rows}, nil
}

// textBytes includes repeated fields and derived URL expansion. Fourteen covers
// both JSON copies (including Go HTML/control escaping); rows cover fixed fields.
func (read *mcpRead) measure(ctx context.Context, query string, args ...any) error {
	var rows, textBytes int64
	if err := read.QueryRow(ctx, query, args...).Scan(&rows, &textBytes); err != nil {
		return err
	}
	if rows < 0 || textBytes < 0 || rows > 16384-read.rows || rows > read.remaining/mcpReadRowAllowance {
		return ErrMCPReadTooLarge
	}
	remaining := read.remaining - rows*mcpReadRowAllowance
	if textBytes > remaining/14 {
		return ErrMCPReadTooLarge
	}
	read.remaining = remaining - textBytes*14
	read.rows += rows
	return nil
}

const mcpScanTextBytesSQL = `octet_length(sitemap_url)::bigint + octet_length(scan_type)::bigint +
	COALESCE(octet_length(tag),0)::bigint + octet_length(viewport_preset)::bigint + octet_length(status::text)::bigint`

func (read *mcpRead) getScan(ctx context.Context, id string) (*models.Scan, error) {
	if err := read.measure(ctx, `SELECT COUNT(*),COALESCE(SUM(`+mcpScanTextBytesSQL+`),0) FROM scans WHERE id=$1`, id); err != nil {
		return nil, err
	}
	scan, err := scanRow(read.QueryRow(ctx, `SELECT `+scanColumns+` FROM scans WHERE id=$1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return scan, err
}

// Existence/companion/report lookups do not need the scan's potentially large tag or target.
func (r *Repository) GetMCPScanReference(ctx context.Context, id string) (*models.Scan, error) {
	if read := r.mcpRead(ctx); read != nil {
		if err := read.measure(ctx, `SELECT COUNT(*),0::bigint FROM scans WHERE id=$1`, id); err != nil {
			return nil, err
		}
	}
	scan := &models.Scan{}
	err := r.mcpQueryer(ctx).QueryRow(ctx, `SELECT id,include_link_check FROM scans WHERE id=$1`, id).Scan(&scan.ID, &scan.IncludeLinkCheck)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return scan, err
}

func (r *Repository) GetMCPReportSettings(ctx context.Context) (*models.MCPVisibleSettings, error) {
	var pdf, csv, llm bool
	err := r.mcpQueryer(ctx).QueryRow(ctx, `SELECT pdf_reports_enabled,csv_reports_enabled,llm_reports_enabled FROM app_settings WHERE key='global'`).Scan(&pdf, &csv, &llm)
	if errors.Is(err, pgx.ErrNoRows) {
		return defaultMCPVisibleSettings(), nil
	}
	if err != nil {
		return nil, err
	}
	return &models.MCPVisibleSettings{Reporting: map[string]any{"pdf_reports_enabled": pdf, "csv_reports_enabled": csv, "llm_reports_enabled": llm}}, nil
}

// Hidden seeds are needed by workers and rechecks, never by MCP readers.
const mcpLinkCheckColumns = `id,scan_id,url,check_type,status,max_pages,pages_checked,pages_failed,links_checked,total_links,truncated,error,summary,'[]'::jsonb,created_at,updated_at,completed_at,root_public`
const mcpLinkCheckTextBytesSQL = `octet_length(url)::bigint + octet_length(check_type)::bigint + octet_length(status)::bigint +
	COALESCE(octet_length(error),0)::bigint + octet_length(summary::text)::bigint`

func (read *mcpRead) getLinkCheck(ctx context.Context, id string, byScan bool) (*models.LinkCheck, error) {
	column := "id"
	if byScan {
		column = "scan_id"
	}
	if err := read.measure(ctx, `SELECT COUNT(*),COALESCE(SUM(`+mcpLinkCheckTextBytesSQL+`),0) FROM link_checks WHERE `+column+`=$1`, id); err != nil {
		return nil, err
	}
	return linkCheckRow(read.QueryRow(ctx, `SELECT `+mcpLinkCheckColumns+` FROM link_checks WHERE `+column+`=$1`, id))
}

func (read *mcpRead) listLinkChecks(ctx context.Context, limit, offset int) ([]models.LinkCheck, int, error) {
	if limit < 1 || limit > 100 || offset < 0 || offset > 100000 {
		return nil, 0, fmt.Errorf("invalid MCP link page")
	}
	if err := read.measure(ctx, `WITH page_ids AS MATERIALIZED (
		SELECT id FROM link_checks ORDER BY created_at DESC,id DESC LIMIT $1 OFFSET $2)
		SELECT COUNT(*),COALESCE(SUM(`+mcpLinkCheckTextBytesSQL+`),0)
		FROM page_ids p JOIN link_checks j ON j.id=p.id`, limit, offset); err != nil {
		return nil, 0, err
	}
	var total int
	if err := read.QueryRow(ctx, `SELECT count(*) FROM link_checks`).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := read.Query(ctx, `SELECT `+mcpLinkCheckColumns+` FROM link_checks ORDER BY created_at DESC,id DESC LIMIT $1 OFFSET $2`, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	items := []models.LinkCheck{}
	for rows.Next() {
		job, err := linkCheckRow(rows)
		if err != nil {
			return nil, 0, err
		}
		items = append(items, *job)
	}
	return items, total, rows.Err()
}

func (read *mcpRead) measureLinkResults(ctx context.Context, id, status string, limit, offset int) error {
	if limit < 1 || limit > 100 || offset < 0 || offset > 100000 {
		return fmt.Errorf("invalid MCP result page")
	}
	return read.measure(ctx, `WITH page_ids AS MATERIALIZED (
		SELECT id FROM link_check_results WHERE link_check_id=$1 AND ($2='' OR status=$2)
		ORDER BY CASE status WHEN 'broken' THEN 0 WHEN 'error' THEN 1 WHEN 'blocked' THEN 2 WHEN 'unchecked' THEN 3 WHEN 'redirected' THEN 4 ELSE 5 END,target_url,id
		LIMIT $3 OFFSET $4)
		SELECT COUNT(*),COALESCE(SUM(octet_length(target_url)::bigint + octet_length(status)::bigint +
		COALESCE(octet_length(final_url),0)::bigint + octet_length(link_type)::bigint +
		COALESCE(octet_length(error),0)::bigint + COALESCE(octet_length(error_kind),0)::bigint +
		octet_length((`+linkSourceSliceSQL("0", "5")+`)::text)::bigint),0)
		FROM page_ids p JOIN link_check_results r ON r.id=p.id`, id, status, limit, offset)
}

const mcpIssueOrderSQL = ` ORDER BY CASE WHEN kind='failed' AND is_false_positive=false THEN 0 WHEN kind='needs_review' THEN 1 ELSE 2 END,
	occurrence_count DESC,title ASC,kind ASC,key ASC`
const mcpIssueSummaryTextBytesSQL = `octet_length(c.kind)::bigint + octet_length(c.key)::bigint + octet_length(c.rule_id)::bigint +
	octet_length(c.title)::bigint + COALESCE(octet_length(c.help_url),0)::bigint + COALESCE(octet_length(c.severity),0)::bigint`

func (read *mcpRead) measureIssueSummaries(ctx context.Context, scanID string, limit, offset int) error {
	return read.measure(ctx, mcpIssueSummariesCTE+`, page_keys AS MATERIALIZED (
		SELECT kind,key FROM combined`+mcpIssueOrderSQL+` LIMIT $2 OFFSET $3)
		SELECT COUNT(*),COALESCE(SUM(`+mcpIssueSummaryTextBytesSQL+`),0)
		FROM page_keys p JOIN combined c ON c.kind=p.kind AND c.key=p.key`, scanID, limit, offset)
}

func (read *mcpRead) measureIssueDetail(ctx context.Context, scanID, kind, key string, limit, offset int) error {
	return read.measure(ctx, mcpIssueSummariesCTE+` SELECT COUNT(*),COALESCE(SUM(`+mcpIssueSummaryTextBytesSQL+`),0)
		FROM combined c WHERE kind=$2 AND key=$3`, scanID, kind, key)
}

func (read *mcpRead) measureIssueOccurrences(ctx context.Context, scanID, kind, key string, limit, offset int) error {
	// Charge derived screenshot URLs at up to three times each stored basename,
	// in addition to the original paths already included in occurrenceTextBytesSQL.
	if kind == "failed" {
		return read.measure(ctx, `WITH page_ids AS MATERIALIZED (
			SELECT io.id FROM issue_occurrences io JOIN urls u ON u.id=io.url_id
			JOIN issues i ON i.id=io.issue_id WHERE i.scan_id=$1 AND i.id=$2
			ORDER BY u.url,io.created_at,io.id LIMIT $3 OFFSET $4)
			SELECT COUNT(*),COALESCE(SUM(`+occurrenceTextBytesSQL+` +
			3*COALESCE(octet_length(io.screenshot_path),0)::bigint + 3*COALESCE(octet_length(io.element_screenshot_path),0)::bigint),0)
			FROM page_ids p JOIN issue_occurrences io ON io.id=p.id JOIN urls u ON u.id=io.url_id`, scanID, key, limit, offset)
	}
	return read.measure(ctx, `WITH page_ids AS MATERIALIZED (
		SELECT uao.id FROM url_audit_occurrences uao JOIN urls u ON u.id=uao.url_id
		WHERE u.scan_id=$1 AND u.status='completed' AND uao.rule_id=$2 AND uao.outcome='incomplete'
		ORDER BY u.url,uao.created_at,uao.id LIMIT $3 OFFSET $4)
		SELECT COUNT(*),COALESCE(SUM(COALESCE(octet_length(uao.html_snippet),0)::bigint +
		4*COALESCE(octet_length(uao.screenshot_path),0)::bigint + 4*COALESCE(octet_length(uao.element_screenshot_path),0)::bigint +
		COALESCE(octet_length(uao.css_selector),0)::bigint + octet_length(u.url)::bigint + octet_length(uao.rule_id)::bigint),0)
		FROM page_ids p JOIN url_audit_occurrences uao ON uao.id=p.id JOIN urls u ON u.id=uao.url_id`, scanID, key, limit, offset)
}
