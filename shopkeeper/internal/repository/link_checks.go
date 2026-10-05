package repository

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
	"github.com/sumanbasuli/lime/shopkeeper/internal/viewport"
)

const linkCheckColumns = `id,scan_id,url,check_type,status,max_pages,pages_checked,pages_failed,links_checked,total_links,truncated,error,summary,seed_urls,created_at,updated_at,completed_at`

func linkCheckRow(row interface{ Scan(...any) error }) (*models.LinkCheck, error) {
	j := &models.LinkCheck{}
	var summary, seeds []byte
	err := row.Scan(&j.ID, &j.ScanID, &j.URL, &j.CheckType, &j.Status, &j.MaxPages, &j.PagesChecked, &j.PagesFailed,
		&j.LinksChecked, &j.TotalLinks, &j.Truncated, &j.Error, &summary, &seeds, &j.CreatedAt, &j.UpdatedAt, &j.CompletedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if err = json.Unmarshal(summary, &j.Summary); err != nil {
		return nil, err
	}
	if err = json.Unmarshal(seeds, &j.SeedURLs); err != nil {
		return nil, err
	}
	return j, nil
}

// CreateScanWithLinkCheck creates both records atomically. Legacy callers retain
// CreateScan's default-off behavior and never modify the old scan pipeline.
func (r *Repository) CreateScanWithLinkCheck(ctx context.Context, target, scanType string, tag *string, v viewport.Settings) (*models.Scan, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	scan, err := scanRow(tx.QueryRow(ctx, `INSERT INTO scans (sitemap_url,status,scan_type,tag,viewport_preset,viewport_width,viewport_height,include_link_check)
		VALUES ($1,'pending',$2,$3,$4,$5,$6,true) RETURNING `+scanColumns, target, scanType, tag, v.Preset, v.Width, v.Height))
	if err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO link_checks(scan_id,url,check_type,max_pages) VALUES ($1,$2,'scan',500)`, scan.ID, target); err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return scan, nil
}

func (r *Repository) CreateLinkCheck(ctx context.Context, target, kind string, maxPages int, seeds []string) (*models.LinkCheck, error) {
	if seeds == nil {
		seeds = []string{}
	}
	encoded, err := json.Marshal(seeds)
	if err != nil {
		return nil, err
	}
	return linkCheckRow(r.pool.QueryRow(ctx, `INSERT INTO link_checks(url,check_type,max_pages,seed_urls) VALUES ($1,$2,$3,$4)
		RETURNING `+linkCheckColumns, target, kind, maxPages, encoded))
}

func (r *Repository) GetLinkCheck(ctx context.Context, id string) (*models.LinkCheck, error) {
	return linkCheckRow(r.pool.QueryRow(ctx, `SELECT `+linkCheckColumns+` FROM link_checks WHERE id=$1`, id))
}

func (r *Repository) GetScanLinkCheck(ctx context.Context, id string) (*models.LinkCheck, error) {
	return linkCheckRow(r.pool.QueryRow(ctx, `SELECT `+linkCheckColumns+` FROM link_checks WHERE scan_id=$1`, id))
}

func (r *Repository) ListLinkChecks(ctx context.Context, limit, offset int) ([]models.LinkCheck, int, error) {
	var total int
	if err := r.pool.QueryRow(ctx, `SELECT count(*) FROM link_checks`).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := r.pool.Query(ctx, `SELECT `+linkCheckColumns+` FROM link_checks ORDER BY created_at DESC,id DESC LIMIT $1 OFFSET $2`, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	items := []models.LinkCheck{}
	for rows.Next() {
		j, err := linkCheckRow(rows)
		if err != nil {
			return nil, 0, err
		}
		items = append(items, *j)
	}
	return items, total, rows.Err()
}

// Statistics include persisted partial results of failed/cancelled jobs, just
// like history. They never imply that active or truncated jobs have full coverage.
func (r *Repository) GetLinkCheckStats(ctx context.Context) (map[string]int64, error) {
	var checks, active, pages, links, broken, redirected, timeouts int64
	err := r.pool.QueryRow(ctx, `SELECT count(*),count(*) FILTER(WHERE status IN ('queued','running')),
		coalesce(sum(pages_checked),0),coalesce(sum(links_checked),0),
		coalesce(sum((summary->>'broken')::bigint),0),coalesce(sum((summary->>'redirected')::bigint),0),coalesce(sum((summary->>'timeout')::bigint),0)
		FROM link_checks`).Scan(&checks, &active, &pages, &links, &broken, &redirected, &timeouts)
	return map[string]int64{"total_checks": checks, "active_checks": active, "pages_checked": pages, "links_checked": links, "broken_links": broken, "redirected_links": redirected, "timeouts": timeouts}, err
}

func (r *Repository) RecoverLinkChecks(ctx context.Context) error {
	_, err := r.pool.Exec(ctx, `UPDATE link_checks SET status='queued',error=NULL,completed_at=NULL,updated_at=NOW() WHERE status='running'`)
	return err
}

// ReadyLinkCheckIDs excludes companions of paused/active scans. Failed parents
// get a visible failed companion, not a misleading successful empty result.
func (r *Repository) ReadyLinkCheckIDs(ctx context.Context) ([]string, error) {
	if _, err := r.pool.Exec(ctx, `UPDATE link_checks j SET status='failed',error='Accessibility scan failed before link checking could start',completed_at=NOW(),updated_at=NOW()
		FROM scans s WHERE j.scan_id=s.id AND j.status='queued' AND s.status='failed'`); err != nil {
		return nil, err
	}
	rows, err := r.pool.Query(ctx, `SELECT j.id FROM link_checks j LEFT JOIN scans s ON s.id=j.scan_id
		WHERE j.status='queued' AND (j.scan_id IS NULL OR s.status='completed') ORDER BY j.created_at,j.id LIMIT 2`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// ClaimLinkCheck is conditional and transactional, preventing duplicate worker
// execution and preserving cancellation that races with queued startup.
func (r *Repository) ClaimLinkCheck(ctx context.Context, id string) (*models.LinkCheck, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	j, err := linkCheckRow(tx.QueryRow(ctx, `SELECT `+linkCheckColumns+` FROM link_checks WHERE id=$1 AND status='queued'`, id))
	if err != nil || j == nil {
		return j, err
	}
	if j.ScanID != nil {
		var status string
		// Parent first, child second matches scan deletion/retry lock ordering.
		// This waits for concurrent retries before deciding the parent is ready.
		if err := tx.QueryRow(ctx, `SELECT status FROM scans WHERE id=$1 FOR SHARE`, *j.ScanID).Scan(&status); err != nil {
			if err == pgx.ErrNoRows {
				return nil, nil
			}
			return nil, err
		}
		if status != "completed" {
			return nil, nil
		}
	}
	j, err = linkCheckRow(tx.QueryRow(ctx, `SELECT `+linkCheckColumns+` FROM link_checks WHERE id=$1 AND status='queued' FOR UPDATE`, id))
	if err != nil || j == nil {
		return j, err
	}
	if j.ScanID != nil {
		// The extra seed is an overflow marker. It is never fetched, but keeps
		// truncation visible when a detached recheck reuses this bounded inventory.
		rows, err := tx.Query(ctx, `SELECT url FROM urls WHERE scan_id=$1 ORDER BY created_at,id LIMIT $2`, *j.ScanID, j.MaxPages+1)
		if err != nil {
			return nil, err
		}
		j.SeedURLs = []string{}
		for rows.Next() {
			var u string
			if err := rows.Scan(&u); err != nil {
				rows.Close()
				return nil, err
			}
			j.SeedURLs = append(j.SeedURLs, u)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
	}
	seeds, err := json.Marshal(j.SeedURLs)
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM link_check_results WHERE link_check_id=$1`, id); err != nil {
		return nil, err
	}
	j, err = linkCheckRow(tx.QueryRow(ctx, `UPDATE link_checks SET status='running',pages_checked=0,pages_failed=0,links_checked=0,total_links=0,
		truncated=false,error=NULL,summary='{"healthy":0,"redirected":0,"broken":0,"error":0,"blocked":0,"unchecked":0,"timeout":0}',
		seed_urls=$2,completed_at=NULL,updated_at=NOW() WHERE id=$1 RETURNING `+linkCheckColumns, id, seeds))
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return j, nil
}

