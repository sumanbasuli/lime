package repository

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"math"
	"net"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
)

const (
	discoveryMaxRequests         = 20000
	discoveryMaxXMLBytes   int64 = 128 << 20
	discoveryMaxCandidates       = 10000
	discoverySliceMS       int64 = 600000
	discoveryTailHorizonMS int64 = 960000 // five-minute commit tail plus lease margin
	discoveryLeaseMS       int64 = 60000
)

var (
	ErrDiscoveryBudget        = errors.New("discovery budget exceeded")
	ErrDiscoveryInvariant     = errors.New("invalid discovery state")
	ErrDiscoveryNestedFailure = errors.New("nested sitemap failed")
	ErrDiscoveryNoURLs        = errors.New("no eligible URLs discovered")
	ErrDiscoverySliceEnded    = errors.New("discovery admission slice ended")
)

type DiscoverySnapshot struct {
	Phase                string
	Epoch                int64
	RequestsUsed         int
	XMLBytesUsed         int64
	NextCandidateOrdinal int
	ActiveMSUsed         int64
}
type DiscoveryAdmission struct {
	Remaining time.Duration
	Epoch     int64
}
type DiscoverySitemapTask struct {
	CanonicalURL, FetchURL string
	Path                   []int32
	Depth                  int
	EntryIndex             int // original zero-based XML position when used as a child
}
type DiscoveryDocument struct {
	IsIndex    bool
	Children   []DiscoverySitemapTask
	Candidates []string
}
type DiscoveryCandidate struct {
	RawURL  string
	Ordinal int
}
type DiscoveryProbeOutcome struct {
	Ordinal                   int
	RawURL, Outcome, FinalURL string
	Redirected                bool
}

