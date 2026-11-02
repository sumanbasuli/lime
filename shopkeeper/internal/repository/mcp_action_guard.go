package repository

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
)

const MaxMCPActionResponseBytes = 2 << 20

type mcpActionContextKey struct{}

// scans store timezone-free UTC timestamps; JSON needs an explicit RFC3339 zone.
const actionScanJSON = `to_jsonb(s)||jsonb_build_object(
	'created_at',to_char(s.created_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
	'updated_at',to_char(s.updated_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))`

const actionLinkCheckJSON = `jsonb_build_object(
	'id',j.id,'scan_id',j.scan_id,'url',j.url,'check_type',j.check_type,
	'status',j.status,'max_pages',j.max_pages,'pages_checked',j.pages_checked,
	'pages_failed',j.pages_failed,'links_checked',j.links_checked,
	'total_links',j.total_links,'truncated',j.truncated,'error',j.error,
	'summary',j.summary,
	'created_at',to_char(j.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
	'updated_at',to_char(j.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
	'completed_at',to_char(j.completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
	'root_public',j.root_public)`

type mcpActionCall struct {
	owner            *Repository
	mu               sync.Mutex
	remaining        int64
	retainUntil      time.Time
	statementTimeout time.Duration
	uncertain        bool
}

// BeginMCPActionCall bounds all database work belonging to one action. It does
// not hold a read transaction across mutations.
func (r *Repository) BeginMCPActionCall(ctx context.Context) (context.Context, func() time.Time, error) {
	if r.mcpAction(ctx) != nil {
		return ctx, func() time.Time { return time.Time{} }, nil
	}
	callCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	if err := callCtx.Err(); err != nil {
		cancel()
		return ctx, func() time.Time { return time.Time{} }, err
	}
	call := &mcpActionCall{owner: r, remaining: maxMCPReadEstimate}
	finish := func() time.Time {
		interrupted := callCtx.Err() != nil
		cancel()
		call.mu.Lock()
		defer call.mu.Unlock()
		if interrupted || call.uncertain {
			// The server starts its relative timeout after receipt of the last
			// query, which may be later than the client's cancellation.
			if until := time.Now().Add(call.statementTimeout); until.After(call.retainUntil) {
				return until
			}
			return call.retainUntil
		}
		return time.Time{}
	}
	return context.WithValue(callCtx, mcpActionContextKey{}, call), finish, nil
}

func (r *Repository) mcpAction(ctx context.Context) *mcpActionCall {
	call, _ := ctx.Value(mcpActionContextKey{}).(*mcpActionCall)
	if call != nil && call.owner == r {
		return call
	}
	return nil
}

// IsMCPActionCall lets handlers avoid decoding hidden seed inventory in an
// action prerequisite. The locked recheck copy validates that inventory.
func IsMCPActionCall(ctx context.Context) bool {
	_, ok := ctx.Value(mcpActionContextKey{}).(*mcpActionCall)
	return ok
}

func (call *mcpActionCall) allowance() int64 {
	call.mu.Lock()
	defer call.mu.Unlock()
	if call.remaining <= mcpReadRowAllowance {
		return 0
	}
	return (call.remaining - mcpReadRowAllowance) / 14
}

func (call *mcpActionCall) charge(n int64) error {
	call.mu.Lock()
	defer call.mu.Unlock()
	if n < 0 || n > (call.remaining-mcpReadRowAllowance)/14 {
		return ErrMCPReadTooLarge
	}
	call.remaining -= mcpReadRowAllowance + n*14
	return nil
}

func (call *mcpActionCall) record(timeout time.Duration) {
	call.mu.Lock()
	defer call.mu.Unlock()
	until := time.Now().Add(timeout)
	if until.After(call.retainUntil) {
		call.retainUntil = until
	}
	call.statementTimeout = timeout
}

func (call *mcpActionCall) touch() {
	call.mu.Lock()
	defer call.mu.Unlock()
	until := time.Now().Add(call.statementTimeout)
	if until.After(call.retainUntil) {
		call.retainUntil = until
	}
}

func (call *mcpActionCall) markUncertain() {
	call.mu.Lock()
	call.uncertain = true
	call.mu.Unlock()
}

func (call *mcpActionCall) observe(ctx context.Context, err error) {
	if err == nil || (ctx.Err() == nil && !errors.Is(err, context.DeadlineExceeded)) {
		return
	}
	call.markUncertain()
}

type mcpActionTx struct {
	pgx.Tx
	call *mcpActionCall
}

func (tx *mcpActionTx) prepare(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	deadline, ok := ctx.Deadline()
	if !ok {
		return context.DeadlineExceeded
	}
	remaining := time.Until(deadline)
	if remaining <= 0 {
		return context.DeadlineExceeded
	}
	milliseconds := max(int64(1), remaining.Milliseconds())
	timeout := time.Duration(milliseconds) * time.Millisecond
	tx.call.record(timeout)
	_, err := tx.Tx.Exec(ctx, `SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true)`, fmt.Sprintf("%dms", milliseconds))
	tx.call.observe(ctx, err)
	return mcpReadError(err)
}

