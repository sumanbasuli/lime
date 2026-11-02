package repository

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

const discoveryTestID = "77777777-7777-4777-8777-777777777777"

func discoveryFixture(t *testing.T) (*Repository, context.Context, DiscoveryAdmission, DiscoverySitemapTask) {
	t.Helper()
	r, ctx := mcpTestRepository(t)
	execMCPFixture(t, r, ctx, `INSERT INTO scans(id,sitemap_url,status,scan_type) VALUES($1,'https://fixture.test/root.xml','pending','sitemap')`, discoveryTestID)
	s, e := r.LoadOrCreateDiscovery(ctx, discoveryTestID, "https://fixture.test/root.xml")
	if e != nil || s.Phase != "fetch" {
		t.Fatalf("load %v %+v", e, s)
	}
	a, e := r.StartDiscoveryAdmission(ctx, discoveryTestID)
	if e != nil {
		t.Fatal(e)
	}
	task, e := r.NextDiscoverySitemap(ctx, discoveryTestID, a.Epoch)
	if e != nil || task == nil {
		t.Fatalf("root %v %+v", e, task)
	}
	return r, ctx, a, *task
}
func TestDiscoveryDFSAndFullStringKeysSQL(t *testing.T) {
	r, ctx, a, root := discoveryFixture(t)
	long := strings.Repeat("a", 9000)
	aURL := "https://fixture.test/" + long + "A.xml"
	bURL := "https://fixture.test/" + long + "B.xml"
	doc := DiscoveryDocument{IsIndex: true, Children: []DiscoverySitemapTask{{CanonicalURL: aURL, FetchURL: aURL, EntryIndex: 0}, {CanonicalURL: bURL, FetchURL: bURL, EntryIndex: 2}}}
	if e := r.CommitDiscoverySitemap(ctx, discoveryTestID, a.Epoch, root, doc); e != nil {
		t.Fatal(e)
	}
	first, e := r.NextDiscoverySitemap(ctx, discoveryTestID, a.Epoch)
	if e != nil || first == nil || first.CanonicalURL != aURL {
		t.Fatalf("first %+v %v", first, e)
	}
	// B was queued at [2]; its earlier occurrence under A moves it to [0,1].
	if e = r.CommitDiscoverySitemap(ctx, discoveryTestID, a.Epoch, *first, DiscoveryDocument{IsIndex: true, Children: []DiscoverySitemapTask{{CanonicalURL: bURL, FetchURL: bURL, EntryIndex: 1}}}); e != nil {
		t.Fatal(e)
	}
	second, e := r.NextDiscoverySitemap(ctx, discoveryTestID, a.Epoch)
	if e != nil || second == nil || !sameDiscoveryPath(second.Path, []int32{0, 1}) {
		t.Fatalf("moved %+v %v", second, e)
	}
	// Long keys are indexed only by digest; full strings remain distinct.
	var count int
	if e = r.pool.QueryRow(ctx, `SELECT COUNT(*) FROM scan_discovery_sitemaps WHERE scan_id=$1`, discoveryTestID).Scan(&count); e != nil || count != 3 {
		t.Fatalf("count %d %v", count, e)
	}
}
func TestDiscoveryAtomicCandidateLimitAndPublishSQL(t *testing.T) {
	r, ctx, a, root := discoveryFixture(t)
	many := make([]string, 10001)
	for i := range many {
		many[i] = fmt.Sprintf("https://fixture.test/page/%d", i)
	}
	e := r.CommitDiscoverySitemap(ctx, discoveryTestID, a.Epoch, root, DiscoveryDocument{Candidates: many})
	if !errors.Is(e, ErrDiscoveryBudget) {
		t.Fatalf("want budget: %v", e)
	}
	var count int
	var state string
	e = r.pool.QueryRow(ctx, `SELECT COUNT(*) FROM scan_discovery_candidates WHERE scan_id=$1`, discoveryTestID).Scan(&count)
	if e != nil || count != 0 {
		t.Fatalf("partial candidates %d %v", count, e)
	}
	e = r.pool.QueryRow(ctx, `SELECT state FROM scan_discovery_sitemaps WHERE scan_id=$1`, discoveryTestID).Scan(&state)
	if e != nil || state != "queued" {
		t.Fatalf("task %s %v", state, e)
	}
	if e = r.CommitDiscoverySitemap(ctx, discoveryTestID, a.Epoch, root, DiscoveryDocument{Candidates: []string{"https://fixture.test/page/a", "https://fixture.test/page/b", "https://fixture.test/page/a"}}); e != nil {
		t.Fatal(e)
	}
	ready, e := r.BeginDiscoveryProbes(ctx, discoveryTestID, a.Epoch)
	if e != nil || !ready {
		t.Fatalf("probes %v %v", ready, e)
	}
	cs, e := r.PendingDiscoveryCandidates(ctx, discoveryTestID, a.Epoch, 10)
	if e != nil || len(cs) != 2 {
		t.Fatalf("pending %+v %v", cs, e)
	}
	for _, c := range cs {
		if e = r.SaveDiscoveryProbe(ctx, discoveryTestID, a.Epoch, DiscoveryProbeOutcome{Ordinal: c.Ordinal, RawURL: c.RawURL, Outcome: "eligible", FinalURL: "https://fixture.test/final"}); e != nil {
			t.Fatal(e)
		}
	}
	urls, e := r.PublishDiscoveryComplete(ctx, discoveryTestID, a.Epoch)
	if e != nil || len(urls) != 1 {
		t.Fatalf("publish %+v %v", urls, e)
	}
	again, e := r.PublishDiscoveryComplete(ctx, discoveryTestID, a.Epoch)
	if e != nil || len(again) != 1 {
		t.Fatalf("idempotent %+v %v", again, e)
	}
	scan, e := r.GetScan(ctx, discoveryTestID)
	if e != nil || scan.TotalURLs != 1 || scan.ScannedURLs != 0 {
		t.Fatalf("scan %+v %v", scan, e)
	}
}
func TestDiscoveryBudgetLeaseAndFencingSQL(t *testing.T) {
	r, ctx, a, _ := discoveryFixture(t)
	if e := r.EndDiscoveryAdmission(ctx, discoveryTestID, a.Epoch, 2*time.Second); e != nil {
		t.Fatal(e)
	}
	s, _, e := r.GetDiscoverySnapshot(ctx, discoveryTestID)
	if e != nil || s.ActiveMSUsed != 2000 {
		t.Fatalf("settled %+v %v", s, e)
	}
	state, e := r.RequeueDiscoveryProfiling(ctx, discoveryTestID, a.Epoch)
	if e != nil || state != "pending" {
		t.Fatalf("requeue %s %v", state, e)
	}
	b, e := r.StartDiscoveryAdmission(ctx, discoveryTestID)
	if e != nil || b.Epoch <= a.Epoch {
		t.Fatalf("new admission %+v %v", b, e)
	}
	if e = r.EndDiscoveryAdmission(ctx, discoveryTestID, a.Epoch, time.Second); !errors.Is(e, ErrDiscoveryInvariant) {
		t.Fatalf("stale end %v", e)
	}
	if e = r.ReserveDiscoveryRequest(ctx, discoveryTestID, b.Epoch); e != nil {
		t.Fatal(e)
	}
	if e = r.ChargeDiscoveryXMLBytes(ctx, discoveryTestID, b.Epoch, 10); e != nil {
		t.Fatal(e)
	}
	// Crash recovery discards the lease fields without refunding the reservation.
	ok, e := r.RecoverDiscoveryAdmission(ctx, discoveryTestID)
	if e != nil || !ok {
		t.Fatalf("recover %v %v", ok, e)
	}
	s, _, e = r.GetDiscoverySnapshot(ctx, discoveryTestID)
	if e != nil || s.ActiveMSUsed != 62000 {
		t.Fatalf("crash charge %+v %v", s, e)
	}
	if e = r.CommitDiscoverySitemap(ctx, discoveryTestID, b.Epoch, DiscoverySitemapTask{}, DiscoveryDocument{}); e == nil {
		t.Fatal("stale commit accepted")
	}
}