func DiscoveryCanonicalURL(raw string) string {
	u, e := url.Parse(raw)
	if e != nil {
		return raw
	}
	v := *u
	v.Scheme = strings.ToLower(v.Scheme)
	host := strings.ToLower(u.Hostname())
	port := u.Port()
	if host == "" {
		v.Host = ""
	} else if port == "" || (v.Scheme == "http" && port == "80") || (v.Scheme == "https" && port == "443") {
		v.Host = host
	} else {
		v.Host = net.JoinHostPort(host, port)
	}
	v.Fragment = ""
	if v.Path == "" {
		v.Path = "/"
	}
	return v.String()
}
func discoveryHash(s string) []byte { h := sha256.Sum256([]byte(s)); return h[:] }
func sameDiscoveryPath(a, b []int32) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
func earlierDiscoveryPath(a, b []int32) bool {
	for i := 0; i < len(a) && i < len(b); i++ {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return len(a) < len(b)
}

// LoadOrCreateDiscovery serializes with scan mutations and refuses partial scan-ready data.
func (r *Repository) LoadOrCreateDiscovery(ctx context.Context, scanID, rootURL string) (DiscoverySnapshot, error) {
	tx, e := r.pool.Begin(ctx)
	if e != nil {
		return DiscoverySnapshot{}, e
	}
	defer tx.Rollback(ctx)
	var kind, saved string
	var count int
	e = tx.QueryRow(ctx, `SELECT scan_type,sitemap_url,(SELECT COUNT(*) FROM urls WHERE scan_id=$1) FROM scans WHERE id=$1 FOR UPDATE`, scanID).Scan(&kind, &saved, &count)
	if e != nil {
		return DiscoverySnapshot{}, e
	}
	if kind == "single" || saved != rootURL {
		return DiscoverySnapshot{}, ErrDiscoveryInvariant
	}
	var exists bool
	e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM scan_discoveries WHERE scan_id=$1)`, scanID).Scan(&exists)
	if e != nil {
		return DiscoverySnapshot{}, e
	}
	if !exists {
		if count != 0 {
			return DiscoverySnapshot{}, ErrDiscoveryInvariant
		}
		_, e = tx.Exec(ctx, `INSERT INTO scan_discoveries(scan_id) VALUES($1)`, scanID)
		if e != nil {
			return DiscoverySnapshot{}, e
		}
		key := DiscoveryCanonicalURL(rootURL)
		_, e = tx.Exec(ctx, `INSERT INTO scan_discovery_sitemaps(scan_id,canonical_url,canonical_hash,fetch_url,dfs_path,depth) VALUES($1,$2,$3,$4,ARRAY[]::integer[],0)`, scanID, key, discoveryHash(key), rootURL)
		if e != nil {
			return DiscoverySnapshot{}, e
		}
	}
	var s DiscoverySnapshot
	e = tx.QueryRow(ctx, `SELECT phase,admission_epoch,requests_used,xml_bytes_used,next_candidate_ordinal,active_ms_used FROM scan_discoveries WHERE scan_id=$1 FOR UPDATE`, scanID).Scan(&s.Phase, &s.Epoch, &s.RequestsUsed, &s.XMLBytesUsed, &s.NextCandidateOrdinal, &s.ActiveMSUsed)
	if e != nil {
		return s, e
	}
	if (s.Phase == "complete") != (count > 0) {
		return s, ErrDiscoveryInvariant
	}
	e = tx.Commit(ctx)
	return s, e
}

func (r *Repository) GetDiscoverySnapshot(ctx context.Context, id string) (DiscoverySnapshot, bool, error) {
	var s DiscoverySnapshot
	err := r.pool.QueryRow(ctx, `SELECT phase,admission_epoch,requests_used,xml_bytes_used,next_candidate_ordinal,active_ms_used FROM scan_discoveries WHERE scan_id=$1`, id).Scan(&s.Phase, &s.Epoch, &s.RequestsUsed, &s.XMLBytesUsed, &s.NextCandidateOrdinal, &s.ActiveMSUsed)
	if errors.Is(err, pgx.ErrNoRows) {
		return s, false, nil
	}
	if err != nil {
		return s, false, err
	}
	return s, true, nil
}

// RecoverDiscoveryAdmission preserves checkpoint rows and their reserved charge.
// It only transitions an interrupted profiling scan; a missing checkpoint is
// left for the legacy recovery path. The scan row is always locked first.
func (r *Repository) RecoverDiscoveryAdmission(ctx context.Context, scanID string) (bool, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	var status string
	var pause bool
	err = tx.QueryRow(ctx, `SELECT status,pause_requested FROM scans WHERE id=$1 FOR UPDATE`, scanID).Scan(&status, &pause)
	if err != nil {
		return false, err
	}
	var exists bool
	err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM scan_discoveries WHERE scan_id=$1)`, scanID).Scan(&exists)
	if err != nil {
		return false, err
	}
	if !exists {
		return false, nil
	}
	_, err = tx.Exec(ctx, `UPDATE scan_discoveries SET admission_epoch=admission_epoch+1,active_started_at=NULL,active_reserved_ms=0,active_heartbeat_at=NULL WHERE scan_id=$1`, scanID)
	if err != nil {
		return true, err
	}
	if status == "profiling" {
		if pause {
			_, err = tx.Exec(ctx, `UPDATE scans SET status='paused',pause_requested=FALSE,updated_at=NOW() WHERE id=$1`, scanID)
		} else {
			_, err = tx.Exec(ctx, `UPDATE scans SET status='pending',updated_at=NOW() WHERE id=$1`, scanID)
		}
		if err != nil {
			return true, err
		}
	}
	return true, tx.Commit(ctx)
}

