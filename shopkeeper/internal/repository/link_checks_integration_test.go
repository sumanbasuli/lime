package repository

import (
	"context"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
	"github.com/sumanbasuli/lime/shopkeeper/internal/viewport"
)

func TestLinkChecksMigrationAtomicScanSelectionAndIsolationSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	v, _ := viewport.ResolvePreset("")
	legacy, err := r.CreateScan(ctx, "https://example.test/legacy", "single", nil, v)
	if err != nil {
		t.Fatal(err)
	}
	if legacy.IncludeLinkCheck {
		t.Fatal("existing scan API did not default link checking off")
	}
	if job, err := r.GetScanLinkCheck(ctx, legacy.ID); err != nil || job != nil {
		t.Fatalf("default scan created job: %v %v", job, err)
	}
	linked, err := r.CreateScanWithLinkCheck(ctx, "https://example.test/sitemap.xml", "sitemap", nil, v)
	if err != nil {
		t.Fatal(err)
	}
	if !linked.IncludeLinkCheck {
		t.Fatal("selection not persisted")
	}
	job, err := r.GetScanLinkCheck(ctx, linked.ID)
	if err != nil || job == nil || job.Status != "queued" || job.CheckType != "scan" || job.MaxPages != 500 {
		t.Fatalf("companion=%+v %v", job, err)
	}
	if rows, err := r.ListScans(ctx); err != nil || len(rows) != 2 {
		t.Fatalf("legacy list columns broken: %v %v", rows, err)
	}
	if rows, err := r.ListMCPScans(ctx, 10, 0); err != nil || len(rows) != 2 {
		t.Fatalf("MCP scan columns broken: %v %v", rows, err)
	}
	if ids, err := r.ReadyLinkCheckIDs(ctx); err != nil || len(ids) != 0 {
		t.Fatalf("companion ran before accessibility completed: %v %v", ids, err)
	}
	if err := r.UpdateScanStatus(ctx, linked.ID, "paused"); err != nil {
		t.Fatal(err)
	}
	if ids, err := r.ReadyLinkCheckIDs(ctx); err != nil || len(ids) != 0 {
		t.Fatalf("paused companion ran: %v %v", ids, err)
	}
	if err := r.UpdateScanStatus(ctx, linked.ID, "failed"); err != nil {
		t.Fatal(err)
	}
	if _, err := r.ReadyLinkCheckIDs(ctx); err != nil {
		t.Fatal(err)
	}
	job, err = r.GetLinkCheck(ctx, job.ID)
	if err != nil || job.Status != "failed" || job.Error == nil {
		t.Fatalf("failed parent companion=%+v %v", job, err)
	}
	if ok, err := r.DeleteScan(ctx, linked.ID); err != nil || !ok {
		t.Fatal("failed to remove exact fixture scan", err)
	}
	if job, err := r.GetLinkCheck(ctx, job.ID); err != nil || job != nil {
		t.Fatalf("scan deletion did not cascade companion: %v %v", job, err)
	}
	if existing, err := r.GetScan(ctx, legacy.ID); err != nil || existing == nil {
		t.Fatal("link job lifecycle removed legacy scan")
	}
	// Exercise the real reversible migration in this unique disposable schema.
	newerDown, err := os.ReadFile("../../migrations/000019_add_link_source_rows.down.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.pool.Exec(ctx, string(newerDown)); err != nil {
		t.Fatal(err)
	}
	down, err := os.ReadFile("../../migrations/000013_add_link_checks.down.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.pool.Exec(ctx, string(down)); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := r.pool.QueryRow(ctx, `SELECT count(*) FROM scans WHERE id=$1`, legacy.ID).Scan(&count); err != nil || count != 1 {
		t.Fatal("down migration harmed old scans", err)
	}
	up, err := os.ReadFile("../../migrations/000013_add_link_checks.up.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.pool.Exec(ctx, string(up)); err != nil {
		t.Fatal(err)
	}
	if restored, err := r.GetScan(ctx, legacy.ID); err != nil || restored == nil || restored.IncludeLinkCheck {
		t.Fatalf("up/backfill=%+v %v", restored, err)
	}
}