type mcpActionRow struct {
	pgx.Row
	call *mcpActionCall
	ctx  context.Context
}

func (row mcpActionRow) Scan(dest ...any) error {
	err := mcpReadError(row.Row.Scan(dest...))
	row.call.observe(row.ctx, err)
	return err
}

func (tx *mcpActionTx) QueryRow(ctx context.Context, query string, args ...any) pgx.Row {
	if err := tx.prepare(ctx); err != nil {
		return mcpErrorRow{err}
	}
	tx.call.touch()
	return mcpActionRow{Row: tx.Tx.QueryRow(ctx, query, args...), call: tx.call, ctx: ctx}
}

func (tx *mcpActionTx) Query(ctx context.Context, query string, args ...any) (pgx.Rows, error) {
	if err := tx.prepare(ctx); err != nil {
		return nil, err
	}
	tx.call.touch()
	rows, err := tx.Tx.Query(ctx, query, args...)
	if err != nil {
		tx.call.observe(ctx, err)
		return nil, mcpReadError(err)
	}
	return mcpReadRows{rows}, nil
}

func (tx *mcpActionTx) Exec(ctx context.Context, query string, args ...any) (pgconn.CommandTag, error) {
	if err := tx.prepare(ctx); err != nil {
		return pgconn.CommandTag{}, err
	}
	tx.call.touch()
	tag, err := tx.Tx.Exec(ctx, query, args...)
	tx.call.observe(ctx, err)
	return tag, mcpReadError(err)
}

func (tx *mcpActionTx) Commit(ctx context.Context) error {
	tx.call.touch()
	err := tx.Tx.Commit(ctx)
	if err != nil {
		tx.call.markUncertain()
	}
	return mcpReadError(err)
}

func (tx *mcpActionTx) Rollback(ctx context.Context) error {
	err := tx.Tx.Rollback(ctx)
	if err != nil && !errors.Is(err, pgx.ErrTxClosed) {
		tx.call.markUncertain()
	}
	return mcpReadError(err)
}

func (r *Repository) actionTx(ctx context.Context) (pgx.Tx, error) {
	call := r.mcpAction(ctx)
	if call != nil {
		if deadline, ok := ctx.Deadline(); ok {
			remaining := time.Until(deadline)
			if remaining > 0 {
				call.record(remaining)
			}
		}
	}
	tx, err := r.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		if call != nil {
			call.observe(ctx, err)
		}
		return nil, mcpReadError(err)
	}
	if call != nil {
		return &mcpActionTx{Tx: tx, call: call}, nil
	}
	return tx, nil
}

func (r *Repository) actionJSONRow(ctx context.Context, query string, args ...any) ([]byte, error) {
	tx, err := r.actionTx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var encoded []byte
	if err := tx.QueryRow(ctx, query, args...).Scan(&encoded); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, mcpReadError(err)
	}
	return encoded, nil
}

func (r *Repository) actionExec(ctx context.Context, query string, args ...any) (int64, error) {
	tx, err := r.actionTx(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx, query, args...)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, mcpReadError(err)
	}
	return tag.RowsAffected(), nil
}

func decodeActionScan(call *mcpActionCall, encoded []byte) (*models.Scan, error) {
	if encoded == nil {
		return nil, ErrMCPReadTooLarge
	}
	if err := call.charge(int64(len(encoded))); err != nil {
		return nil, err
	}
	var value struct {
		models.Scan
		RootPublic bool `json:"root_public"`
	}
	if err := json.Unmarshal(encoded, &value); err != nil {
		return nil, err
	}
	value.Scan.RootPublic = value.RootPublic
	return &value.Scan, nil
}

func (r *Repository) actionReserveScanReturn(ctx context.Context, scan *models.Scan) error {
	encoded, err := json.Marshal(scan)
	if err != nil {
		return err
	}
	return r.mcpAction(ctx).charge(int64(len(encoded)))
}

func decodeActionLinkCheck(call *mcpActionCall, encoded []byte) (*models.LinkCheck, error) {
	if encoded == nil {
		return nil, ErrMCPReadTooLarge
	}
	if err := call.charge(int64(len(encoded))); err != nil {
		return nil, err
	}
	var value struct {
		models.LinkCheck
		RootPublic bool `json:"root_public"`
	}
	if err := json.Unmarshal(encoded, &value); err != nil {
		return nil, err
	}
	value.LinkCheck.RootPublic = value.RootPublic
	return &value.LinkCheck, nil
}

func (r *Repository) actionGetScan(ctx context.Context, id string) (*models.Scan, error) {
	call := r.mcpAction(ctx)
	encoded, err := r.actionJSONRow(ctx, `SELECT CASE WHEN `+mcpScanTextBytesSQL+` <= $2
		THEN `+actionScanJSON+` ELSE NULL END FROM scans s WHERE id=$1`, id, call.allowance())
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return decodeActionScan(call, encoded)
}