func TestDiscoveryExactBudgetBoundariesSQL(t *testing.T) {
	r, ctx, a, _ := discoveryFixture(t)
	execMCPFixture(t, r, ctx, `UPDATE scan_discoveries SET requests_used=19999,xml_bytes_used=134217727 WHERE scan_id=$1`, discoveryTestID)
	if e := r.ReserveDiscoveryRequest(ctx, discoveryTestID, a.Epoch); e != nil {
		t.Fatal(e)
	}
	if e := r.ReserveDiscoveryRequest(ctx, discoveryTestID, a.Epoch); !errors.Is(e, ErrDiscoveryBudget) {
		t.Fatalf("request boundary %v", e)
	}
	if e := r.ChargeDiscoveryXMLBytes(ctx, discoveryTestID, a.Epoch, 1); e != nil {
		t.Fatalf("exact XML boundary %v", e)
	}
	if e := r.ChargeDiscoveryXMLBytes(ctx, discoveryTestID, a.Epoch, 1); !errors.Is(e, ErrDiscoveryBudget) {
		t.Fatalf("XML sentinel %v", e)
	}
	var used int64
	if e := r.pool.QueryRow(ctx, `SELECT xml_bytes_used FROM scan_discoveries WHERE scan_id=$1`, discoveryTestID).Scan(&used); e != nil || used != 134217729 {
		t.Fatalf("persisted sentinel %d %v", used, e)
	}
	if e := r.ChargeDiscoveryXMLBytes(ctx, discoveryTestID, a.Epoch, 1); !errors.Is(e, ErrDiscoveryBudget) {
		t.Fatalf("XML over sentinel %v", e)
	}
}