// SaveLinkCheck publishes one consistent progress snapshot. The running guard
// prevents a cancelled/deleted job from being resurrected by a late HTTP result.
func (r *Repository) SaveLinkCheck(ctx context.Context, j models.LinkCheck, results []models.LinkResult) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	summary, err := json.Marshal(j.Summary)
	if err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `UPDATE link_checks SET status=$2,pages_checked=$3,pages_failed=$4,links_checked=$5,total_links=$6,
		truncated=$7,error=$8,summary=$9,updated_at=NOW(),completed_at=CASE WHEN $2 IN ('completed','failed') THEN NOW() ELSE NULL END
		WHERE id=$1 AND status='running'`, j.ID, j.Status, j.PagesChecked, j.PagesFailed, j.LinksChecked, j.TotalLinks, j.Truncated, j.Error, summary)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return nil
	}
	if _, err := tx.Exec(ctx, `DELETE FROM link_check_results WHERE link_check_id=$1`, j.ID); err != nil {
		return err
	}
	rows := make([][]any, 0, len(results))
	for _, result := range results {
		sources, err := json.Marshal(result.Sources)
		if err != nil {
			return err
		}
		rows = append(rows, []any{result.ID, j.ID, result.TargetURL, result.Status, result.StatusCode, result.FinalURL, result.RedirectCount, result.LinkType, result.OccurrenceCount, sources, result.Error, result.ErrorKind})
	}
	if len(rows) > 0 {
		_, err = tx.CopyFrom(ctx, pgx.Identifier{"link_check_results"}, []string{"id", "link_check_id", "target_url", "status", "status_code", "final_url", "redirect_count", "link_type", "occurrence_count", "sources", "error", "error_kind"}, pgx.CopyFromRows(rows))
		if err != nil {
			return fmt.Errorf("persist link results: %w", err)
		}
	}
	return tx.Commit(ctx)
}