func (r *Repository) actionGetLinkCheck(ctx context.Context, id string, byScan bool) (*models.LinkCheck, error) {
	column := "id"
	if byScan {
		column = "scan_id"
	}
	call := r.mcpAction(ctx)
	encoded, err := r.actionJSONRow(ctx, `SELECT CASE WHEN `+mcpLinkCheckTextBytesSQL+` <= $2
		THEN `+actionLinkCheckJSON+` ELSE NULL END FROM link_checks j WHERE `+column+`=$1`, id, call.allowance())
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return decodeActionLinkCheck(call, encoded)
}

func (r *Repository) actionLockedScan(ctx context.Context, tx pgx.Tx, id string) (*models.Scan, error) {
	call := r.mcpAction(ctx)
	var encoded []byte
	err := tx.QueryRow(ctx, `SELECT CASE WHEN `+mcpScanTextBytesSQL+` <= $2
		THEN `+actionScanJSON+` ELSE NULL END FROM scans s WHERE id=$1 FOR UPDATE`, id, call.allowance()).Scan(&encoded)
	if err != nil {
		return nil, err
	}
	return decodeActionScan(call, encoded)
}

func (r *Repository) actionLockedIssue(ctx context.Context, tx pgx.Tx, scanID, issueID string) error {
	call := r.mcpAction(ctx)
	var encoded []byte
	err := tx.QueryRow(ctx, `SELECT CASE WHEN octet_length(violation_type)::bigint+
		octet_length(description)::bigint+COALESCE(octet_length(help_url),0)::bigint+
		octet_length(severity::text)::bigint <= $3 THEN to_jsonb(i) ELSE NULL END
		FROM issues i WHERE scan_id=$1 AND id=$2 FOR UPDATE`, scanID, issueID, call.allowance()).Scan(&encoded)
	if err == pgx.ErrNoRows {
		return nil
	}
	if err != nil {
		return err
	}
	if encoded == nil {
		return ErrMCPReadTooLarge
	}
	if err := call.charge(int64(len(encoded))); err != nil {
		return err
	}
	return call.charge(int64(len(encoded)))
}

func (r *Repository) actionLockedLinkCheck(ctx context.Context, tx pgx.Tx, id string) (*models.LinkCheck, bool, bool, error) {
	call := r.mcpAction(ctx)
	var encoded []byte
	var valid, empty bool
	err := tx.QueryRow(ctx, `SELECT CASE WHEN `+mcpLinkCheckTextBytesSQL+` <= $2
		THEN `+actionLinkCheckJSON+` ELSE NULL END,
		CASE WHEN jsonb_typeof(seed_urls) IN ('array','null') THEN
			NOT EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(seed_urls)='array' THEN seed_urls ELSE '[]'::jsonb END) v
				WHERE jsonb_typeof(v.value) NOT IN ('string','null')) ELSE FALSE END,
		CASE WHEN jsonb_typeof(seed_urls)='array' THEN jsonb_array_length(seed_urls)=0 ELSE TRUE END
		FROM link_checks j WHERE id=$1 FOR UPDATE`, id, call.allowance()).Scan(&encoded, &valid, &empty)
	if err != nil {
		return nil, false, false, err
	}
	job, err := decodeActionLinkCheck(call, encoded)
	return job, valid, empty, err
}

func (r *Repository) createActionLinkCheckFrom(ctx context.Context, id string) (*models.LinkCheck, error) {
	call := r.mcpAction(ctx)
	tx, err := r.beginAdmissionTx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var parentID *string
	if err := tx.QueryRow(ctx, `SELECT scan_id FROM link_checks WHERE id=$1`, id).Scan(&parentID); err != nil {
		return nil, err
	}
	var parentPublic bool
	if parentID != nil {
		if err := tx.QueryRow(ctx, `SELECT root_public FROM scans WHERE id=$1 FOR UPDATE`, *parentID).Scan(&parentPublic); err != nil {
			return nil, err
		}
	}
	source, valid, empty, err := r.actionLockedLinkCheck(ctx, tx, id)
	if err != nil {
		return nil, err
	}
	if (source.ScanID == nil) != (parentID == nil) || (source.ScanID != nil && *source.ScanID != *parentID) {
		return nil, fmt.Errorf("source link check parent changed while copying policy")
	}
	if !valid {
		return nil, fmt.Errorf("source link check seed URLs are invalid")
	}
	if source.Status == "queued" || source.Status == "running" {
		return nil, ErrRecheckNotReady
	}
	if source.CheckType == "scan" && empty {
		return nil, ErrRecheckEmptyInventory
	}
	if err := admitActiveWork(ctx, tx, 0, 1); err != nil {
		return nil, err
	}
	var encoded []byte
	err = tx.QueryRow(ctx, `WITH inserted AS (
		INSERT INTO link_checks(url,check_type,max_pages,seed_urls,root_public)
		SELECT url,check_type,max_pages,seed_urls,root_public OR $2 FROM link_checks WHERE id=$1
		RETURNING *)
		SELECT CASE WHEN `+mcpLinkCheckTextBytesSQL+` <= $3
		THEN `+actionLinkCheckJSON+` ELSE NULL END FROM inserted j`, id, parentPublic, call.allowance()).Scan(&encoded)
	if err != nil {
		return nil, err
	}
	created, err := decodeActionLinkCheck(call, encoded)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return created, nil
}
