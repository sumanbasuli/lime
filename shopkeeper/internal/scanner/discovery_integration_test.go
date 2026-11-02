package scanner

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/sumanbasuli/lime/shopkeeper/internal/profiler"
	"github.com/sumanbasuli/lime/shopkeeper/internal/repository"
	"github.com/sumanbasuli/lime/shopkeeper/internal/viewport"
)

// Each opt-in test owns a schema in an explicitly disposable PostgreSQL database.
func discoverySQLFixture(t *testing.T) (*repository.Repository, *pgxpool.Pool, context.Context) {
	return discoverySQLFixtureVersion(t, false)
}

func discoverySQLFixtureVersion(t *testing.T, stopBefore20 bool) (*repository.Repository, *pgxpool.Pool, context.Context) {
	t.Helper()
	dsn := os.Getenv("LIME_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set LIME_TEST_DATABASE_URL to a disposable PostgreSQL database")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	t.Cleanup(cancel)
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	var suffix [8]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		t.Fatal(err)
	}
	schema := "discovery_e2e_" + hex.EncodeToString(suffix[:])
	quoted := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+quoted); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, stop := context.WithTimeout(context.Background(), 10*time.Second)
		defer stop()
		if _, err := admin.Exec(cleanupCtx, "DROP SCHEMA "+quoted+" CASCADE"); err != nil {
			t.Errorf("drop isolated schema: %v", err)
		}
		admin.Close()
	})
	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	migrations, err := filepath.Glob("../../migrations/*.up.sql")
	if err != nil || len(migrations) == 0 {
		t.Fatalf("find migrations: %v", err)
	}
	for _, path := range migrations {
		if stopBefore20 && strings.HasPrefix(filepath.Base(path), "000020_") {
			break
		}
		body, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, string(body)); err != nil {
			t.Fatalf("apply %s: %v", filepath.Base(path), err)
		}
	}
	return repository.New(pool), pool, ctx
}

func TestDiscoveryCheckpointMigrationPreservesPopulatedLegacyScans(t *testing.T) {
	repo, pool, ctx := discoverySQLFixtureVersion(t, true)
	statuses := []string{"completed", "paused", "failed", "pending"}
	ids := []string{
		"33333333-3333-4333-8333-333333333331",
		"33333333-3333-4333-8333-333333333332",
		"33333333-3333-4333-8333-333333333333",
		"33333333-3333-4333-8333-333333333334",
	}
	for i, status := range statuses {
		if _, err := pool.Exec(ctx, `INSERT INTO scans(id,sitemap_url,status,scan_type,total_urls,scanned_urls)
			VALUES($1,$2,$3,'sitemap',1,$4)`, ids[i], "https://legacy.test/"+status+".xml", status, map[bool]int{true: 1, false: 0}[status == "completed"]); err != nil {
			t.Fatal(err)
		}
		urlStatus := "pending"
		if status == "completed" {
			urlStatus = "completed"
		}
		if _, err := pool.Exec(ctx, `INSERT INTO urls(scan_id,url,status) VALUES($1,$2,$3)`, ids[i], "https://legacy.test/"+status, urlStatus); err != nil {
			t.Fatal(err)
		}
	}
	migration, err := os.ReadFile("../../migrations/000020_add_discovery_checkpoints.up.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, string(migration)); err != nil {
		t.Fatalf("upgrade populated schema: %v", err)
	}
	var discoveries int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM scan_discoveries`).Scan(&discoveries); err != nil || discoveries != 0 {
		t.Fatalf("migration fabricated discovery rows: count=%d err=%v", discoveries, err)
	}
	for i, id := range ids {
		scan, err := repo.GetScan(ctx, id)
		if err != nil || scan == nil || scan.Status != statuses[i] || scan.TotalURLs != 1 {
			t.Fatalf("legacy scan %s: row=%+v err=%v", statuses[i], scan, err)
		}
		urls, err := repo.GetScanURLs(ctx, id)
		if err != nil || len(urls) != 1 || urls[0].URL != "https://legacy.test/"+statuses[i] {
			t.Fatalf("legacy URLs for %s: rows=%+v err=%v", statuses[i], urls, err)
		}
	}
	// The upgraded schema must also admit a fresh checkpointed scan.
	newScan, err := repo.CreateScan(ctx, "https://new.test/root.xml", "sitemap", nil, viewport.Settings{})
	if err != nil {
		t.Fatal(err)
	}
	if snapshot, err := repo.LoadOrCreateDiscovery(ctx, newScan.ID, newScan.SitemapURL); err != nil || snapshot.Phase != "fetch" {
		t.Fatalf("fresh scan after upgrade: snapshot=%+v err=%v", snapshot, err)
	}
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM scan_discoveries`).Scan(&discoveries); err != nil || discoveries != 1 {
		t.Fatalf("fresh checkpoint count=%d err=%v", discoveries, err)
	}
}