func TestCompanionClaimRequiresPublishedDiscoveryInventory(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	v, _ := viewport.ResolvePreset("")
	scan, err := r.CreateScanWithLinkCheck(ctx, "https://example.test/sitemap.xml", "sitemap", nil, v)
	if err != nil {
		t.Fatal(err)
	}
	job, err := r.GetScanLinkCheck(ctx, scan.ID)
	if err != nil || job == nil {
		t.Fatalf("companion = %+v, %v", job, err)
	}
	if _, err := r.pool.Exec(ctx, `INSERT INTO scan_discoveries(scan_id,phase) VALUES($1,'fetch')`, scan.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := r.pool.Exec(ctx, `INSERT INTO urls(scan_id,url,status) VALUES($1,'https://example.test/page','pending')`, scan.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := r.pool.Exec(ctx, `UPDATE scans SET status='completed',total_urls=1 WHERE id=$1`, scan.ID); err != nil {
		t.Fatal(err)
	}
	claimed, err := r.ClaimLinkCheck(ctx, job.ID)
	if err != nil || claimed != nil {
		t.Fatalf("companion read partial discovery: %+v, %v", claimed, err)
	}
	if _, err := r.pool.Exec(ctx, `UPDATE scan_discoveries SET phase='complete' WHERE scan_id=$1`, scan.ID); err != nil {
		t.Fatal(err)
	}
	claimed, err = r.ClaimLinkCheck(ctx, job.ID)
	if err != nil || claimed == nil || len(claimed.SeedURLs) != 1 {
		t.Fatalf("companion did not read published URLs: %+v, %v", claimed, err)
	}
}

func TestLinkCheckSnapshotsPaginationCancellationRecoverySQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	job, err := r.CreateLinkCheck(ctx, "https://example.test/", "crawl", 100, nil)
	if err != nil {
		t.Fatal(err)
	}
	items, total, err := r.ListLinkChecks(ctx, 1, 100)
	if err != nil || total != 1 || len(items) != 0 {
		t.Fatalf("past-end list total=%d items=%d %v", total, len(items), err)
	}
	claimed, err := r.ClaimLinkCheck(ctx, job.ID)
	if err != nil || claimed == nil || claimed.Status != "running" {
		t.Fatalf("claim=%+v %v", claimed, err)
	}
	if second, err := r.ClaimLinkCheck(ctx, job.ID); err != nil || second != nil {
		t.Fatalf("duplicate claim=%+v %v", second, err)
	}
	if deleted, err := r.DeleteLinkCheck(ctx, job.ID); err != nil || deleted {
		t.Fatalf("activejobdeletion=%v %v", deleted, err)
	}
	sources := []models.LinkSource{}
	for i := 0; i < 7; i++ {
		sources = append(sources, models.LinkSource{PageURL: "https://example.test/source", Element: "a", Attribute: "href", Text: "Link"})
	}
	result := models.LinkResult{ID: mcpURLID, TargetURL: "https://example.test/missing", Status: "broken", LinkType: "internal", OccurrenceCount: 7, Sources: sources}
	claimed.PagesChecked = 2
	claimed.TotalLinks = 1
	claimed.LinksChecked = 1
	claimed.Summary.Broken = 1
	if err := r.SaveLinkCheck(ctx, *claimed, []models.LinkResult{result}); err != nil {
		t.Fatal(err)
	}
	results, total, err := r.GetLinkResults(ctx, job.ID, "broken", 1, 0)
	if err != nil || total != 1 || len(results) != 1 || len(results[0].Sources) != 5 || results[0].OccurrenceCount != 7 {
		t.Fatalf("preview=%+v total=%d %v", results, total, err)
	}
	exported, err := r.GetLinkExportResults(ctx, job.ID)
	if err != nil || len(exported) != 1 || len(exported[0].Sources) != 7 {
		t.Fatalf("export lost full source refs: %+v %v", exported, err)
	}
	refs, total, found, err := r.GetLinkSources(ctx, job.ID, result.ID, 2, 5)
	if err != nil || !found || total != 7 || len(refs) != 2 {
		t.Fatalf("refs=%+v total=%d found=%v %v", refs, total, found, err)
	}
	if _, _, found, err := r.GetLinkSources(ctx, mcpOtherScanID, result.ID, 2, 0); err != nil || found {
		t.Fatalf("cross-job source ID exposed: %v %v", found, err)
	}
	stats, err := r.GetLinkCheckStats(ctx)
	if err != nil || stats["total_checks"] != 1 || stats["active_checks"] != 1 || stats["broken_links"] != 1 || stats["pages_checked"] != 2 {
		t.Fatalf("stats=%v %v", stats, err)
	}
	cancelled, err := r.CancelLinkCheck(ctx, job.ID)
	if err != nil || cancelled == nil || cancelled.Status != "cancelled" {
		t.Fatal("cancel failed", err)
	}
	claimed.Status = "completed"
	claimed.Summary.Broken = 0
	if err := r.SaveLinkCheck(ctx, *claimed, nil); err != nil {
		t.Fatal(err)
	}
	current, err := r.GetLinkCheck(ctx, job.ID)
	if err != nil || current.Status != "cancelled" || current.Summary.Broken != 1 {
		t.Fatalf("late write resurrected cancel: %+v %v", current, err)
	}
	results, total, err = r.GetLinkResults(ctx, job.ID, "", 10, 0)
	if err != nil || len(results) != 1 || total != 1 {
		t.Fatal("late write erased partial evidence", err)
	}
	// Restart only requeues running jobs, never terminal cancellation.
	running, err := r.CreateLinkCheck(ctx, "https://example.test/restart", "single", 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	running, err = r.ClaimLinkCheck(ctx, running.ID)
	if err != nil {
		t.Fatal(err)
	}
	result.ID = mcpOtherScanID
	if err := r.SaveLinkCheck(ctx, *running, []models.LinkResult{result}); err != nil {
		t.Fatal(err)
	}
	if err := r.RecoverLinkChecks(ctx); err != nil {
		t.Fatal(err)
	}
	current, err = r.GetLinkCheck(ctx, job.ID)
	if err != nil || current.Status != "cancelled" {
		t.Fatal("recovery restarted cancelled job", err)
	}
	restarted, err := r.ClaimLinkCheck(ctx, running.ID)
	if err != nil || restarted == nil || restarted.Status != "running" {
		t.Fatal("restart could not claim recovered job", err)
	}
	results, total, err = r.GetLinkResults(ctx, running.ID, "", 10, 0)
	if err != nil || len(results) != 0 || total != 0 {
		t.Fatal("restart failed to reset partial evidence", err)
	}
}

func TestLinkCheckProgressWritesOnlyChangedResultsSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	job, err := r.CreateLinkCheck(ctx, "https://example.test/", "single", 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	claimed, err := r.ClaimLinkCheck(ctx, job.ID)
	if err != nil || claimed == nil {
		t.Fatalf("claim: %+v %v", claimed, err)
	}
	first := models.LinkResult{ID: mcpURLID, TargetURL: "https://example.test/first", Status: "healthy", LinkType: "internal", Sources: []models.LinkSource{{PageURL: job.URL, Element: "a", Attribute: "href", Text: "First"}}, OccurrenceCount: 1}
	second := models.LinkResult{ID: mcpOtherScanID, TargetURL: "https://example.test/second", Status: "unchecked", LinkType: "internal", Sources: []models.LinkSource{{PageURL: job.URL, Element: "a", Attribute: "href", Text: "Second"}}, OccurrenceCount: 1}
	claimed.TotalLinks = 2
	claimed.LinksChecked = 1
	claimed.Summary.Healthy = 1
	claimed.Summary.Unchecked = 1
	if err := r.SaveLinkCheck(ctx, *claimed, []models.LinkResult{first, second}); err != nil {
		t.Fatal(err)
	}
	var firstXID string
	if err := r.pool.QueryRow(ctx, `SELECT xmin::text FROM link_check_results WHERE link_check_id=$1 AND id=$2`, job.ID, first.ID).Scan(&firstXID); err != nil {
		t.Fatal(err)
	}
	second.Status = "healthy"
	second.Sources = append(second.Sources, models.LinkSource{PageURL: "https://example.test/other", Element: "a", Attribute: "href", Text: "Again"})
	second.OccurrenceCount = 2
	claimed.PagesChecked = 1
	claimed.LinksChecked = 2
	claimed.Summary.Healthy = 2
	claimed.Summary.Unchecked = 0
	if err := r.SaveLinkCheck(ctx, *claimed, []models.LinkResult{second}); err != nil {
		t.Fatal(err)
	}
	var afterXID string
	if err := r.pool.QueryRow(ctx, `SELECT xmin::text FROM link_check_results WHERE link_check_id=$1 AND id=$2`, job.ID, first.ID).Scan(&afterXID); err != nil {
		t.Fatal(err)
	}
	if afterXID != firstXID {
		t.Fatalf("unchanged result was rewritten: xmin %s -> %s", firstXID, afterXID)
	}
	stored, err := r.GetLinkExportResults(ctx, job.ID)
	if err != nil || len(stored) != 2 || stored[0].TargetURL != first.TargetURL || stored[1].Status != "healthy" || stored[1].OccurrenceCount != 2 || len(stored[1].Sources) != 2 {
		t.Fatalf("incremental results: %+v %v", stored, err)
	}
	if err := r.SaveLinkCheck(ctx, *claimed, nil); err != nil {
		t.Fatal(err)
	}
	if err := r.pool.QueryRow(ctx, `SELECT xmin::text FROM link_check_results WHERE link_check_id=$1 AND id=$2`, job.ID, first.ID).Scan(&afterXID); err != nil || afterXID != firstXID {
		t.Fatalf("counter-only progress rewrote a result: %s -> %s (%v)", firstXID, afterXID, err)
	}
	if err := r.SaveLinkCheck(ctx, *claimed, []models.LinkResult{first}); err != nil {
		t.Fatal(err)
	}
	if err := r.pool.QueryRow(ctx, `SELECT xmin::text FROM link_check_results WHERE link_check_id=$1 AND id=$2`, job.ID, first.ID).Scan(&afterXID); err != nil || afterXID != firstXID {
		t.Fatalf("unchanged submitted row was rewritten: %s -> %s (%v)", firstXID, afterXID, err)
	}
	invalid := second
	invalid.Status = "invalid"
	claimed.PagesChecked = 99
	if err := r.SaveLinkCheck(ctx, *claimed, []models.LinkResult{invalid}); err == nil {
		t.Fatal("invalid delta unexpectedly committed")
	}
	storedJob, err := r.GetLinkCheck(ctx, job.ID)
	if err != nil || storedJob == nil || storedJob.PagesChecked != 1 {
		t.Fatalf("failed result write committed counters: %+v %v", storedJob, err)
	}
}

func TestLinkCheckSourceSuffixRetryReplayAndRestartSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	job, err := r.CreateLinkCheck(ctx, "https://example.test/", "crawl", 100, nil)
	if err != nil {
		t.Fatal(err)
	}
	claimed, err := r.ClaimLinkCheck(ctx, job.ID)
	if err != nil || claimed == nil {
		t.Fatalf("claim: %+v %v", claimed, err)
	}
	ref := func(text string) models.LinkSource {
		return models.LinkSource{PageURL: "https://example.test/" + text, Element: "a", Attribute: "href", Text: text}
	}
	result := models.LinkResult{ID: mcpURLID, TargetURL: "https://example.test/shared", Status: "unchecked", LinkType: "internal",
		Sources: []models.LinkSource{ref("one"), ref("two")}, OccurrenceCount: 2}
	assertStored := func(wantStatus string, wantSources []models.LinkSource) {
		t.Helper()
		stored, err := r.GetLinkExportResults(ctx, job.ID)
		if err != nil || len(stored) != 1 || stored[0].Status != wantStatus ||
			stored[0].OccurrenceCount != len(wantSources) || !reflect.DeepEqual(stored[0].Sources, wantSources) {
			t.Fatalf("stored status/sources: %+v, want %s %+v (%v)", stored, wantStatus, wantSources, err)
		}
	}
	if err := r.SaveLinkCheck(ctx, *claimed, []models.LinkResult{result}); err != nil {
		t.Fatal(err)
	}
	assertStored("unchecked", result.Sources)

	// A result can acquire its outcome without acquiring another source.
	result.Status = "healthy"
	if err := r.SaveLinkCheck(ctx, *claimed, []models.LinkResult{result}); err != nil {
		t.Fatal(err)
	}
	assertStored("healthy", result.Sources)
	result.Sources = append(result.Sources, ref("three"), ref("four"))
	result.OccurrenceCount = len(result.Sources)
	result.Status = "invalid"
	claimed.PagesChecked = 1
	if err := r.SaveLinkCheck(ctx, *claimed, []models.LinkResult{result}); err == nil {
		t.Fatal("invalid status unexpectedly committed")
	}
	assertStored("healthy", result.Sources[:2])
	storedJob, err := r.GetLinkCheck(ctx, job.ID)
	if err != nil || storedJob.PagesChecked != 0 {
		t.Fatalf("failed source append committed job progress: %+v %v", storedJob, err)
	}
	// The runner retries with its complete in-memory result, not a suffix.
	result.Status = "broken"
	if err := r.SaveLinkCheck(ctx, *claimed, []models.LinkResult{result}); err != nil {
		t.Fatal(err)
	}
	assertStored("broken", result.Sources)
	var beforeReplayXID string
	if err := r.pool.QueryRow(ctx, `SELECT xmin::text FROM link_check_results WHERE link_check_id=$1 AND target_url=$2`, job.ID, result.TargetURL).Scan(&beforeReplayXID); err != nil {
		t.Fatal(err)
	}
	if err := r.SaveLinkCheck(ctx, *claimed, []models.LinkResult{result}); err != nil {
		t.Fatal(err)
	}
	assertStored("broken", result.Sources)
	var afterReplayXID string
	if err := r.pool.QueryRow(ctx, `SELECT xmin::text FROM link_check_results WHERE link_check_id=$1 AND target_url=$2`, job.ID, result.TargetURL).Scan(&afterReplayXID); err != nil || beforeReplayXID != afterReplayXID {
		t.Fatalf("replay rewrote unchanged row: %s -> %s (%v)", beforeReplayXID, afterReplayXID, err)
	}
	if _, err := r.CancelLinkCheck(ctx, job.ID); err != nil {
		t.Fatal(err)
	}
	result.Sources = append(result.Sources, ref("late"))
	result.OccurrenceCount++
	if err := r.SaveLinkCheck(ctx, *claimed, []models.LinkResult{result}); err != nil {
		t.Fatal(err)
	}
	assertStored("broken", result.Sources[:4])

	// Recovery starts a new generation with an empty persisted source prefix.
	restarting, err := r.CreateLinkCheck(ctx, "https://example.test/restart", "single", 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	restarting, err = r.ClaimLinkCheck(ctx, restarting.ID)
	if err != nil || restarting == nil {
		t.Fatalf("restart claim: %+v %v", restarting, err)
	}
	oldResult := result
	oldResult.ID = mcpOtherScanID
	if err := r.SaveLinkCheck(ctx, *restarting, []models.LinkResult{oldResult}); err != nil {
		t.Fatal(err)
	}
	if err := r.RecoverLinkChecks(ctx); err != nil {
		t.Fatal(err)
	}
	restarting, err = r.ClaimLinkCheck(ctx, restarting.ID)
	if err != nil || restarting == nil {
		t.Fatalf("recover claim: %+v %v", restarting, err)
	}
	newResult := models.LinkResult{ID: "00000000-0000-0000-0000-000000000099", TargetURL: result.TargetURL, Status: "healthy", LinkType: "internal",
		Sources: []models.LinkSource{ref("new-generation")}, OccurrenceCount: 1}
	if err := r.SaveLinkCheck(ctx, *restarting, []models.LinkResult{newResult}); err != nil {
		t.Fatal(err)
	}
	stored, err := r.GetLinkExportResults(ctx, restarting.ID)
	if err != nil || len(stored) != 1 || stored[0].ID != newResult.ID ||
		stored[0].OccurrenceCount != 1 || !reflect.DeepEqual(stored[0].Sources, newResult.Sources) {
		t.Fatalf("new generation retained old source prefix: %+v %v", stored, err)
	}
}

func TestCompanionSeedInventoryAndRetryLifecycleSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	v, _ := viewport.ResolvePreset("")
	for _, status := range []string{"failed", "completed", "cancelled"} {
		t.Run(status, func(t *testing.T) {
			scan, err := r.CreateScanWithLinkCheck(ctx, "https://example.test/sitemap.xml", "sitemap", nil, v)
			if err != nil {
				t.Fatal(err)
			}
			urls, err := r.BulkInsertURLs(ctx, scan.ID, []string{"https://example.test/good", "https://example.test/bad"})
			if err != nil {
				t.Fatal(err)
			}
			if err := r.UpdateURLStatus(ctx, urls[0].ID, "completed"); err != nil {
				t.Fatal(err)
			}
			if err := r.UpdateURLStatus(ctx, urls[1].ID, "failed"); err != nil {
				t.Fatal(err)
			}
			if err := r.UpdateScanStatus(ctx, scan.ID, "completed"); err != nil {
				t.Fatal(err)
			}
			job, err := r.GetScanLinkCheck(ctx, scan.ID)
			if err != nil {
				t.Fatal(err)
			}
			job, err = r.ClaimLinkCheck(ctx, job.ID)
			if err != nil || job == nil || len(job.SeedURLs) != 2 {
				t.Fatalf("seed inventory=%+v %v", job, err)
			}
			execMCPFixture(t, r, ctx, `UPDATE link_checks SET status=$2 WHERE id=$1`, job.ID, status)
			updated, retried, err := r.RetryFailedURLs(ctx, scan.ID)
			if err != nil || updated == nil || retried != 1 || updated.Status != "pending" {
				t.Fatalf("retry=%+v %d %v", updated, retried, err)
			}
			job, err = r.GetLinkCheck(ctx, job.ID)
			if err != nil {
				t.Fatal(err)
			}
			want := status
			if status == "failed" {
				want = "queued"
			}
			if job.Status != want {
				t.Fatalf("%s companion retry=%s want %s", status, job.Status, want)
			}
			if ids, err := r.ReadyLinkCheckIDs(ctx); err != nil {
				t.Fatal(err)
			} else {
				for _, id := range ids {
					if id == job.ID {
						t.Fatal("companion started before accessibility retry finished")
					}
				}
			}
		})
	}
}

func TestCompanionSeedInventoryIsBoundedAndDetachedRecheckRetainsOverflowSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	v, _ := viewport.ResolvePreset("")
	scan, err := r.CreateScanWithLinkCheck(ctx, "https://example.test/sitemap.xml", "sitemap", nil, v)
	if err != nil {
		t.Fatal(err)
	}
	execMCPFixture(t, r, ctx, `INSERT INTO urls(scan_id,url,status) SELECT $1,'https://example.test/'||n,'completed' FROM generate_series(1,900) n`, scan.ID)
	if err := r.UpdateScanStatus(ctx, scan.ID, "completed"); err != nil {
		t.Fatal(err)
	}
	job, err := r.GetScanLinkCheck(ctx, scan.ID)
	if err != nil {
		t.Fatal(err)
	}
	job, err = r.ClaimLinkCheck(ctx, job.ID)
	if err != nil || job == nil || len(job.SeedURLs) != 501 {
		t.Fatalf("boundedseed=%+v %v", job, err)
	}
	recheck, err := r.CreateLinkCheck(ctx, job.URL, job.CheckType, job.MaxPages, job.SeedURLs)
	if err != nil || recheck == nil || recheck.ScanID != nil || len(recheck.SeedURLs) != 501 {
		t.Fatalf("detachedseed=%+v %v", recheck, err)
	}
}