func TestDiscoveryMigrationRoundTripAndCascadeSQL(t *testing.T) {
	r, ctx, _, _ := discoveryFixture(t)
	execMCPFixture(t, r, ctx, `DELETE FROM scans WHERE id=$1`, discoveryTestID)
	for _, table := range []string{"scan_discoveries", "scan_discovery_sitemaps", "scan_discovery_candidates"} {
		var n int
		if e := r.pool.QueryRow(ctx, `SELECT COUNT(*) FROM `+table+` WHERE scan_id=$1`, discoveryTestID).Scan(&n); e != nil || n != 0 {
			t.Fatalf("cascade %s %d %v", table, n, e)
		}
	}
	down, e := os.ReadFile("../../migrations/000020_add_discovery_checkpoints.down.sql")
	if e != nil {
		t.Fatal(e)
	}
	up, e := os.ReadFile("../../migrations/000020_add_discovery_checkpoints.up.sql")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = r.pool.Exec(ctx, string(down)); e != nil {
		t.Fatal(e)
	}
	if _, e = r.pool.Exec(ctx, string(up)); e != nil {
		t.Fatal(e)
	}
}

func TestDiscoveryTimeDoesNotDiscardEligibleWorkSQL(t *testing.T) {
	r, ctx, a, _ := discoveryFixture(t)
	if e := r.EndDiscoveryAdmission(ctx, discoveryTestID, a.Epoch, time.Second); e != nil {
		t.Fatal(e)
	}
	if _, e := r.RequeueDiscoveryProfiling(ctx, discoveryTestID, a.Epoch); e != nil {
		t.Fatal(e)
	}
	execMCPFixture(t, r, ctx, `UPDATE scan_discoveries SET active_ms_used=1800000 WHERE scan_id=$1`, discoveryTestID)
	b, e := r.StartDiscoveryAdmission(ctx, discoveryTestID)
	if e != nil || b.Remaining != 10*time.Minute {
		t.Fatalf("admission after 30m %+v %v", b, e)
	}
}