type stoppingDiscoveryStore struct {
	*repository.Repository
	cancel           context.CancelFunc
	stopAfterSitemap string
	stopAfterProbe   bool
	probeBatchOne    bool
}

func (s *stoppingDiscoveryStore) CommitDiscoverySitemap(ctx context.Context, id string, epoch int64, task repository.DiscoverySitemapTask, doc repository.DiscoveryDocument) error {
	err := s.Repository.CommitDiscoverySitemap(ctx, id, epoch, task, doc)
	if err == nil && strings.HasSuffix(task.FetchURL, s.stopAfterSitemap) && s.stopAfterSitemap != "" {
		s.cancel()
	}
	return err
}

func (s *stoppingDiscoveryStore) PendingDiscoveryCandidates(ctx context.Context, id string, epoch int64, limit int) ([]repository.DiscoveryCandidate, error) {
	if s.probeBatchOne {
		limit = 1
	}
	return s.Repository.PendingDiscoveryCandidates(ctx, id, epoch, limit)
}

func (s *stoppingDiscoveryStore) SaveDiscoveryProbe(ctx context.Context, id string, epoch int64, outcome repository.DiscoveryProbeOutcome) error {
	err := s.Repository.SaveDiscoveryProbe(ctx, id, epoch, outcome)
	if err == nil && s.stopAfterProbe {
		s.cancel()
	}
	return err
}

