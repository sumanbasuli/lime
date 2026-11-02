package scanner

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
	"github.com/sumanbasuli/lime/shopkeeper/internal/screenshots"
)

func TestScanSchedulerCapsWorkersAndDrainsPendingRows(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	ids := []string{"first", "second", "third", "fourth"}
	pending := map[string]bool{}
	release := map[string]chan struct{}{}
	for _, id := range ids {
		pending[id] = true
		release[id] = make(chan struct{})
	}
	var mu sync.Mutex
	active, maximum := 0, 0
	started := make(chan string, len(ids))
	finished := make(chan string, len(ids))

	q := newScanScheduler(ctx, func(_ context.Context, limit int) ([]models.Scan, error) {
		mu.Lock()
		defer mu.Unlock()
		var scans []models.Scan
		for _, id := range ids {
			if pending[id] && len(scans) < limit {
				scans = append(scans, models.Scan{ID: id, Status: "pending"})
			}
		}
		return scans, nil
	}, func(scan models.Scan) {
		mu.Lock()
		active++
		if active > maximum {
			maximum = active
		}
		mu.Unlock()
		started <- scan.ID
		<-release[scan.ID]
		mu.Lock()
		pending[scan.ID] = false
		active--
		mu.Unlock()
		finished <- scan.ID
	}, func(context.Context, string) error {
		t.Fatal("unexpected queued pause")
		return nil
	})
	q.start()
	q.notify()

	first := waitScanID(t, started)
	second := waitScanID(t, started)
	if first == second {
		t.Fatalf("same pending scan admitted twice: %q", first)
	}
	select {
	case id := <-started:
		t.Fatalf("admitted third scan while both slots held: %q", id)
	case <-time.After(100 * time.Millisecond):
	}

	close(release[first])
	third := waitScanID(t, started)
	if third == first || third == second {
		t.Fatalf("expected a new pending scan after slot release, got %q", third)
	}
	close(release[second])
	fourth := waitScanID(t, started)
	if fourth == first || fourth == second || fourth == third {
		t.Fatalf("expected fourth pending scan, got %q", fourth)
	}
	close(release[third])
	close(release[fourth])
	for range ids {
		waitScanID(t, finished)
	}
	mu.Lock()
	defer mu.Unlock()
	if maximum != maxConcurrentScans {
		t.Fatalf("maximum active scans = %d, want %d", maximum, maxConcurrentScans)
	}
}

func TestScanSchedulerFinalizesQueuedPauseWithoutRunning(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var mu sync.Mutex
	pending := true
	paused := make(chan string, 1)
	q := newScanScheduler(ctx, func(_ context.Context, _ int) ([]models.Scan, error) {
		mu.Lock()
		defer mu.Unlock()
		if !pending {
			return nil, nil
		}
		return []models.Scan{{ID: "queued", Status: "pending", PauseRequested: true}}, nil
	}, func(models.Scan) {
		t.Error("paused pending scan was run")
	}, func(_ context.Context, id string) error {
		mu.Lock()
		pending = false
		mu.Unlock()
		paused <- id
		return nil
	})
	q.start()
	q.notify()
	if id := waitScanID(t, paused); id != "queued" {
		t.Fatalf("paused scan = %q, want queued", id)
	}
}

type fakeScanRecoveryRepository struct {
	scans      []models.Scan
	urls       map[string][]models.URL
	discovery  map[string]bool
	recovered  []string
	legacy     []string
	reset      []string
	requeue    []string
	recoverErr error
	paused     []string
}

func (r *fakeScanRecoveryRepository) RecoverDiscoveryAdmission(_ context.Context, id string) (bool, error) {
	if r.discovery[id] {
		r.recovered = append(r.recovered, id)
		return true, nil
	}
	return false, nil
}

func (r *fakeScanRecoveryRepository) RecoverLegacyProfilingURLs(_ context.Context, id string) (bool, error) {
	if len(r.urls[id]) == 0 {
		return false, nil
	}
	r.legacy = append(r.legacy, id)
	return true, nil
}

func (r *fakeScanRecoveryRepository) GetScanURLs(_ context.Context, id string) ([]models.URL, error) {
	return r.urls[id], nil
}

func (r *fakeScanRecoveryRepository) ListRecoverableScans(context.Context) ([]models.Scan, error) {
	return r.scans, nil
}

func (r *fakeScanRecoveryRepository) ResetScan(_ context.Context, id string) error {
	r.reset = append(r.reset, id)
	return nil
}

func (r *fakeScanRecoveryRepository) RecoverScanPages(_ context.Context, id string) error {
	r.requeue = append(r.requeue, id)
	return r.recoverErr
}

func (r *fakeScanRecoveryRepository) FinalizePausedScan(_ context.Context, id string) error {
	r.paused = append(r.paused, id)
	return nil
}

