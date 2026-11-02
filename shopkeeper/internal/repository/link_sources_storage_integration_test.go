package repository

import (
	"context"
	"fmt"
	"os"
	"reflect"
	"testing"

	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
)

// A hot target gains references on every page. Previously each publication
// rewrote its entire growing JSONB source array even though Go sent a suffix.
func TestLinkSourcePublicationsKeepStoredPrefixesImmutableSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	job, err := r.CreateLinkCheck(ctx, "https://example.test/", "crawl", 500, nil)
	if err != nil {
		t.Fatal(err)
	}
	job, err = r.ClaimLinkCheck(ctx, job.ID)
	if err != nil || job == nil {
		t.Fatalf("claim: %+v %v", job, err)
	}
	result := models.LinkResult{ID: mcpURLID, TargetURL: "https://example.test/hot", Status: "healthy", LinkType: "internal"}
	for page := 0; page < 20; page++ {
		for anchor := 0; anchor < 10; anchor++ {
			result.Sources = append(result.Sources, models.LinkSource{PageURL: fmt.Sprintf("https://example.test/page/%d", page), Element: "a", Attribute: "href", Text: fmt.Sprintf("anchor-%d-%d", page, anchor)})
		}
		result.OccurrenceCount = len(result.Sources)
		job.PagesChecked = page + 1
		if err := r.SaveLinkCheck(ctx, *job, []models.LinkResult{result}); err != nil {
			t.Fatal(err)
		}
	}
	var parentSources int
	if err := r.pool.QueryRow(ctx, `SELECT jsonb_array_length(sources) FROM link_check_results WHERE id=$1`, result.ID).Scan(&parentSources); err != nil {
		t.Fatal(err)
	}
	if parentSources != 0 {
		t.Fatalf("hot-target progress still retains and rewrites a growing parent JSONB array: %d sources", parentSources)
	}
	var rowCount, versions int
	if err := r.pool.QueryRow(ctx, `SELECT COUNT(*),COUNT(DISTINCT xmin::text) FROM link_check_sources WHERE result_id=$1`, result.ID).Scan(&rowCount, &versions); err != nil {
		t.Fatal(err)
	}
	if rowCount != 200 || versions != 20 {
		t.Fatalf("append-only source history: rows=%d publication versions=%d", rowCount, versions)
	}
	stored, err := r.GetLinkExportResults(ctx, job.ID)
	if err != nil || len(stored) != 1 || !reflect.DeepEqual(stored[0].Sources, result.Sources) {
		t.Fatalf("complete ordered sources changed: %+v %v", stored, err)
	}
	if err := r.SaveLinkCheck(ctx, *job, []models.LinkResult{result}); err != nil {
		t.Fatal(err)
	}
	var replayCount, replayVersions int
	if err := r.pool.QueryRow(ctx, `SELECT COUNT(*),COUNT(DISTINCT xmin::text) FROM link_check_sources WHERE result_id=$1`, result.ID).Scan(&replayCount, &replayVersions); err != nil || replayCount != rowCount || replayVersions != versions {
		t.Fatalf("replay changed stored sources: rows=%d versions=%d (%v)", replayCount, replayVersions, err)
	}
	oldID := result.ID
	result.ID = mcpOtherScanID
	if err := r.SaveLinkCheck(ctx, *job, []models.LinkResult{result}); err != nil {
		t.Fatal(err)
	}
	var oldRows int
	if err := r.pool.QueryRow(ctx, `SELECT COUNT(*) FROM link_check_sources WHERE result_id=$1`, oldID).Scan(&oldRows); err != nil || oldRows != 0 {
		t.Fatalf("result ID replacement retained old source ownership: %d %v", oldRows, err)
	}
	stored, err = r.GetLinkExportResults(ctx, job.ID)
	if err != nil || len(stored) != 1 || stored[0].ID != result.ID || !reflect.DeepEqual(stored[0].Sources, result.Sources) {
		t.Fatalf("result ID replacement lost sources: %+v %v", stored, err)
	}
}