func TestDiscoveryReadyTransitionAndLegacyRecoverySQL(t *testing.T) {
	r, ctx, a, root := discoveryFixture(t)
	if e := r.CommitDiscoverySitemap(ctx, discoveryTestID, a.Epoch, root, DiscoveryDocument{Candidates: []string{"https://fixture.test/a"}}); e != nil {
		t.Fatal(e)
	}
	if _, e := r.BeginDiscoveryProbes(ctx, discoveryTestID, a.Epoch); e != nil {
		t.Fatal(e)
	}
	if e := r.SaveDiscoveryProbe(ctx, discoveryTestID, a.Epoch, DiscoveryProbeOutcome{Ordinal: 0, RawURL: "https://fixture.test/a", Outcome: "eligible", FinalURL: "https://fixture.test/a"}); e != nil {
		t.Fatal(e)
	}
	if _, e := r.PublishDiscoveryComplete(ctx, discoveryTestID, a.Epoch); e != nil {
		t.Fatal(e)
	}
	if e := r.EndDiscoveryAdmission(ctx, discoveryTestID, a.Epoch, time.Second); e != nil {
		t.Fatal(e)
	}
	if status, e := r.CompleteDiscoveryProfiling(ctx, discoveryTestID, a.Epoch); e != nil || status != "scanning" {
		t.Fatalf("complete %s %v", status, e)
	}
	// An interrupted complete scan is safe to resume through ready-page gate.
	execMCPFixture(t, r, ctx, `UPDATE scans SET status='pending' WHERE id=$1`, discoveryTestID)
	if status, e := r.StartReadyPageScanning(ctx, discoveryTestID); e != nil || status != "scanning" {
		t.Fatalf("ready %s %v", status, e)
	}
	const legacy = "88888888-8888-4888-8888-888888888888"
	execMCPFixture(t, r, ctx, `INSERT INTO scans(id,sitemap_url,status,scan_type,total_urls) VALUES($1,'https://fixture.test/legacy.xml','profiling','sitemap',1)`, legacy)
	execMCPFixture(t, r, ctx, `INSERT INTO urls(scan_id,url) VALUES($1,'https://fixture.test/legacy')`, legacy)
	if ok, e := r.RecoverLegacyProfilingURLs(ctx, legacy); e != nil || !ok {
		t.Fatalf("legacy recovery %v %v", ok, e)
	}
	if status, e := r.StartReadyPageScanning(ctx, legacy); e != nil || status != "scanning" {
		t.Fatalf("legacy ready %s %v", status, e)
	}
}

func TestDiscoveryHashCollisionChecksCompleteStringSQL(t *testing.T) {
	r, ctx, a, root := discoveryFixture(t)
	existing := "https://fixture.test/existing"
	incoming := "https://fixture.test/incoming"
	// Deliberately forge a digest collision; complete strings must still differ.
	execMCPFixture(t, r, ctx, `INSERT INTO scan_discovery_candidates(scan_id,raw_url,raw_hash,ordinal) VALUES($1,$2,$3,0)`, discoveryTestID, existing, discoveryHash(incoming))
	execMCPFixture(t, r, ctx, `UPDATE scan_discoveries SET next_candidate_ordinal=1 WHERE scan_id=$1`, discoveryTestID)
	if e := r.CommitDiscoverySitemap(ctx, discoveryTestID, a.Epoch, root, DiscoveryDocument{Candidates: []string{incoming}}); e != nil {
		t.Fatal(e)
	}
	var count int
	if e := r.pool.QueryRow(ctx, `SELECT COUNT(*) FROM scan_discovery_candidates WHERE scan_id=$1`, discoveryTestID).Scan(&count); e != nil || count != 2 {
		t.Fatalf("collision candidates %d %v", count, e)
	}
}