func TestRecoveryKeepsQueuedResumeAndRetryState(t *testing.T) {
	repo := &fakeScanRecoveryRepository{scans: []models.Scan{
		{ID: "new", Status: "pending"},
		{ID: "resume-with-results", Status: "pending", ScannedURLs: 3},
		{ID: "retry-with-results", Status: "pending", ScannedURLs: 5},
		{ID: "profiling", Status: "profiling"},
		{ID: "scanning", Status: "scanning"},
		{ID: "processing", Status: "processing"},
		{ID: "pause-requested", Status: "pending", PauseRequested: true},
	}}
	var removed []string
	if err := recoverInterruptedScans(context.Background(), repo, func(id string) error {
		removed = append(removed, id)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(repo.reset, []string{"profiling"}) {
		t.Fatalf("reset scans = %v", repo.reset)
	}
	if !slices.Equal(repo.requeue, []string{"scanning", "processing"}) {
		t.Fatalf("requeued scans = %v", repo.requeue)
	}
	if !slices.Equal(removed, repo.reset) {
		t.Fatalf("removed screenshot sets = %v, want %v", removed, repo.reset)
	}
	if !slices.Equal(repo.paused, []string{"pause-requested"}) {
		t.Fatalf("paused scans = %v", repo.paused)
	}
}

func TestRecoveryPreservesInterruptedDiscoveryCheckpoints(t *testing.T) {
	repo := &fakeScanRecoveryRepository{
		scans: []models.Scan{
			{ID: "fetch", Status: "profiling"},
			{ID: "probe-pausing", Status: "profiling", PauseRequested: true},
		},
		discovery: map[string]bool{"fetch": true, "probe-pausing": true},
	}
	var removed []string
	if err := recoverInterruptedScans(context.Background(), repo, func(id string) error {
		removed = append(removed, id)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(repo.recovered, []string{"fetch", "probe-pausing"}) {
		t.Fatalf("recovered discovery = %v", repo.recovered)
	}
	if len(repo.reset) != 0 || len(repo.paused) != 0 || len(removed) != 0 {
		t.Fatalf("recovery erased discovery: reset=%v paused=%v screenshots=%v", repo.reset, repo.paused, removed)
	}
}

func TestRecoveryPreservesHistoricalProfilingURLs(t *testing.T) {
	repo := &fakeScanRecoveryRepository{
		scans: []models.Scan{
			{ID: "saved", Status: "profiling"},
			{ID: "saved-pausing", Status: "profiling", PauseRequested: true},
		},
		urls: map[string][]models.URL{
			"saved":         {{ID: "u1", Status: "completed"}},
			"saved-pausing": {{ID: "u2", Status: "pending"}},
		},
	}
	if err := recoverInterruptedScans(context.Background(), repo, func(string) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(repo.legacy, []string{"saved", "saved-pausing"}) || len(repo.reset) != 0 {
		t.Fatalf("historical URL recovery = %v, reset = %v", repo.legacy, repo.reset)
	}
}

func TestInactiveScanRecoverySkipsActiveWorkersAndRepairsPages(t *testing.T) {
	repo := &fakeScanRecoveryRepository{
		scans: []models.Scan{
			{ID: "active-discovery", Status: "profiling"},
			{ID: "active-pages", Status: "scanning"},
			{ID: "stranded", Status: "profiling"},
			{ID: "scanning", Status: "scanning"},
			{ID: "processing", Status: "processing"},
		},
		discovery: map[string]bool{"active-discovery": true, "stranded": true},
		urls: map[string][]models.URL{
			"scanning":   {{ID: "u1", Status: "pending"}},
			"processing": {{ID: "u2", Status: "completed"}},
		},
	}
	var pruned []string
	if err := recoverInactiveScans(context.Background(), repo,
		func(id string) bool { return id == "active-discovery" || id == "active-pages" },
		func(id string, _ []models.URL) error { pruned = append(pruned, id); return nil }); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(repo.recovered, []string{"stranded"}) {
		t.Fatalf("recovered discovery = %v, want only stranded", repo.recovered)
	}
	if !slices.Equal(repo.requeue, []string{"scanning", "processing"}) || !slices.Equal(pruned, repo.requeue) {
		t.Fatalf("page repair = %v, screenshot pruning = %v", repo.requeue, pruned)
	}
}

func TestRecoveryPropagatesCheckpointCleanupFailure(t *testing.T) {
	failure := errors.New("database unavailable")
	repo := &fakeScanRecoveryRepository{
		scans:      []models.Scan{{ID: "interrupted", Status: "processing"}},
		recoverErr: failure,
	}
	err := recoverInterruptedScans(context.Background(), repo, func(string) error { return nil })
	if !errors.Is(err, failure) {
		t.Fatalf("recovery failure = %v, want %v", err, failure)
	}
}

func TestRecoveryPrunesUnfinishedScreenshotsBeforePausing(t *testing.T) {
	t.Setenv("SHOPKEEPER_SCREENSHOT_DIR", t.TempDir())
	const scanID = "11111111-1111-4111-8111-111111111111"
	const completedURL = "22222222-2222-4222-8222-222222222222"
	const unfinishedURL = "33333333-3333-4333-8333-333333333333"
	if err := os.MkdirAll(screenshots.ScanDir(scanID), 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{completedURL + ".png", unfinishedURL + ".png"} {
		if err := os.WriteFile(filepath.Join(screenshots.ScanDir(scanID), name), []byte("fixture"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	repo := &fakeScanRecoveryRepository{
		scans: []models.Scan{{ID: scanID, Status: "scanning", PauseRequested: true}},
		urls: map[string][]models.URL{scanID: {
			{ID: completedURL, Status: "completed"},
			{ID: unfinishedURL, Status: "pending"},
		}},
	}
	if err := recoverInterruptedScans(context.Background(), repo, func(string) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(screenshots.ScanDir(scanID), completedURL+".png")); err != nil {
		t.Fatalf("completed screenshot removed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(screenshots.ScanDir(scanID), unfinishedURL+".png")); !os.IsNotExist(err) {
		t.Fatalf("unfinished screenshot remains: %v", err)
	}
}

func waitScanID(t *testing.T, ch <-chan string) string {
	t.Helper()
	select {
	case id := <-ch:
		return id
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for scan scheduler")
		return ""
	}
}