func (r *Repository) StartDiscoveryAdmission(ctx context.Context, id string) (DiscoveryAdmission, error) {
	tx, e := r.pool.Begin(ctx)
	if e != nil {
		return DiscoveryAdmission{}, e
	}
	defer tx.Rollback(ctx)
	var status string
	var pause bool
	e = tx.QueryRow(ctx, `SELECT status,pause_requested FROM scans WHERE id=$1 FOR UPDATE`, id).Scan(&status, &pause)
	if e != nil {
		return DiscoveryAdmission{}, e
	}
	if status != "pending" || pause {
		return DiscoveryAdmission{}, ErrDiscoveryInvariant
	}
	var phase string
	var epoch int64
	e = tx.QueryRow(ctx, `SELECT phase,admission_epoch FROM scan_discoveries WHERE scan_id=$1 FOR UPDATE`, id).Scan(&phase, &epoch)
	if e != nil {
		return DiscoveryAdmission{}, e
	}
	if phase == "complete" {
		return DiscoveryAdmission{}, ErrDiscoveryInvariant
	}
	reserve := discoveryLeaseMS
	_, e = tx.Exec(ctx, `UPDATE scans SET status='profiling',updated_at=NOW() WHERE id=$1`, id)
	if e != nil {
		return DiscoveryAdmission{}, e
	}
	_, e = tx.Exec(ctx, `UPDATE scan_discoveries SET admission_epoch=admission_epoch+1,active_ms_used=active_ms_used+$2,active_started_at=NOW(),active_reserved_ms=$2,active_heartbeat_at=NOW() WHERE scan_id=$1`, id, reserve)
	if e != nil {
		return DiscoveryAdmission{}, e
	}
	if e = tx.Commit(ctx); e != nil {
		return DiscoveryAdmission{}, e
	}
	return DiscoveryAdmission{Remaining: time.Duration(discoverySliceMS) * time.Millisecond, Epoch: epoch + 1}, nil
}
func (r *Repository) RenewDiscoveryAdmission(ctx context.Context, id string, epoch int64, elapsed time.Duration) error {
	tx, e := r.pool.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	var used, reserved int64
	var active bool
	e = tx.QueryRow(ctx, `SELECT active_ms_used,active_reserved_ms,active_started_at IS NOT NULL FROM scan_discoveries WHERE scan_id=$1 AND admission_epoch=$2 FOR UPDATE`, id, epoch).Scan(&used, &reserved, &active)
	if e != nil {
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrDiscoveryInvariant
		}
		return e
	}
	if !active {
		return ErrDiscoveryInvariant
	}
	ms := max(int64(0), elapsed.Milliseconds())
	if ms >= discoveryTailHorizonMS {
		return ErrDiscoverySliceEnded
	}
	target := max(reserved, min(ms+discoveryLeaseMS, discoveryTailHorizonMS))
	_, e = tx.Exec(ctx, `UPDATE scan_discoveries SET active_ms_used=active_ms_used+$2,active_reserved_ms=$3,active_heartbeat_at=NOW() WHERE scan_id=$1`, id, target-reserved, target)
	if e != nil {
		return e
	}
	return tx.Commit(ctx)
}
func (r *Repository) EndDiscoveryAdmission(ctx context.Context, id string, epoch int64, elapsed time.Duration) error {
	tx, e := r.pool.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	var used, reserved int64
	var active bool
	e = tx.QueryRow(ctx, `SELECT active_ms_used,active_reserved_ms,active_started_at IS NOT NULL FROM scan_discoveries WHERE scan_id=$1 AND admission_epoch=$2 FOR UPDATE`, id, epoch).Scan(&used, &reserved, &active)
	if e != nil {
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrDiscoveryInvariant
		}
		return e
	}
	if !active {
		return ErrDiscoveryInvariant
	}
	actual := min(max(int64(0), elapsed.Milliseconds()), discoveryTailHorizonMS)
	if actual > reserved {
		return ErrDiscoveryInvariant
	}
	_, e = tx.Exec(ctx, `UPDATE scan_discoveries SET active_ms_used=active_ms_used-$2,active_started_at=NULL,active_reserved_ms=0,active_heartbeat_at=NULL WHERE scan_id=$1`, id, reserved-actual)
	if e != nil {
		return e
	}
	return tx.Commit(ctx)
}
func (r *Repository) ReserveDiscoveryRequest(ctx context.Context, id string, epoch int64) error {
	p, c := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer c()
	var n int
	e := r.pool.QueryRow(p, `UPDATE scan_discoveries SET requests_used=requests_used+1 WHERE scan_id=$1 AND admission_epoch=$2 AND phase IN ('fetch','probe') AND active_started_at IS NOT NULL AND requests_used<20000 RETURNING requests_used`, id, epoch).Scan(&n)
	if errors.Is(e, pgx.ErrNoRows) {
		var current int64
		var phase string
		var active bool
		var used int
		if check := r.pool.QueryRow(p, `SELECT admission_epoch,phase,active_started_at IS NOT NULL,requests_used FROM scan_discoveries WHERE scan_id=$1`, id).Scan(&current, &phase, &active, &used); check != nil {
			return check
		}
		if current != epoch || (phase != "fetch" && phase != "probe") || !active {
			return ErrDiscoveryInvariant
		}
		return ErrDiscoveryBudget
	}
	return e
}
func (r *Repository) ChargeDiscoveryXMLBytes(ctx context.Context, id string, epoch int64, n int64) error {
	if n < 0 {
		return ErrDiscoveryInvariant
	}
	if n == 0 {
		return nil
	}
	p, c := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer c()
	var used int64
	e := r.pool.QueryRow(p, `UPDATE scan_discoveries SET xml_bytes_used=xml_bytes_used+$2 WHERE scan_id=$1 AND admission_epoch=$3 AND phase='fetch' AND active_started_at IS NOT NULL AND xml_bytes_used+$2<=134217729 RETURNING xml_bytes_used`, id, n, epoch).Scan(&used)
	if errors.Is(e, pgx.ErrNoRows) {
		var current int64
		var phase string
		var active bool
		if check := r.pool.QueryRow(p, `SELECT admission_epoch,phase,active_started_at IS NOT NULL FROM scan_discoveries WHERE scan_id=$1`, id).Scan(&current, &phase, &active); check != nil {
			return check
		}
		if current != epoch || phase != "fetch" || !active {
			return ErrDiscoveryInvariant
		}
		return ErrDiscoveryBudget
	}
	if e != nil {
		return e
	}
	if used > discoveryMaxXMLBytes {
		return ErrDiscoveryBudget
	}
	return nil
}
func (r *Repository) NextDiscoverySitemap(ctx context.Context, id string, epoch int64) (*DiscoverySitemapTask, error) {
	var t DiscoverySitemapTask
	e := r.pool.QueryRow(ctx, `SELECT canonical_url,fetch_url,dfs_path,depth FROM scan_discovery_sitemaps WHERE scan_id=$1 AND state='queued' AND EXISTS(SELECT 1 FROM scan_discoveries WHERE scan_id=$1 AND admission_epoch=$2 AND active_started_at IS NOT NULL) ORDER BY dfs_path LIMIT 1`, id, epoch).Scan(&t.CanonicalURL, &t.FetchURL, &t.Path, &t.Depth)
	if errors.Is(e, pgx.ErrNoRows) {
		var current int64
		var phase string
		var active bool
		if check := r.pool.QueryRow(ctx, `SELECT admission_epoch,phase,active_started_at IS NOT NULL FROM scan_discoveries WHERE scan_id=$1`, id).Scan(&current, &phase, &active); check != nil {
			return nil, check
		}
		if current != epoch || phase != "fetch" || !active {
			return nil, ErrDiscoveryInvariant
		}
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	return &t, nil
}

// CommitDiscoverySitemap applies all entries and task completion atomically.
func (r *Repository) CommitDiscoverySitemap(ctx context.Context, id string, epoch int64, task DiscoverySitemapTask, doc DiscoveryDocument) error {
	tx, e := r.pool.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	var phase string
	var next int
	e = tx.QueryRow(ctx, `SELECT phase,next_candidate_ordinal FROM scan_discoveries WHERE scan_id=$1 AND admission_epoch=$2 AND active_started_at IS NOT NULL FOR UPDATE`, id, epoch).Scan(&phase, &next)
	if e != nil {
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrDiscoveryInvariant
		}
		return e
	}
	if phase != "fetch" {
		return ErrDiscoveryInvariant
	}
	var state, key string
	e = tx.QueryRow(ctx, `SELECT state,canonical_url FROM scan_discovery_sitemaps WHERE scan_id=$1 AND dfs_path=$2 FOR UPDATE`, id, task.Path).Scan(&state, &key)
	if e != nil {
		return e
	}
	if state != "queued" || key != task.CanonicalURL {
		return ErrDiscoveryInvariant
	}
	if doc.IsIndex {
		if len(doc.Candidates) != 0 {
			return ErrDiscoveryInvariant
		}
		for _, ch := range doc.Children {
			if ch.EntryIndex < 0 || ch.EntryIndex > math.MaxInt32 || ch.CanonicalURL == "" || ch.FetchURL == "" {
				return ErrDiscoveryInvariant
			}
			path := append(append([]int32{}, task.Path...), int32(ch.EntryIndex))
			if len(path) > 11 {
				return ErrDiscoveryBudget
			}
			rows, er := tx.Query(ctx, `SELECT canonical_url,dfs_path,state FROM scan_discovery_sitemaps WHERE scan_id=$1 AND canonical_hash=$2`, id, discoveryHash(ch.CanonicalURL))
			if er != nil {
				return er
			}
			found := false
			var old []int32
			var oldState string
			for rows.Next() {
				var k, s string
				var p []int32
				if er = rows.Scan(&k, &p, &s); er != nil {
					break
				}
				if k == ch.CanonicalURL {
					found = true
					old = p
					oldState = s
					break
				}
			}
			if er == nil {
				er = rows.Err()
			}
			rows.Close()
			if er != nil {
				return er
			}
			if found {
				if oldState == "queued" && earlierDiscoveryPath(path, old) {
					_, er = tx.Exec(ctx, `UPDATE scan_discovery_sitemaps SET dfs_path=$3,depth=$4,fetch_url=$5 WHERE scan_id=$1 AND dfs_path=$2`, id, old, path, len(path), ch.FetchURL)
					if er != nil {
						return er
					}
				}
				continue
			}
			_, er = tx.Exec(ctx, `INSERT INTO scan_discovery_sitemaps(scan_id,canonical_url,canonical_hash,fetch_url,dfs_path,depth) VALUES($1,$2,$3,$4,$5,$6)`, id, ch.CanonicalURL, discoveryHash(ch.CanonicalURL), ch.FetchURL, path, len(path))
			if er != nil {
				return er
			}
		}
	} else {
		if len(doc.Children) != 0 {
			return ErrDiscoveryInvariant
		}
		for _, raw := range doc.Candidates {
			raw = strings.TrimSpace(raw)
			if raw == "" {
				continue
			}
			rows, er := tx.Query(ctx, `SELECT raw_url FROM scan_discovery_candidates WHERE scan_id=$1 AND raw_hash=$2`, id, discoveryHash(raw))
			if er != nil {
				return er
			}
			found := false
			for rows.Next() {
				var k string
				if er = rows.Scan(&k); er != nil {
					break
				}
				if k == raw {
					found = true
					break
				}
			}
			if er == nil {
				er = rows.Err()
			}
			rows.Close()
			if er != nil {
				return er
			}
			if found {
				continue
			}
			if next >= discoveryMaxCandidates {
				return ErrDiscoveryBudget
			}
			_, er = tx.Exec(ctx, `INSERT INTO scan_discovery_candidates(scan_id,raw_url,raw_hash,ordinal) VALUES($1,$2,$3,$4)`, id, raw, discoveryHash(raw), next)
			if er != nil {
				return er
			}
			next++
		}
		_, e = tx.Exec(ctx, `UPDATE scan_discoveries SET next_candidate_ordinal=$2 WHERE scan_id=$1`, id, next)
		if e != nil {
			return e
		}
	}
	_, e = tx.Exec(ctx, `UPDATE scan_discovery_sitemaps SET state='done' WHERE scan_id=$1 AND dfs_path=$2`, id, task.Path)
	if e != nil {
		return e
	}
	return tx.Commit(ctx)
}
func (r *Repository) FailDiscoverySitemap(ctx context.Context, id string, epoch int64, task DiscoverySitemapTask, kind string) error {
	switch kind {
	case "invalid_url", "authority", "depth", "fetch", "xml":
	default:
		return ErrDiscoveryInvariant
	}
	tx, e := r.pool.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	var phase string
	e = tx.QueryRow(ctx, `SELECT phase FROM scan_discoveries WHERE scan_id=$1 AND admission_epoch=$2 AND active_started_at IS NOT NULL FOR UPDATE`, id, epoch).Scan(&phase)
	if e != nil {
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrDiscoveryInvariant
		}
		return e
	}
	if phase != "fetch" {
		return ErrDiscoveryInvariant
	}
	tag, e := tx.Exec(ctx, `UPDATE scan_discovery_sitemaps SET state='failed',failure_kind=$4 WHERE scan_id=$1 AND dfs_path=$2 AND canonical_url=$3 AND state='queued'`, id, task.Path, task.CanonicalURL, kind)
	if e != nil {
		return e
	}
	if tag.RowsAffected() != 1 {
		return ErrDiscoveryInvariant
	}
	return tx.Commit(ctx)
}
func (r *Repository) BeginDiscoveryProbes(ctx context.Context, id string, epoch int64) (bool, error) {
	tx, e := r.pool.Begin(ctx)
	if e != nil {
		return false, e
	}
	defer tx.Rollback(ctx)
	var phase string
	e = tx.QueryRow(ctx, `SELECT phase FROM scan_discoveries WHERE scan_id=$1 AND admission_epoch=$2 AND active_started_at IS NOT NULL FOR UPDATE`, id, epoch).Scan(&phase)
	if e != nil {
		if errors.Is(e, pgx.ErrNoRows) {
			return false, ErrDiscoveryInvariant
		}
		return false, e
	}
	if phase == "probe" {
		return true, nil
	}
	if phase != "fetch" {
		return false, ErrDiscoveryInvariant
	}
	var queued, failed int
	e = tx.QueryRow(ctx, `SELECT COUNT(*) FILTER(WHERE state='queued'),COUNT(*) FILTER(WHERE state='failed') FROM scan_discovery_sitemaps WHERE scan_id=$1`, id).Scan(&queued, &failed)
	if e != nil {
		return false, e
	}
	if failed > 0 {
		return false, ErrDiscoveryNestedFailure
	}
	if queued > 0 {
		return false, nil
	}
	_, e = tx.Exec(ctx, `UPDATE scan_discoveries SET phase='probe' WHERE scan_id=$1`, id)
	if e != nil {
		return false, e
	}
	if e = tx.Commit(ctx); e != nil {
		return false, e
	}
	return true, nil
}
func (r *Repository) PendingDiscoveryCandidates(ctx context.Context, id string, epoch int64, limit int) ([]DiscoveryCandidate, error) {
	if limit < 1 || limit > 10000 {
		return nil, ErrDiscoveryInvariant
	}
	rows, e := r.pool.Query(ctx, `SELECT raw_url,ordinal FROM scan_discovery_candidates WHERE scan_id=$1 AND outcome='pending' AND EXISTS(SELECT 1 FROM scan_discoveries WHERE scan_id=$1 AND admission_epoch=$3 AND active_started_at IS NOT NULL) ORDER BY ordinal LIMIT $2`, id, limit, epoch)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []DiscoveryCandidate{}
	for rows.Next() {
		var c DiscoveryCandidate
		if e = rows.Scan(&c.RawURL, &c.Ordinal); e != nil {
			return nil, e
		}
		out = append(out, c)
	}
	return out, rows.Err()
}
func (r *Repository) SaveDiscoveryProbe(ctx context.Context, id string, epoch int64, result DiscoveryProbeOutcome) error {
	if result.Outcome != "eligible" && result.Outcome != "external" && result.Outcome != "unresolved" {
		return ErrDiscoveryInvariant
	}
	if (result.Outcome == "eligible") != (result.FinalURL != "") {
		return ErrDiscoveryInvariant
	}
	tx, e := r.pool.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	var phase string
	e = tx.QueryRow(ctx, `SELECT phase FROM scan_discoveries WHERE scan_id=$1 AND admission_epoch=$2 AND active_started_at IS NOT NULL FOR UPDATE`, id, epoch).Scan(&phase)
	if e != nil {
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrDiscoveryInvariant
		}
		return e
	}
	if phase != "probe" {
		return ErrDiscoveryInvariant
	}
	var raw, current string
	e = tx.QueryRow(ctx, `SELECT raw_url,outcome FROM scan_discovery_candidates WHERE scan_id=$1 AND ordinal=$2`, id, result.Ordinal).Scan(&raw, &current)
	if e != nil {
		return e
	}
	if raw != result.RawURL {
		return ErrDiscoveryInvariant
	}
	if current != "pending" {
		return nil
	}
	var final any
	if result.FinalURL != "" {
		final = result.FinalURL
	}
	_, e = tx.Exec(ctx, `UPDATE scan_discovery_candidates SET outcome=$3,final_url=$4,redirected=$5 WHERE scan_id=$1 AND ordinal=$2`, id, result.Ordinal, result.Outcome, final, result.Redirected)
	if e != nil {
		return e
	}
	return tx.Commit(ctx)
}
func (r *Repository) PublishDiscoveryComplete(ctx context.Context, id string, epoch int64) ([]models.URL, error) {
	tx, e := r.pool.Begin(ctx)
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(ctx)
	var kind string
	var total, scanned int
	e = tx.QueryRow(ctx, `SELECT scan_type,total_urls,scanned_urls FROM scans WHERE id=$1 FOR UPDATE`, id).Scan(&kind, &total, &scanned)
	if e != nil {
		return nil, e
	}
	if kind == "single" {
		return nil, ErrDiscoveryInvariant
	}
	var phase string
	var active bool
	e = tx.QueryRow(ctx, `SELECT phase,active_started_at IS NOT NULL FROM scan_discoveries WHERE scan_id=$1 AND admission_epoch=$2 FOR UPDATE`, id, epoch).Scan(&phase, &active)
	if e != nil {
		if errors.Is(e, pgx.ErrNoRows) {
			return nil, ErrDiscoveryInvariant
		}
		return nil, e
	}
	if phase == "complete" {
		rows, er := tx.Query(ctx, `SELECT u.id,u.scan_id,u.url,u.status,u.created_at FROM urls u WHERE u.scan_id=$1 ORDER BY (SELECT MIN(c.ordinal) FROM scan_discovery_candidates c WHERE c.scan_id=$1 AND c.outcome='eligible' AND c.final_url=u.url),u.id`, id)
		if er != nil {
			return nil, er
		}
		defer rows.Close()
		out := []models.URL{}
		for rows.Next() {
			var u models.URL
			if er = rows.Scan(&u.ID, &u.ScanID, &u.URL, &u.Status, &u.CreatedAt); er != nil {
				return nil, er
			}
			out = append(out, u)
		}
		if er = rows.Err(); er != nil {
			return nil, er
		}
		if len(out) == 0 || len(out) != total {
			return nil, ErrDiscoveryInvariant
		}
		return out, nil
	}
	if phase != "probe" || !active || total != 0 || scanned != 0 {
		return nil, ErrDiscoveryInvariant
	}
	var unfinished int
	e = tx.QueryRow(ctx, `SELECT (SELECT COUNT(*) FROM scan_discovery_sitemaps WHERE scan_id=$1 AND state!='done')+(SELECT COUNT(*) FROM scan_discovery_candidates WHERE scan_id=$1 AND outcome='pending')`, id).Scan(&unfinished)
	if e != nil {
		return nil, e
	}
	if unfinished != 0 {
		return nil, ErrDiscoveryInvariant
	}
	rows, e := tx.Query(ctx, `SELECT final_url FROM scan_discovery_candidates WHERE scan_id=$1 AND outcome='eligible' ORDER BY ordinal`, id)
	if e != nil {
		return nil, e
	}
	final := []string{}
	seen := map[string]bool{}
	for rows.Next() {
		var u string
		if e = rows.Scan(&u); e != nil {
			break
		}
		if !seen[u] {
			seen[u] = true
			final = append(final, u)
		}
	}
	if e == nil {
		e = rows.Err()
	}
	rows.Close()
	if e != nil {
		return nil, e
	}
	if len(final) == 0 {
		return nil, ErrDiscoveryNoURLs
	}
	out := make([]models.URL, 0, len(final))
	for _, u := range final {
		var rec models.URL
		e = tx.QueryRow(ctx, `INSERT INTO urls(scan_id,url,status) VALUES($1,$2,'pending') RETURNING id,scan_id,url,status,created_at`, id, u).Scan(&rec.ID, &rec.ScanID, &rec.URL, &rec.Status, &rec.CreatedAt)
		if e != nil {
			return nil, fmt.Errorf("insert discovered URL: %w", e)
		}
		out = append(out, rec)
	}
	_, e = tx.Exec(ctx, `UPDATE scans SET total_urls=$2,updated_at=NOW() WHERE id=$1`, id, len(out))
	if e != nil {
		return nil, e
	}
	_, e = tx.Exec(ctx, `UPDATE scan_discoveries SET phase='complete' WHERE scan_id=$1`, id)
	if e != nil {
		return nil, e
	}
	if e = tx.Commit(ctx); e != nil {
		return nil, e
	}
	return out, nil
}

