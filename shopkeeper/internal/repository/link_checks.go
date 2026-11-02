package repository

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
	"github.com/sumanbasuli/lime/shopkeeper/internal/viewport"
)

const linkCheckColumns = `id,scan_id,url,check_type,status,max_pages,pages_checked,pages_failed,links_checked,total_links,truncated,error,summary,seed_urls,created_at,updated_at,completed_at,root_public`

// ErrRecheckNotReady means the source link check is queued or running.
var ErrRecheckNotReady = errors.New("source link check is active")
var ErrRecheckEmptyInventory = errors.New("source scan page inventory is empty")

func linkCheckRow(row interface{ Scan(...any) error }) (*models.LinkCheck, error) {
	j := &models.LinkCheck{}
	var summary, seeds []byte
	err := row.Scan(&j.ID, &j.ScanID, &j.URL, &j.CheckType, &j.Status, &j.MaxPages, &j.PagesChecked, &j.PagesFailed,
		&j.LinksChecked, &j.TotalLinks, &j.Truncated, &j.Error, &summary, &seeds, &j.CreatedAt, &j.UpdatedAt, &j.CompletedAt, &j.RootPublic)
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
	tx, err := r.beginAdmissionTx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if err := admitActiveWork(ctx, tx, 1, 1); err != nil {
		return nil, err
	}
	scan, err := scanRow(tx.QueryRow(ctx, `INSERT INTO scans (sitemap_url,status,scan_type,tag,viewport_preset,viewport_width,viewport_height,include_link_check,root_public)
		VALUES ($1,'pending',$2,$3,$4,$5,$6,true,FALSE) RETURNING `+scanColumns, target, scanType, tag, v.Preset, v.Width, v.Height))
	if err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO link_checks(scan_id,url,check_type,max_pages,root_public) VALUES ($1,$2,'scan',500,FALSE)`, scan.ID, target); err != nil {
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
	tx, err := r.beginAdmissionTx(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to begin link check transaction: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := admitActiveWork(ctx, tx, 0, 1); err != nil {
		return nil, err
	}
	job, err := linkCheckRow(tx.QueryRow(ctx, `INSERT INTO link_checks(url,check_type,max_pages,seed_urls,root_public) VALUES ($1,$2,$3,$4,FALSE)
		RETURNING `+linkCheckColumns, target, kind, maxPages, encoded))
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("failed to commit link check transaction: %w", err)
	}
	return job, nil
}

// CreateLinkCheckFrom creates a detached recheck with its source's root DNS
// policy. The source lock serializes this copy with policy observations.
func (r *Repository) CreateLinkCheckFrom(ctx context.Context, sourceJobID string) (*models.LinkCheck, error) {
	if r.mcpAction(ctx) != nil {
		return r.createActionLinkCheckFrom(ctx, sourceJobID)
	}
	tx, err := r.beginAdmissionTx(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to begin recheck transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	var parentID *string
	if err := tx.QueryRow(ctx, `SELECT scan_id FROM link_checks WHERE id=$1`, sourceJobID).Scan(&parentID); err != nil {
		return nil, fmt.Errorf("failed to find source link check: %w", err)
	}
	var parentPublic bool
	if parentID != nil {
		if err := tx.QueryRow(ctx, `SELECT root_public FROM scans WHERE id=$1 FOR UPDATE`, *parentID).Scan(&parentPublic); err != nil {
			return nil, fmt.Errorf("failed to lock source scan: %w", err)
		}
	}
	source, err := linkCheckRow(tx.QueryRow(ctx, `SELECT `+linkCheckColumns+` FROM link_checks WHERE id=$1 FOR UPDATE`, sourceJobID))
	if err != nil {
		return nil, fmt.Errorf("failed to lock source link check: %w", err)
	}
	if source == nil {
		return nil, pgx.ErrNoRows
	}
	if (source.ScanID == nil) != (parentID == nil) ||
		(source.ScanID != nil && *source.ScanID != *parentID) {
		return nil, fmt.Errorf("source link check parent changed while copying policy")
	}
	if source.Status == "queued" || source.Status == "running" {
		return nil, ErrRecheckNotReady
	}
	if err := admitActiveWork(ctx, tx, 0, 1); err != nil {
		return nil, err
	}
	seeds, err := json.Marshal(source.SeedURLs)
	if err != nil {
		return nil, fmt.Errorf("failed to encode source seed URLs: %w", err)
	}
	created, err := linkCheckRow(tx.QueryRow(ctx, `INSERT INTO link_checks(url,check_type,max_pages,seed_urls,root_public)
		VALUES ($1,$2,$3,$4,$5) RETURNING `+linkCheckColumns,
		source.URL, source.CheckType, source.MaxPages, seeds, source.RootPublic || parentPublic))
	if err != nil {
		return nil, fmt.Errorf("failed to create detached recheck: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("failed to commit recheck transaction: %w", err)
	}
	return created, nil
}

func (r *Repository) GetLinkCheck(ctx context.Context, id string) (*models.LinkCheck, error) {
	if r.mcpAction(ctx) != nil {
		return r.actionGetLinkCheck(ctx, id, false)
	}
	if read := r.mcpRead(ctx); read != nil {
		return read.getLinkCheck(ctx, id, false)
	}
	return linkCheckRow(r.pool.QueryRow(ctx, `SELECT `+linkCheckColumns+` FROM link_checks WHERE id=$1`, id))
}

func (r *Repository) GetScanLinkCheck(ctx context.Context, id string) (*models.LinkCheck, error) {
	if r.mcpAction(ctx) != nil {
		return r.actionGetLinkCheck(ctx, id, true)
	}
	if read := r.mcpRead(ctx); read != nil {
		return read.getLinkCheck(ctx, id, true)
	}
	return linkCheckRow(r.pool.QueryRow(ctx, `SELECT `+linkCheckColumns+` FROM link_checks WHERE scan_id=$1`, id))
}

func (r *Repository) ListLinkChecks(ctx context.Context, limit, offset int) ([]models.LinkCheck, int, error) {
	if read := r.mcpRead(ctx); read != nil {
		return read.listLinkChecks(ctx, limit, offset)
	}
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
	if read := r.mcpRead(ctx); read != nil {
		// A malformed historical counter can otherwise become a large SQL cast error.
		if err := read.measure(ctx, `SELECT 1::bigint,COALESCE(MAX(octet_length(summary->>'broken')),0)::bigint +
			COALESCE(MAX(octet_length(summary->>'redirected')),0)::bigint + COALESCE(MAX(octet_length(summary->>'timeout')),0)::bigint
			FROM link_checks`); err != nil {
			return nil, err
		}
	}
	var checks, active, pages, links, broken, redirected, timeouts int64
	err := r.mcpQueryer(ctx).QueryRow(ctx, `SELECT count(*),count(*) FILTER(WHERE status IN ('queued','running')),
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
		var totalURLs int
		// Parent first, child second matches scan deletion/retry lock ordering.
		// This waits for concurrent retries before deciding the parent is ready.
		if err := tx.QueryRow(ctx, `SELECT status,total_urls FROM scans WHERE id=$1 FOR SHARE`, *j.ScanID).Scan(&status, &totalURLs); err != nil {
			if err == pgx.ErrNoRows {
				return nil, nil
			}
			return nil, err
		}
		if status != "completed" {
			return nil, nil
		}
		// A companion may only read the published scan-ready inventory. Older
		// scans have no discovery row and retain their saved URL semantics.
		var phase string
		err := tx.QueryRow(ctx, `SELECT phase FROM scan_discoveries WHERE scan_id=$1`, *j.ScanID).Scan(&phase)
		if err != nil && err != pgx.ErrNoRows {
			return nil, err
		}
		if err == nil {
			if phase != "complete" {
				return nil, nil
			}
			var count int
			if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM urls WHERE scan_id=$1`, *j.ScanID).Scan(&count); err != nil {
				return nil, err
			}
			if count == 0 || count != totalURLs {
				return nil, nil
			}
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

// SaveLinkCheck publishes job progress and only the result rows changed since
// the previous successful publication. ClaimLinkCheck clears an interrupted
// generation before its first publication. The running guard prevents a
// cancelled/deleted job from being resurrected by a late HTTP result.
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
	// The job update holds its row lock until commit. It serializes progress
	// publications and cancellation, so these counts describe the last
	// committed source prefix for each changed target in this generation.
	persistedCounts, err := linkSourcePrefixes(ctx, tx, j.ID, results)
	if err != nil {
		return err
	}
	batch := &pgx.Batch{}
	for _, result := range results {
		sources, err := encodeLinkSourceDelta(result, persistedCounts[result.TargetURL])
		if err != nil {
			return err
		}
		batch.Queue(`INSERT INTO link_check_results
			(id,link_check_id,target_url,status,status_code,final_url,redirect_count,link_type,occurrence_count,sources_storage,error,error_kind)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11)
			ON CONFLICT (link_check_id,target_url) DO UPDATE SET
				id=EXCLUDED.id,status=EXCLUDED.status,status_code=EXCLUDED.status_code,final_url=EXCLUDED.final_url,
				redirect_count=EXCLUDED.redirect_count,link_type=EXCLUDED.link_type,
				occurrence_count=EXCLUDED.occurrence_count,
				error=EXCLUDED.error,error_kind=EXCLUDED.error_kind
			WHERE (link_check_results.id,link_check_results.status,link_check_results.status_code,
				link_check_results.final_url,link_check_results.redirect_count,link_check_results.link_type,
				link_check_results.occurrence_count,
				link_check_results.error,link_check_results.error_kind)
				IS DISTINCT FROM
				(EXCLUDED.id,EXCLUDED.status,EXCLUDED.status_code,EXCLUDED.final_url,
				EXCLUDED.redirect_count,EXCLUDED.link_type,EXCLUDED.occurrence_count,
					EXCLUDED.error,EXCLUDED.error_kind)`,
			result.ID, j.ID, result.TargetURL, result.Status, result.StatusCode, result.FinalURL,
			result.RedirectCount, result.LinkType, result.OccurrenceCount, result.Error, result.ErrorKind)
		if persistedCounts[result.TargetURL] < result.OccurrenceCount {
			batch.Queue(`INSERT INTO link_check_sources(result_id,ordinal,source)
				SELECT $1,($2::int+s.ordinal-1)::int,s.source
				FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY AS s(source,ordinal)`,
				result.ID, persistedCounts[result.TargetURL], string(sources))
		}
	}
	if batch.Len() > 0 {
		batchResults := tx.SendBatch(ctx, batch)
		var writeErr error
		for i := 0; i < batch.Len(); i++ {
			if _, err := batchResults.Exec(); err != nil {
				writeErr = err
				break
			}
		}
		closeErr := batchResults.Close()
		if writeErr != nil {
			return fmt.Errorf("persist link results: %w", writeErr)
		}
		if closeErr != nil {
			return fmt.Errorf("finish link result batch: %w", closeErr)
		}
	}
	return tx.Commit(ctx)
}

// A LinkResult carries the complete retained source prefix for the runner and
// final failure retry. Only the suffix after the last committed occurrence is
// sent to PostgreSQL; a replay of the same result cannot duplicate sources.
func encodeLinkSourceDelta(result models.LinkResult, persistedCount int) ([]byte, error) {
	if persistedCount < 0 || result.OccurrenceCount != len(result.Sources) || persistedCount > result.OccurrenceCount {
		return nil, fmt.Errorf("invalid source prefix for link result %q: persisted=%d incoming=%d sources=%d",
			result.TargetURL, persistedCount, result.OccurrenceCount, len(result.Sources))
	}
	delta := result.Sources[persistedCount:]
	if delta == nil {
		delta = []models.LinkSource{}
	}
	return json.Marshal(delta)
}

func (r *Repository) CancelLinkCheck(ctx context.Context, id string) (*models.LinkCheck, error) {
	if call := r.mcpAction(ctx); call != nil {
		tx, err := r.actionTx(ctx)
		if err != nil {
			return nil, err
		}
		defer tx.Rollback(ctx)
		var encoded []byte
		err = tx.QueryRow(ctx, `WITH updated AS (
			UPDATE link_checks SET status='cancelled',completed_at=NOW(),updated_at=NOW()
			WHERE id=$1 AND status IN ('queued','running') RETURNING *)
			SELECT CASE WHEN `+mcpLinkCheckTextBytesSQL+` <= $2
			THEN `+actionLinkCheckJSON+` ELSE NULL END FROM updated j`, id, call.allowance()).Scan(&encoded)
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		job, err := decodeActionLinkCheck(call, encoded)
		if err != nil {
			return nil, err
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return job, nil
	}
	return linkCheckRow(r.pool.QueryRow(ctx, `UPDATE link_checks SET status='cancelled',completed_at=NOW(),updated_at=NOW()
		WHERE id=$1 AND status IN ('queued','running') RETURNING `+linkCheckColumns, id))
}

func (r *Repository) DeleteLinkCheck(ctx context.Context, id string) (bool, error) {
	if r.mcpAction(ctx) != nil {
		count, err := r.actionExec(ctx, `DELETE FROM link_checks WHERE id=$1 AND status NOT IN ('queued','running')`, id)
		return count > 0, err
	}
	tag, err := r.pool.Exec(ctx, `DELETE FROM link_checks WHERE id=$1 AND status NOT IN ('queued','running')`, id)
	return tag.RowsAffected() > 0, err
}

func (r *Repository) GetLinkResults(ctx context.Context, id, status string, limit, offset int) ([]models.LinkResult, int, error) {
	if read := r.mcpRead(ctx); read != nil {
		if err := read.measureLinkResults(ctx, id, status, limit, offset); err != nil {
			return nil, 0, err
		}
	}
	var total int
	if err := r.mcpQueryer(ctx).QueryRow(ctx, `SELECT count(*) FROM link_check_results WHERE link_check_id=$1 AND ($2='' OR status=$2)`, id, status).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := r.mcpQueryer(ctx).Query(ctx, `SELECT id,target_url,status,status_code,final_url,redirect_count,link_type,occurrence_count,
		`+linkSourceSliceSQL("0", "5")+`,error,error_kind FROM link_check_results r
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
	rows, err := r.pool.Query(ctx, `SELECT id,target_url,status,status_code,final_url,redirect_count,link_type,occurrence_count,`+linkAllSourcesSQL+`,error,error_kind
		FROM link_check_results r WHERE link_check_id=$1 ORDER BY target_url,id`, id)
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
	if limit < 1 || limit > 200 || offset < 0 || offset > 1000000 {
		return nil, 0, false, fmt.Errorf("invalid link source page: limit=%d offset=%d", limit, offset)
	}
	if read := r.mcpRead(ctx); read != nil {
		if err := read.measure(ctx, `SELECT COUNT(*),COALESCE(SUM(octet_length(page.sources::text)::bigint),0)
			FROM (`+linkSourcesPageSQL+`) page`, id, resultID, offset, limit); err != nil {
			return nil, 0, false, err
		}
	}
	var encoded []byte
	var total int
	// Project only the requested source slice from either storage version.
	// Ordinary pages transfer and decode at most 200 references.
	err := r.mcpQueryer(ctx).QueryRow(ctx, linkSourcesPageSQL, id, resultID, offset, limit).Scan(&total, &encoded)
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
	return sources, total, true, nil
}