func TestDiscoveryCheckpointedHTTPPostgresPauseRestartAndOrder(t *testing.T) {
	repo, pool, ctx := discoverySQLFixture(t)
	var mu sync.Mutex
	hits := map[string]int{}
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		hits[r.URL.Path]++
		mu.Unlock()
		switch r.URL.Path {
		case "/root.xml":
			fmt.Fprintf(w, `<sitemapindex><sitemap><loc>%s/branch.xml</loc></sitemap><sitemap><loc>%s/last.xml</loc></sitemap></sitemapindex>`, server.URL, server.URL)
		case "/branch.xml":
			fmt.Fprintf(w, `<sitemapindex><sitemap><loc>%s/first.xml</loc></sitemap><sitemap><loc>%s/last.xml</loc></sitemap></sitemapindex>`, server.URL, server.URL)
		case "/first.xml":
			fmt.Fprintf(w, `<urlset><url><loc>%s/a</loc></url><url><loc>%s/a</loc></url><url><loc>%s/b</loc></url></urlset>`, server.URL, server.URL, server.URL)
		case "/last.xml":
			fmt.Fprintf(w, `<urlset><url><loc>%s/b</loc></url><url><loc>%s/c</loc></url></urlset>`, server.URL, server.URL)
		default:
			w.WriteHeader(http.StatusOK)
		}
	}))
	defer server.Close()

	scan, err := repo.CreateScanWithLinkCheck(ctx, server.URL+"/root.xml", "sitemap", nil, viewport.Settings{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.LoadOrCreateDiscovery(ctx, scan.ID, scan.SitemapURL); err != nil {
		t.Fatal(err)
	}
	assertUnpublished := func(phase string) {
		t.Helper()
		var urls, companions, started int
		if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM urls WHERE scan_id=$1`, scan.ID).Scan(&urls); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(ctx, `SELECT COUNT(*),COUNT(*) FILTER (WHERE status <> 'queued') FROM link_checks WHERE scan_id=$1`, scan.ID).Scan(&companions, &started); err != nil {
			t.Fatal(err)
		}
		if urls != 0 || companions != 1 || started != 0 {
			t.Fatalf("%s published partial state: urls=%d companions=%d started=%d", phase, urls, companions, started)
		}
	}

	first, err := repo.StartDiscoveryAdmission(ctx, scan.ID)
	if err != nil {
		t.Fatal(err)
	}
	firstCtx, cancelFirst := context.WithCancel(ctx)
	result, err := profiler.DiscoverCheckpointed(firstCtx, scan.ID, scan.SitemapURL, first.Epoch,
		&stoppingDiscoveryStore{Repository: repo, cancel: cancelFirst, stopAfterSitemap: "/branch.xml"}, nil)
	if err != nil || result != profiler.DiscoveryYielded {
		t.Fatalf("first admission: result=%v err=%v", result, err)
	}
	if err := repo.EndDiscoveryAdmission(ctx, scan.ID, first.Epoch, time.Millisecond); err != nil {
		t.Fatal(err)
	}
	assertUnpublished("after sitemap checkpoint")
	var doneSitemaps int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM scan_discovery_sitemaps WHERE scan_id=$1 AND state='done'`, scan.ID).Scan(&doneSitemaps); err != nil || doneSitemaps != 2 {
		t.Fatalf("completed sitemap checkpoints=%d err=%v", doneSitemaps, err)
	}
	// Simulate a process restart while the old worker is absent.
	if err := recoverInterruptedScans(ctx, repo, func(string) error { return nil }); err != nil {
		t.Fatal(err)
	}
	second, err := repo.StartDiscoveryAdmission(ctx, scan.ID)
	if err != nil {
		t.Fatal(err)
	}
	secondCtx, cancelSecond := context.WithCancel(ctx)
	result, err = profiler.DiscoverCheckpointed(secondCtx, scan.ID, scan.SitemapURL, second.Epoch,
		&stoppingDiscoveryStore{Repository: repo, cancel: cancelSecond, stopAfterProbe: true, probeBatchOne: true}, nil)
	if err != nil || result != profiler.DiscoveryYielded {
		t.Fatalf("second admission: result=%v err=%v", result, err)
	}
	if err := repo.EndDiscoveryAdmission(ctx, scan.ID, second.Epoch, time.Millisecond); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.RequestPause(ctx, scan.ID); err != nil {
		t.Fatal(err)
	}
	if status, err := repo.RequeueDiscoveryProfiling(ctx, scan.ID, second.Epoch); err != nil || status != "paused" {
		t.Fatalf("pause after probe checkpoint: status=%s err=%v", status, err)
	}
	assertUnpublished("after probe checkpoint and pause")
	var savedProbes int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM scan_discovery_candidates WHERE scan_id=$1 AND outcome <> 'pending'`, scan.ID).Scan(&savedProbes); err != nil || savedProbes != 1 {
		t.Fatalf("saved probes=%d err=%v", savedProbes, err)
	}
	if _, err := repo.ResumeScan(ctx, scan.ID); err != nil {
		t.Fatal(err)
	}
	third, err := repo.StartDiscoveryAdmission(ctx, scan.ID)
	if err != nil {
		t.Fatal(err)
	}
	result, err = profiler.DiscoverCheckpointed(ctx, scan.ID, scan.SitemapURL, third.Epoch, repo, nil)
	if err != nil || result != profiler.DiscoveryComplete {
		t.Fatalf("resumed admission: result=%v err=%v", result, err)
	}
	if err := repo.EndDiscoveryAdmission(ctx, scan.ID, third.Epoch, time.Millisecond); err != nil {
		t.Fatal(err)
	}
	if status, err := repo.CompleteDiscoveryProfiling(ctx, scan.ID, third.Epoch); err != nil || status != "scanning" {
		t.Fatalf("page transition: status=%s err=%v", status, err)
	}
	urls, err := repo.GetScanURLs(ctx, scan.ID)
	if err != nil || len(urls) != 3 {
		t.Fatalf("published urls=%v err=%v", urls, err)
	}
	actual := []string{urls[0].URL, urls[1].URL, urls[2].URL}
	want := []string{server.URL + "/a", server.URL + "/b", server.URL + "/c"}
	if !slices.Equal(actual, want) {
		t.Fatalf("DFS/dedup order=%v want=%v", actual, want)
	}
	mu.Lock()
	rootHits, branchHits, lastHits := hits["/root.xml"], hits["/branch.xml"], hits["/last.xml"]
	firstProbeHits := hits["/a"]
	mu.Unlock()
	if rootHits != 1 || branchHits != 1 || lastHits != 1 {
		t.Fatalf("committed sitemap refetched or duplicate child fetched: root=%d branch=%d last=%d", rootHits, branchHits, lastHits)
	}
	if firstProbeHits != 1 {
		t.Fatalf("saved first probe was repeated: requests=%d", firstProbeHits)
	}
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM scan_discovery_candidates WHERE scan_id=$1 AND outcome='pending'`, scan.ID).Scan(&savedProbes); err != nil || savedProbes != 0 {
		t.Fatalf("pending probes after resume=%d err=%v", savedProbes, err)
	}
}