// RequeueDiscoveryProfiling gives a yielded scan its queue place, or finalizes
// a requested pause. A stale admission cannot change a newer scan.
func (r *Repository) RequeueDiscoveryProfiling(ctx context.Context, id string, epoch int64) (string, error) {
	tx, e := r.pool.Begin(ctx)
	if e != nil {
		return "", e
	}
	defer tx.Rollback(ctx)
	var status string
	var pause bool
	e = tx.QueryRow(ctx, `SELECT status,pause_requested FROM scans WHERE id=$1 FOR UPDATE`, id).Scan(&status, &pause)
	if e != nil {
		return "", e
	}
	if status != "profiling" {
		return "", ErrDiscoveryInvariant
	}
	var current int64
	e = tx.QueryRow(ctx, `SELECT admission_epoch FROM scan_discoveries WHERE scan_id=$1 FOR UPDATE`, id).Scan(&current)
	if e != nil {
		return "", e
	}
	if current != epoch {
		return "", ErrDiscoveryInvariant
	}
	next := "pending"
	if pause {
		next = "paused"
	}
	_, e = tx.Exec(ctx, `UPDATE scans SET status=$2,pause_requested=FALSE,updated_at=NOW() WHERE id=$1`, id, next)
	if e != nil {
		return "", e
	}
	return next, tx.Commit(ctx)
}
func (r *Repository) FailDiscoveryProfiling(ctx context.Context, id string, epoch int64) error {
	tx, e := r.pool.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	var status string
	e = tx.QueryRow(ctx, `SELECT status FROM scans WHERE id=$1 FOR UPDATE`, id).Scan(&status)
	if e != nil {
		return e
	}
	if status != "profiling" {
		return ErrDiscoveryInvariant
	}
	var current int64
	e = tx.QueryRow(ctx, `SELECT admission_epoch FROM scan_discoveries WHERE scan_id=$1 FOR UPDATE`, id).Scan(&current)
	if e != nil {
		return e
	}
	if current != epoch {
		return ErrDiscoveryInvariant
	}
	_, e = tx.Exec(ctx, `UPDATE scans SET status='failed',pause_requested=FALSE,updated_at=NOW() WHERE id=$1`, id)
	if e != nil {
		return e
	}
	return tx.Commit(ctx)
}
func (r *Repository) CompleteDiscoveryProfiling(ctx context.Context, id string, epoch int64) (string, error) {
	tx, e := r.pool.Begin(ctx)
	if e != nil {
		return "", e
	}
	defer tx.Rollback(ctx)
	var status string
	var pause bool
	var total int
	e = tx.QueryRow(ctx, `SELECT status,pause_requested,total_urls FROM scans WHERE id=$1 FOR UPDATE`, id).Scan(&status, &pause, &total)
	if e != nil {
		return "", e
	}
	if status != "profiling" {
		return "", ErrDiscoveryInvariant
	}
	var phase string
	var current int64
	e = tx.QueryRow(ctx, `SELECT phase,admission_epoch FROM scan_discoveries WHERE scan_id=$1 FOR UPDATE`, id).Scan(&phase, &current)
	if e != nil {
		return "", e
	}
	if current != epoch || phase != "complete" {
		return "", ErrDiscoveryInvariant
	}
	var count int
	e = tx.QueryRow(ctx, `SELECT COUNT(*) FROM urls WHERE scan_id=$1`, id).Scan(&count)
	if e != nil {
		return "", e
	}
	if count == 0 || count != total {
		return "", ErrDiscoveryInvariant
	}
	next := "scanning"
	if pause {
		next = "paused"
	}
	_, e = tx.Exec(ctx, `UPDATE scans SET status=$2,pause_requested=FALSE,updated_at=NOW() WHERE id=$1`, id, next)
	if e != nil {
		return "", e
	}
	return next, tx.Commit(ctx)
}