func (r *Repository) CancelLinkCheck(ctx context.Context, id string) (*models.LinkCheck, error) {
	return linkCheckRow(r.pool.QueryRow(ctx, `UPDATE link_checks SET status='cancelled',completed_at=NOW(),updated_at=NOW()
		WHERE id=$1 AND status IN ('queued','running') RETURNING `+linkCheckColumns, id))
}

func (r *Repository) DeleteLinkCheck(ctx context.Context, id string) (bool, error) {
	tag, err := r.pool.Exec(ctx, `DELETE FROM link_checks WHERE id=$1 AND status NOT IN ('queued','running')`, id)
	return tag.RowsAffected() > 0, err
}

func (r *Repository) GetLinkResults(ctx context.Context, id, status string, limit, offset int) ([]models.LinkResult, int, error) {
	var total int
	if err := r.pool.QueryRow(ctx, `SELECT count(*) FROM link_check_results WHERE link_check_id=$1 AND ($2='' OR status=$2)`, id, status).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := r.pool.Query(ctx, `SELECT id,target_url,status,status_code,final_url,redirect_count,link_type,occurrence_count,
		jsonb_path_query_array(sources,'$[0 to 4]'),error,error_kind FROM link_check_results
		WHERE link_check_id=$1 AND ($2='' OR status=$2) ORDER BY
		CASE status WHEN 'broken' THEN 0 WHEN 'error' THEN 1 WHEN 'blocked' THEN 2 WHEN 'unchecked' THEN 3 WHEN 'redirected' THEN 4 ELSE 5 END,target_url,id
		LIMIT $3 OFFSET $4`, id, status, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	items := []models.LinkResult{}
	for rows.Next() {
		var item models.LinkResult
		var sources []byte
		if err := rows.Scan(&item.ID, &item.TargetURL, &item.Status, &item.StatusCode, &item.FinalURL, &item.RedirectCount, &item.LinkType, &item.OccurrenceCount, &sources, &item.Error, &item.ErrorKind); err != nil {
			return nil, 0, err
		}
		if err := json.Unmarshal(sources, &item.Sources); err != nil {
			return nil, 0, err
		}
		items = append(items, item)
	}
	return items, total, rows.Err()
}

// Export reads the entire bounded result/source set in one MVCC snapshot, so
// active progress publication cannot mix rows from different generations.
func (r *Repository) GetLinkExportResults(ctx context.Context, id string) ([]models.LinkResult, error) {
	rows, err := r.pool.Query(ctx, `SELECT id,target_url,status,status_code,final_url,redirect_count,link_type,occurrence_count,sources,error,error_kind
		FROM link_check_results WHERE link_check_id=$1 ORDER BY target_url,id`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []models.LinkResult{}
	for rows.Next() {
		var item models.LinkResult
		var sources []byte
		if err := rows.Scan(&item.ID, &item.TargetURL, &item.Status, &item.StatusCode, &item.FinalURL, &item.RedirectCount, &item.LinkType, &item.OccurrenceCount, &sources, &item.Error, &item.ErrorKind); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(sources, &item.Sources); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (r *Repository) GetLinkSources(ctx context.Context, id, resultID string, limit, offset int) ([]models.LinkSource, int, bool, error) {
	var encoded []byte
	err := r.pool.QueryRow(ctx, `SELECT sources FROM link_check_results WHERE link_check_id=$1 AND id=$2`, id, resultID).Scan(&encoded)
	if err == pgx.ErrNoRows {
		return nil, 0, false, nil
	}
	if err != nil {
		return nil, 0, false, err
	}
	var sources []models.LinkSource
	if err := json.Unmarshal(encoded, &sources); err != nil {
		return nil, 0, false, err
	}
	total := len(sources)
	if offset >= total {
		return []models.LinkSource{}, total, true, nil
	}
	end := offset + limit
	if end > total {
		end = total
	}
	return sources[offset:end], total, true, nil
}