func TestDiscoveryPublicationRollbackSQL(t *testing.T) {
	r, ctx, a, root := discoveryFixture(t)
	urls := []string{"https://fixture.test/a", "https://fixture.test/b"}
	if e := r.CommitDiscoverySitemap(ctx, discoveryTestID, a.Epoch, root, DiscoveryDocument{Candidates: urls}); e != nil {
		t.Fatal(e)
	}
	if _, e := r.BeginDiscoveryProbes(ctx, discoveryTestID, a.Epoch); e != nil {
		t.Fatal(e)
	}
	for i, u := range urls {
		if e := r.SaveDiscoveryProbe(ctx, discoveryTestID, a.Epoch, DiscoveryProbeOutcome{Ordinal: i, RawURL: u, Outcome: "eligible", FinalURL: u}); e != nil {
			t.Fatal(e)
		}
	}
	execMCPFixture(t, r, ctx, `CREATE FUNCTION fail_second_discovery_url() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.url='https://fixture.test/b' THEN RAISE EXCEPTION 'publication fixture failure'; END IF; RETURN NEW; END $$`)
	execMCPFixture(t, r, ctx, `CREATE TRIGGER fail_second_discovery_url BEFORE INSERT ON urls FOR EACH ROW EXECUTE FUNCTION fail_second_discovery_url()`)
	if _, e := r.PublishDiscoveryComplete(ctx, discoveryTestID, a.Epoch); e == nil {
		t.Fatal("publication unexpectedly succeeded")
	}
	var count, total int
	var phase string
	if e := r.pool.QueryRow(ctx, `SELECT COUNT(*) FROM urls WHERE scan_id=$1`, discoveryTestID).Scan(&count); e != nil || count != 0 {
		t.Fatalf("partial URLs %d %v", count, e)
	}
	if e := r.pool.QueryRow(ctx, `SELECT total_urls FROM scans WHERE id=$1`, discoveryTestID).Scan(&total); e != nil || total != 0 {
		t.Fatalf("partial total %d %v", total, e)
	}
	if e := r.pool.QueryRow(ctx, `SELECT phase FROM scan_discoveries WHERE scan_id=$1`, discoveryTestID).Scan(&phase); e != nil || phase != "probe" {
		t.Fatalf("partial phase %s %v", phase, e)
	}
}

func TestDiscoveryOriginalXMLIndexMayExceedDistinctLimitSQL(t *testing.T) {
	r, ctx, a, root := discoveryFixture(t)
	child := "https://fixture.test/late.xml"
	// The parser may have skipped tens of thousands of duplicate/empty XML
	// entries before this one distinct child. Path retains its true XML index.
	e := r.CommitDiscoverySitemap(ctx, discoveryTestID, a.Epoch, root, DiscoveryDocument{IsIndex: true, Children: []DiscoverySitemapTask{{CanonicalURL: child, FetchURL: child, EntryIndex: 25000}}})
	if e != nil {
		t.Fatal(e)
	}
	next, e := r.NextDiscoverySitemap(ctx, discoveryTestID, a.Epoch)
	if e != nil || next == nil || !sameDiscoveryPath(next.Path, []int32{25000}) {
		t.Fatalf("late child %+v %v", next, e)
	}
}

func TestDiscoveryLeaseCoversCheckpointTailSQL(t *testing.T) {
	r, ctx, a, _ := discoveryFixture(t)
	for elapsed := 30 * time.Second; elapsed <= 14*time.Minute; elapsed += 30 * time.Second {
		if e := r.RenewDiscoveryAdmission(ctx, discoveryTestID, a.Epoch, elapsed); e != nil {
			t.Fatalf("renew at %s: %v", elapsed, e)
		}
	}
	if e := r.EndDiscoveryAdmission(ctx, discoveryTestID, a.Epoch, 14*time.Minute); e != nil {
		t.Fatalf("settle tail: %v", e)
	}
	s, _, e := r.GetDiscoverySnapshot(ctx, discoveryTestID)
	if e != nil || s.ActiveMSUsed != 14*60*1000 {
		t.Fatalf("tail charge %+v %v", s, e)
	}
	if e := r.RenewDiscoveryAdmission(ctx, discoveryTestID, a.Epoch, 14*time.Minute); !errors.Is(e, ErrDiscoveryInvariant) {
		t.Fatalf("renew after settlement: %v", e)
	}
}