// StartReadyPageScanning handles a crash after atomic publication and also
// historical scans whose saved URLs predate the checkpoint table.
func (r *Repository) StartReadyPageScanning(ctx context.Context, id string) (string, error) {
	tx, e := r.pool.Begin(ctx)
	if e != nil {
		return "", e
	}
	defer tx.Rollback(ctx)
	var status, kind string
	var pause bool
	var total int
	e = tx.QueryRow(ctx, `SELECT status,scan_type,pause_requested,total_urls FROM scans WHERE id=$1 FOR UPDATE`, id).Scan(&status, &kind, &pause, &total)
	if e != nil {
		return "", e
	}
	if status != "pending" || kind == "single" {
		return "", ErrDiscoveryInvariant
	}
	var phase *string
	e = tx.QueryRow(ctx, `SELECT phase FROM scan_discoveries WHERE scan_id=$1 FOR UPDATE`, id).Scan(&phase)
	if errors.Is(e, pgx.ErrNoRows) {
		phase = nil
	} else if e != nil {
		return "", e
	}
	if phase != nil && *phase != "complete" {
		return "", ErrDiscoveryInvariant
	}
	var count int
	e = tx.QueryRow(ctx, `SELECT COUNT(*) FROM urls WHERE scan_id=$1`, id).Scan(&count)
	if e != nil {
		return "", e
	}
	if count == 0 || count != total {
		return "", ErrDiscoveryInvariant
	}
	next := "scanning"
	if pause {
		next = "paused"
	}
	_, e = tx.Exec(ctx, `UPDATE scans SET status=$2,pause_requested=FALSE,updated_at=NOW() WHERE id=$1`, id, next)
	if e != nil {
		return "", e
	}
	return next, tx.Commit(ctx)
}

// RecoverLegacyProfilingURLs preserves a historical scan-ready list that was
// saved before discovery checkpoints existed.
func (r *Repository) RecoverLegacyProfilingURLs(ctx context.Context, id string) (bool, error) {
	tx, e := r.pool.Begin(ctx)
	if e != nil {
		return false, e
	}
	defer tx.Rollback(ctx)
	var status string
	var pause bool
	e = tx.QueryRow(ctx, `SELECT status,pause_requested FROM scans WHERE id=$1 FOR UPDATE`, id).Scan(&status, &pause)
	if e != nil {
		return false, e
	}
	if status != "profiling" {
		return false, nil
	}
	var exists bool
	var count int
	e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM scan_discoveries WHERE scan_id=$1),(SELECT COUNT(*) FROM urls WHERE scan_id=$1)`, id).Scan(&exists, &count)
	if e != nil {
		return false, e
	}
	if exists || count == 0 {
		return false, nil
	}
	next := "pending"
	if pause {
		next = "paused"
	}
	_, e = tx.Exec(ctx, `UPDATE scans SET status=$2,pause_requested=FALSE,updated_at=NOW() WHERE id=$1`, id, next)
	if e != nil {
		return false, e
	}
	return true, tx.Commit(ctx)
}