func TestLinkSourceRowsLegacyMigrationAndDowngradeSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	job, err := r.CreateLinkCheck(ctx, "https://example.test/", "crawl", 500, nil)
	if err != nil {
		t.Fatal(err)
	}
	job, err = r.ClaimLinkCheck(ctx, job.ID)
	if err != nil || job == nil {
		t.Fatalf("claim: %+v %v", job, err)
	}
	down, err := os.ReadFile("../../migrations/000019_add_link_source_rows.down.sql")
	if err != nil {
		t.Fatal(err)
	}
	up, err := os.ReadFile("../../migrations/000019_add_link_source_rows.up.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.pool.Exec(ctx, string(down)); err != nil {
		t.Fatal(err)
	}
	if _, err := r.pool.Exec(ctx, `INSERT INTO link_check_results(id,link_check_id,target_url,status,link_type,occurrence_count,sources)
		VALUES ($1,$2,'https://example.test/hot','healthy','internal',2,
		'[{"page_url":"https://example.test/one","element":"a","attribute":"href","text":"Repeated"},
		  {"page_url":"https://example.test/two","element":"a","attribute":"href","text":"Repeated"}]')`, mcpURLID, job.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := r.pool.Exec(ctx, string(up)); err != nil {
		t.Fatal(err)
	}
	legacy, err := r.GetLinkExportResults(ctx, job.ID)
	if err != nil || len(legacy) != 1 || len(legacy[0].Sources) != 2 {
		t.Fatalf("legacy read after upgrade: %+v %v", legacy, err)
	}
	result := legacy[0]
	result.Sources = append(result.Sources, result.Sources[0]) // duplicates are real occurrences
	result.OccurrenceCount++
	job.PagesChecked = 1
	if err := r.SaveLinkCheck(ctx, *job, []models.LinkResult{result}); err != nil {
		t.Fatal(err)
	}
	var storage, legacyCount, rows int
	if err := r.pool.QueryRow(ctx, `SELECT sources_storage,jsonb_array_length(sources),
		(SELECT COUNT(*) FROM link_check_sources WHERE result_id=r.id)
		FROM link_check_results r WHERE id=$1`, result.ID).Scan(&storage, &legacyCount, &rows); err != nil || storage != 1 || legacyCount != 0 || rows != 3 {
		t.Fatalf("legacy conversion: storage=%d json=%d rows=%d (%v)", storage, legacyCount, rows, err)
	}
	if _, err := r.pool.Exec(ctx, `UPDATE link_check_results SET occurrence_count=4 WHERE id=$1`, result.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := r.pool.Exec(ctx, string(down)); err == nil {
		t.Fatal("incomplete source history was silently downgraded")
	}
	if _, err := r.pool.Exec(ctx, `UPDATE link_check_results SET occurrence_count=3 WHERE id=$1`, result.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := r.pool.Exec(ctx, string(down)); err != nil {
		t.Fatal(err)
	}
	if err := r.pool.QueryRow(ctx, `SELECT jsonb_array_length(sources) FROM link_check_results WHERE id=$1`, result.ID).Scan(&legacyCount); err != nil || legacyCount != 3 {
		t.Fatalf("downgrade lost source rows: %d %v", legacyCount, err)
	}
	if _, err := r.pool.Exec(ctx, string(up)); err != nil {
		t.Fatal(err)
	}
	stored, err := r.GetLinkExportResults(ctx, job.ID)
	if err != nil || len(stored) != 1 || !reflect.DeepEqual(stored[0].Sources, result.Sources) {
		t.Fatalf("down/up changed ordered duplicates: %+v %v", stored, err)
	}
	if _, err := r.pool.Exec(ctx, `UPDATE link_check_results SET occurrence_count=99 WHERE id=$1`, result.ID); err != nil {
		t.Fatal(err)
	}
	job.PagesChecked = 2
	if err := r.SaveLinkCheck(ctx, *job, []models.LinkResult{result}); err == nil {
		t.Fatal("inconsistent legacy sources were silently converted")
	}
	current, err := r.GetLinkCheck(ctx, job.ID)
	if err != nil || current.PagesChecked != 1 {
		t.Fatalf("rejected legacy conversion committed progress: %+v %v", current, err)
	}
}

func TestLinkSourceRowsLargePagesBudgetsAndCascadeSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	job, err := r.CreateLinkCheck(ctx, "https://example.test/", "crawl", 500, nil)
	if err != nil {
		t.Fatal(err)
	}
	job, err = r.ClaimLinkCheck(ctx, job.ID)
	if err != nil || job == nil {
		t.Fatalf("claim: %+v %v", job, err)
	}
	result := models.LinkResult{ID: mcpURLID, TargetURL: "https://example.test/hot", Status: "healthy", LinkType: "internal", OccurrenceCount: 10000}
	for i := 0; i < result.OccurrenceCount; i++ {
		result.Sources = append(result.Sources, models.LinkSource{PageURL: fmt.Sprintf("https://example.test/%d", i), Element: "a", Attribute: "href", Text: fmt.Sprintf("source-%d", i)})
	}
	if err := r.SaveLinkCheck(ctx, *job, []models.LinkResult{result}); err != nil {
		t.Fatal(err)
	}
	preview, total, err := r.GetLinkResults(ctx, job.ID, "", 1, 0)
	if err != nil || total != 1 || len(preview) != 1 || !reflect.DeepEqual(preview[0].Sources, result.Sources[:5]) {
		t.Fatalf("source preview changed: %+v total=%d %v", preview, total, err)
	}
	for _, offset := range []int{0, 4999, 9999, 10000} {
		page, total, found, err := r.GetLinkSources(ctx, job.ID, result.ID, 2, offset)
		end := min(offset+2, len(result.Sources))
		if err != nil || !found || total != 10000 || !reflect.DeepEqual(page, result.Sources[offset:end]) {
			t.Fatalf("source page at %d changed: rows=%d total=%d found=%v %v", offset, len(page), total, found, err)
		}
	}
	var exported int
	if err := r.StreamLinkExportRows(ctx, job.ID, func(item models.LinkResult, source models.LinkSource) error {
		if item.ID != result.ID || source != result.Sources[exported] {
			return fmt.Errorf("source export ordering changed at %d", exported)
		}
		exported++
		return nil
	}); err != nil || exported != len(result.Sources) {
		t.Fatalf("source export count=%d %v", exported, err)
	}
	// A huge retained source outside the selected slice must not poison small
	// MCP reads, while selecting that source must fail before transfer to Go.
	if _, err := r.pool.Exec(ctx, `UPDATE link_check_sources SET source=jsonb_set(source,'{text}',to_jsonb(repeat('x',6*1024*1024)))
		WHERE result_id=$1 AND ordinal=9999`, result.ID); err != nil {
		t.Fatal(err)
	}
	if err := withMCPBudgetRead(t, r, ctx, func(readCtx context.Context) error {
		_, _, err := r.GetLinkResults(readCtx, job.ID, "", 1, 0)
		return err
	}); err != nil {
		t.Fatalf("unselected row source poisoned preview: %v", err)
	}
	if err := withMCPBudgetRead(t, r, ctx, func(readCtx context.Context) error {
		_, _, _, err := r.GetLinkSources(readCtx, job.ID, result.ID, 1, 9998)
		return err
	}); err != nil {
		t.Fatalf("unselected row source poisoned source page: %v", err)
	}
	requireMCPReadTooLarge(t, withMCPBudgetRead(t, r, ctx, func(readCtx context.Context) error {
		_, _, _, err := r.GetLinkSources(readCtx, job.ID, result.ID, 1, 9999)
		return err
	}))
	if _, err := r.pool.Exec(ctx, `UPDATE link_check_sources SET source=jsonb_set(source,'{text}',to_jsonb(repeat('x',6*1024*1024)))
		WHERE result_id=$1 AND ordinal=0`, result.ID); err != nil {
		t.Fatal(err)
	}
	requireMCPReadTooLarge(t, withMCPBudgetRead(t, r, ctx, func(readCtx context.Context) error {
		_, _, err := r.GetLinkResults(readCtx, job.ID, "", 1, 0)
		return err
	}))
	if _, err := r.CancelLinkCheck(ctx, job.ID); err != nil {
		t.Fatal(err)
	}
	if ok, err := r.DeleteLinkCheck(ctx, job.ID); err != nil || !ok {
		t.Fatalf("delete: %v %v", ok, err)
	}
	var remaining int
	if err := r.pool.QueryRow(ctx, `SELECT COUNT(*) FROM link_check_sources WHERE result_id=$1`, result.ID).Scan(&remaining); err != nil || remaining != 0 {
		t.Fatalf("deleted job retained source rows: %d %v", remaining, err)
	}
}

func TestLinkSourceRowExportKeepsOneSnapshotSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	job, err := r.CreateLinkCheck(ctx, "https://example.test/", "single", 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	job, err = r.ClaimLinkCheck(ctx, job.ID)
	if err != nil || job == nil {
		t.Fatalf("claim: %+v %v", job, err)
	}
	result := models.LinkResult{ID: mcpURLID, TargetURL: "https://example.test/a", Status: "healthy", LinkType: "internal", OccurrenceCount: 2,
		Sources: []models.LinkSource{{PageURL: "https://example.test/one"}, {PageURL: "https://example.test/two"}}}
	empty := models.LinkResult{ID: mcpOtherScanID, TargetURL: "https://example.test/z", Status: "unchecked", LinkType: "internal"}
	if err := r.SaveLinkCheck(ctx, *job, []models.LinkResult{result, empty}); err != nil {
		t.Fatal(err)
	}
	var seen []string
	err = r.StreamLinkExportRows(ctx, job.ID, func(item models.LinkResult, source models.LinkSource) error {
		seen = append(seen, source.PageURL)
		if len(seen) == 1 {
			result.Sources = append(result.Sources, models.LinkSource{PageURL: "https://example.test/later"})
			result.OccurrenceCount++
			return r.SaveLinkCheck(ctx, *job, []models.LinkResult{result})
		}
		if item.TargetURL == result.TargetURL && item.OccurrenceCount != 2 {
			return fmt.Errorf("export mixed progress generations: %d", item.OccurrenceCount)
		}
		return nil
	})
	if err != nil || !reflect.DeepEqual(seen, []string{"https://example.test/one", "https://example.test/two", ""}) {
		t.Fatalf("row-backed export mixed snapshots/empty result: %+v %v", seen, err)
	}
	stored, err := r.GetLinkExportResults(ctx, job.ID)
	if err != nil || len(stored) != 2 || !reflect.DeepEqual(stored[0].Sources, result.Sources) {
		t.Fatalf("concurrent publication did not commit: %+v %v", stored, err)
	}
}
