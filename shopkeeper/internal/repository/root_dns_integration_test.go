package repository

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/sumanbasuli/lime/shopkeeper/internal/viewport"
)

func TestRootDNSPolicyPersistsAcrossScanLifecycleAndCopiesSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	v, _ := viewport.ResolvePreset("")
	scan, err := r.CreateScanWithLinkCheck(ctx, "https://example.test/", "single", nil, v)
	if err != nil {
		t.Fatal(err)
	}
	job, err := r.GetScanLinkCheck(ctx, scan.ID)
	if err != nil || job == nil || scan.RootPublic || job.RootPublic {
		t.Fatalf("new policy = scan %+v, companion %+v, err %v", scan, job, err)
	}
	if err := r.ObserveScanRootDNS(ctx, scan.ID, true, false); err != nil {
		t.Fatal(err)
	}
	if err := r.ObserveLinkCheckRootDNS(ctx, job.ID, false, true); !errors.Is(err, ErrRootDNSBlocked) {
		t.Fatalf("companion accepted private DNS after public observation: %v", err)
	}
	if err := r.ObserveScanRootDNS(ctx, scan.ID, true, true); !errors.Is(err, ErrRootDNSBlocked) {
		t.Fatalf("mixed root DNS was not blocked: %v", err)
	}
	if err := r.ResetScan(ctx, scan.ID); err != nil {
		t.Fatal(err)
	}
	if err := r.UpdateScanStatus(ctx, scan.ID, "paused"); err != nil {
		t.Fatal(err)
	}
	resumed, err := r.ResumeScan(ctx, scan.ID)
	if err != nil || resumed == nil || !resumed.RootPublic {
		t.Fatalf("resume lost public policy: %+v %v", resumed, err)
	}
	job, err = r.GetScanLinkCheck(ctx, scan.ID)
	if err != nil || job == nil || !job.RootPublic {
		t.Fatalf("companion lost public policy: %+v %v", job, err)
	}
	if _, err := r.CreateRescanFrom(ctx, scan.ID); !errors.Is(err, ErrRescanNotReady) {
		t.Fatalf("active scan could be rescanned: %v", err)
	}
	if _, err := r.CreateRescanFrom(ctx, mcpOtherScanID); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("missing source scan error = %v", err)
	}
	if err := r.UpdateScanStatus(ctx, scan.ID, "completed"); err != nil {
		t.Fatal(err)
	}
	rescan, err := r.CreateRescanFrom(ctx, scan.ID)
	if err != nil || rescan == nil || !rescan.RootPublic || !rescan.IncludeLinkCheck {
		t.Fatalf("rescan policy = %+v, err %v", rescan, err)
	}
	rescanJob, err := r.GetScanLinkCheck(ctx, rescan.ID)
	if err != nil || rescanJob == nil || !rescanJob.RootPublic {
		t.Fatalf("rescan companion policy = %+v, err %v", rescanJob, err)
	}
	if _, err := r.CreateLinkCheckFrom(ctx, job.ID); !errors.Is(err, ErrRecheckNotReady) {
		t.Fatalf("active source job could be rechecked: %v", err)
	}
	if _, err := r.CancelLinkCheck(ctx, job.ID); err != nil {
		t.Fatal(err)
	}
	recheck, err := r.CreateLinkCheckFrom(ctx, job.ID)
	if err != nil || recheck == nil || recheck.ScanID != nil || !recheck.RootPublic {
		t.Fatalf("detached recheck policy = %+v, err %v", recheck, err)
	}
	if err := r.ObserveLinkCheckRootDNS(ctx, recheck.ID, false, true); !errors.Is(err, ErrRootDNSBlocked) {
		t.Fatalf("detached recheck accepted private DNS: %v", err)
	}
	encoded, err := json.Marshal(rescan)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "root_public") {
		t.Fatalf("internal policy leaked in scan JSON: %s", encoded)
	}
	encoded, err = json.Marshal(recheck)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "root_public") {
		t.Fatalf("internal policy leaked in link-check JSON: %s", encoded)
	}
}