func TestCompanionClaimWaitsForConcurrentParentRetrySQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	v, _ := viewport.ResolvePreset("")
	scan, err := r.CreateScanWithLinkCheck(ctx, "https://example.test/", "single", nil, v)
	if err != nil {
		t.Fatal(err)
	}
	if err := r.UpdateScanStatus(ctx, scan.ID, "completed"); err != nil {
		t.Fatal(err)
	}
	job, err := r.GetScanLinkCheck(ctx, scan.ID)
	if err != nil {
		t.Fatal(err)
	}
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `UPDATE scans SET status='pending' WHERE id=$1`, scan.ID); err != nil {
		t.Fatal(err)
	}
	claimCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	type answer struct {
		job *models.LinkCheck
		err error
	}
	done := make(chan answer, 1)
	go func() { j, err := r.ClaimLinkCheck(claimCtx, job.ID); done <- answer{j, err} }()
	select {
	case got := <-done:
		t.Fatalf("claim ignored uncommittedparentretry: %+v %v", got.job, got.err)
	case <-time.After(50 * time.Millisecond):
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-done:
		if got.err != nil || got.job != nil {
			t.Fatalf("claimstartedonpendingparent: %+v %v", got.job, got.err)
		}
	case <-time.After(time.Second):
		t.Fatal("claim blocked after parentretry committed")
	}
}