func TestRootDNSPolicySharesCompanionAndSerializesObservationsSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	v, _ := viewport.ResolvePreset("")
	scan, err := r.CreateScanWithLinkCheck(ctx, "https://example.test/", "single", nil, v)
	if err != nil {
		t.Fatal(err)
	}
	job, err := r.GetScanLinkCheck(ctx, scan.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := r.ObserveLinkCheckRootDNS(ctx, job.ID, false, true); err != nil {
		t.Fatalf("first private observation should preserve prior eligibility: %v", err)
	}
	if err := r.ObserveLinkCheckRootDNS(ctx, job.ID, true, false); err != nil {
		t.Fatal(err)
	}
	if err := r.ObserveScanRootDNS(ctx, scan.ID, false, true); !errors.Is(err, ErrRootDNSBlocked) {
		t.Fatalf("scan accepted private DNS after companion became public: %v", err)
	}
	updated, err := r.GetScan(ctx, scan.ID)
	if err != nil || updated == nil || !updated.RootPublic {
		t.Fatalf("companion did not mark parent: %+v %v", updated, err)
	}
	mixed, err := r.CreateScanWithLinkCheck(ctx, "https://example.test/mixed", "single", nil, v)
	if err != nil {
		t.Fatal(err)
	}
	if err := r.ObserveScanRootDNS(ctx, mixed.ID, true, true); !errors.Is(err, ErrRootDNSBlocked) {
		t.Fatalf("mixed root DNS observation = %v", err)
	}
	mixedJob, err := r.GetScanLinkCheck(ctx, mixed.ID)
	if err != nil || mixedJob == nil || !mixedJob.RootPublic {
		t.Fatalf("mixed observation did not persist companion policy: %+v %v", mixedJob, err)
	}
	if err := r.ObserveLinkCheckRootDNS(ctx, mixedJob.ID, false, true); !errors.Is(err, ErrRootDNSBlocked) {
		t.Fatalf("private lookup after mixed observation = %v", err)
	}

	second, err := r.CreateScanWithLinkCheck(ctx, "https://example.test/second", "single", nil, v)
	if err != nil {
		t.Fatal(err)
	}
	secondJob, err := r.GetScanLinkCheck(ctx, second.ID)
	if err != nil {
		t.Fatal(err)
	}
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `UPDATE scans SET root_public=TRUE WHERE id=$1`, second.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `UPDATE link_checks SET root_public=TRUE WHERE id=$1`, secondJob.ID); err != nil {
		t.Fatal(err)
	}
	observeCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- r.ObserveLinkCheckRootDNS(observeCtx, secondJob.ID, false, true) }()
	select {
	case err := <-done:
		t.Fatalf("observation bypassed uncommitted parent policy: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if !errors.Is(err, ErrRootDNSBlocked) {
			t.Fatalf("observation after public commit = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("observation remained blocked after public commit")
	}
}

func TestRootDNSPrivateDialLeasesSerializePublicObservationSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	v, _ := viewport.ResolvePreset("")
	scan, err := r.CreateScanWithLinkCheck(ctx, "https://example.test/private-dial", "single", nil, v)
	if err != nil {
		t.Fatal(err)
	}
	job, err := r.GetScanLinkCheck(ctx, scan.ID)
	if err != nil || job == nil {
		t.Fatalf("get companion: %+v, %v", job, err)
	}

	dialCtx, cancelDial := context.WithCancel(ctx)
	releaseScan, err := r.GuardScanPrivateRootDial(dialCtx, scan.ID)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(releaseScan)
	releaseJob, err := r.GuardLinkCheckPrivateRootDial(ctx, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(releaseJob)
	cancelDial() // release must work even after its caller's context is canceled.

	observeCtx, cancelObserve := context.WithTimeout(ctx, 5*time.Second)
	defer cancelObserve()
	done := make(chan error, 1)
	go func() { done <- r.ObserveLinkCheckRootDNS(observeCtx, job.ID, true, false) }()
	waiting := func(stage string) {
		t.Helper()
		select {
		case err := <-done:
			t.Fatalf("public observation completed while %s lease was active: %v", stage, err)
		case <-time.After(50 * time.Millisecond):
		}
	}
	waiting("scan and link-check")
	releaseScan()
	releaseScan() // Releasing more than once must not affect the other lease.
	waiting("link-check")
	releaseJob()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("public observation after releases: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("public observation remained blocked after releases")
	}

	if release, err := r.GuardScanPrivateRootDial(ctx, scan.ID); !errors.Is(err, ErrRootDNSBlocked) {
		if release != nil {
			release()
		}
		t.Fatalf("scan private dial after public observation = %v", err)
	}
	if release, err := r.GuardLinkCheckPrivateRootDial(ctx, job.ID); !errors.Is(err, ErrRootDNSBlocked) {
		if release != nil {
			release()
		}
		t.Fatalf("link-check private dial after public observation = %v", err)
	}
}

func TestRootDNSPrivateDialGuardReleasesPartialLocksOnCancelSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	v, _ := viewport.ResolvePreset("")
	scan, err := r.CreateScanWithLinkCheck(ctx, "https://example.test/canceled-dial", "single", nil, v)
	if err != nil {
		t.Fatal(err)
	}
	job, err := r.GetScanLinkCheck(ctx, scan.ID)
	if err != nil || job == nil {
		t.Fatalf("get companion: %+v, %v", job, err)
	}

	tx, err := r.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	var jobPublic bool
	if err := tx.QueryRow(ctx, `SELECT root_public FROM link_checks WHERE id=$1 FOR UPDATE`, job.ID).Scan(&jobPublic); err != nil {
		t.Fatal(err)
	}
	guardCtx, cancelGuard := context.WithCancel(ctx)
	defer cancelGuard()
	guardDone := make(chan error, 1)
	go func() {
		release, err := r.GuardScanPrivateRootDial(guardCtx, scan.ID)
		if release != nil {
			release()
		}
		guardDone <- err
	}()
	lockDeadline := time.After(3 * time.Second)
	for {
		var scanPublic bool
		probeErr := r.pool.QueryRow(ctx, `SELECT root_public FROM scans WHERE id=$1 FOR UPDATE NOWAIT`, scan.ID).
			Scan(&scanPublic)
		var pgErr *pgconn.PgError
		if errors.As(probeErr, &pgErr) && pgErr.Code == "55P03" {
			break // The guard holds the scan row while waiting for the companion.
		}
		if probeErr != nil {
			t.Fatalf("probe guard's scan lock: %v", probeErr)
		}
		select {
		case err := <-guardDone:
			t.Fatalf("guard completed before acquiring the companion lock: %v", err)
		case <-lockDeadline:
			t.Fatal("guard did not acquire the scan lock")
		case <-time.After(10 * time.Millisecond):
		}
	}
	cancelGuard()
	select {
	case err := <-guardDone:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("canceled guard waiting on companion lock = %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("canceled guard did not release its partial lock")
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	observeCtx, cancelObserve := context.WithTimeout(ctx, 3*time.Second)
	defer cancelObserve()
	if err := r.ObserveScanRootDNS(observeCtx, scan.ID, true, false); err != nil {
		t.Fatalf("partial guard lock survived cancellation: %v", err)
	}
}

func TestRootDNSPolicyMigrationBackfillsLegacyHostnamesSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	down, err := os.ReadFile("../../migrations/000016_add_root_dns_policy.down.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.pool.Exec(ctx, string(down)); err != nil {
		t.Fatal(err)
	}
	insertScan := func(target, companionTarget string) string {
		t.Helper()
		var id string
		if err := r.pool.QueryRow(ctx, `INSERT INTO scans(sitemap_url,scan_type,include_link_check)
			VALUES ($1,'single',TRUE) RETURNING id`, target).Scan(&id); err != nil {
			t.Fatal(err)
		}
		if _, err := r.pool.Exec(ctx, `INSERT INTO link_checks(scan_id,url,check_type,max_pages)
			VALUES ($1,$2,'scan',500)`, id, companionTarget); err != nil {
			t.Fatal(err)
		}
		return id
	}
	hostnameID := insertScan("https://example.test/", "https://example.test/")
	ambiguousIPv4ID := insertScan("http://01.2.3.4/", "http://01.2.3.4/")
	invalidIPv6ID := insertScan("http://[1:2]/", "http://[1:2]/")
	ambiguousMappedIPv6ID := insertScan("http://[::ffff:1.2]/", "http://[::ffff:1.2]/")
	dottedMappedIPv6ID := insertScan("http://[::ffff:127.0.0.1]/", "http://[::ffff:127.0.0.1]/")
	privateIPID := insertScan("http://127.0.0.1/", "http://127.0.0.1/")
	ipv6ID := insertScan("http://[fd00::1]/", "http://[fd00::1]/")
	privateScanPublicCompanionID := insertScan("http://127.0.0.1/", "https://companion.example.test/")
	publicScanPrivateCompanionID := insertScan("https://parent.example.test/", "http://127.0.0.1/")
	var detachedHostnameID string
	if err := r.pool.QueryRow(ctx, `INSERT INTO link_checks(url,check_type,max_pages)
		VALUES ('https://other.example.test/','single',1) RETURNING id`).Scan(&detachedHostnameID); err != nil {
		t.Fatal(err)
	}
	up, err := os.ReadFile("../../migrations/000016_add_root_dns_policy.up.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.pool.Exec(ctx, string(up)); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range []struct {
		id   string
		want bool
	}{
		{hostnameID, true},
		{ambiguousIPv4ID, true},
		{invalidIPv6ID, true},
		{ambiguousMappedIPv6ID, true},
		{dottedMappedIPv6ID, true},
		{privateIPID, false},
		{ipv6ID, false},
		{privateScanPublicCompanionID, true},
		{publicScanPrivateCompanionID, true},
	} {
		scan, err := r.GetScan(ctx, fixture.id)
		if err != nil || scan == nil || scan.RootPublic != fixture.want {
			t.Fatalf("migrated scan %s = %+v, err %v", fixture.id, scan, err)
		}
		job, err := r.GetScanLinkCheck(ctx, fixture.id)
		if err != nil || job == nil || job.RootPublic != fixture.want {
			t.Fatalf("migrated companion %s = %+v, err %v", fixture.id, job, err)
		}
	}
	detached, err := r.GetLinkCheck(ctx, detachedHostnameID)
	if err != nil || detached == nil || !detached.RootPublic {
		t.Fatalf("legacy detached hostname = %+v, err %v", detached, err)
	}
	// Simulate an old backend still writing during a rolling migration. Its
	// inserts omit the new column and must be conservative even for IP targets.
	for _, id := range []string{
		insertScan("https://late.example.test/", "https://late.example.test/"),
		insertScan("http://127.0.0.1/", "http://127.0.0.1/"),
	} {
		scan, err := r.GetScan(ctx, id)
		if err != nil || scan == nil || !scan.RootPublic {
			t.Fatalf("old-writer scan after migration = %+v, err %v", scan, err)
		}
		job, err := r.GetScanLinkCheck(ctx, id)
		if err != nil || job == nil || !job.RootPublic {
			t.Fatalf("old-writer companion after migration = %+v, err %v", job, err)
		}
	}
	v, _ := viewport.ResolvePreset("")
	newScan, err := r.CreateScan(ctx, "https://new.example.test/", "single", nil, v)
	if err != nil || newScan == nil || newScan.RootPublic {
		t.Fatalf("new scan default policy = %+v, err %v", newScan, err)
	}
	newJob, err := r.CreateLinkCheck(ctx, "https://new.example.test/", "single", 1, nil)
	if err != nil || newJob == nil || newJob.RootPublic {
		t.Fatalf("new job default policy = %+v, err %v", newJob, err)
	}
	newPairedScan, err := r.CreateScanWithLinkCheck(ctx, "https://new-paired.example.test/", "single", nil, v)
	if err != nil || newPairedScan == nil || newPairedScan.RootPublic {
		t.Fatalf("new paired scan default policy = %+v, err %v", newPairedScan, err)
	}
	newPairedJob, err := r.GetScanLinkCheck(ctx, newPairedScan.ID)
	if err != nil || newPairedJob == nil || newPairedJob.RootPublic {
		t.Fatalf("new paired job default policy = %+v, err %v", newPairedJob, err)
	}
}
