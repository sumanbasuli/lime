package repository

import (
	"context"
	"fmt"
	"testing"

	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
)

func TestStreamLinkExportRowsOrderEmptySourcesAndSnapshotSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	job, err := r.CreateLinkCheck(ctx, "https://example.test/", "single", 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.pool.Exec(ctx, `INSERT INTO link_check_results(link_check_id,target_url,status,link_type,occurrence_count,sources)
		VALUES ($1,'https://example.test/a','healthy','internal',2,
		'[{"page_url":"https://example.test/one","element":"a","attribute":"href","text":"One"},
		  {"page_url":"https://example.test/two","element":"a","attribute":"href","text":"Two"}]'::jsonb),
		($1,'https://example.test/z','unchecked','internal',0,'[]'::jsonb)`, job.ID); err != nil {
		t.Fatal(err)
	}
	type observed struct {
		target string
		page   string
	}
	got := []observed{}
	err = r.StreamLinkExportRows(ctx, job.ID, func(item models.LinkResult, source models.LinkSource) error {
		got = append(got, observed{item.TargetURL, source.PageURL})
		if len(got) == 1 {
			// This executes on another pooled connection while the export's
			// SELECT remains open. The export must keep its original snapshot.
			_, err := r.pool.Exec(ctx, `UPDATE link_check_results SET sources=sources ||
				'[{"page_url":"https://example.test/later","element":"a","attribute":"href","text":"Later"}]'::jsonb,
				occurrence_count=3 WHERE link_check_id=$1 AND target_url='https://example.test/a'`, job.ID)
			return err
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []observed{
		{"https://example.test/a", "https://example.test/one"},
		{"https://example.test/a", "https://example.test/two"},
		{"https://example.test/z", ""},
	}
	if len(got) != len(want) {
		t.Fatalf("export rows=%+v, want %+v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("row %d=%+v, want %+v", i, got[i], want[i])
		}
	}
	var newCount int
	if err := r.pool.QueryRow(ctx, `SELECT jsonb_array_length(sources) FROM link_check_results
		WHERE link_check_id=$1 AND target_url='https://example.test/a'`, job.ID).Scan(&newCount); err != nil || newCount != 3 {
		t.Fatalf("concurrent update count=%d err=%v", newCount, err)
	}
}

func TestStreamLinkExportRowsLargeSourceArraySQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	job, err := r.CreateLinkCheck(ctx, "https://example.test/", "single", 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.pool.Exec(ctx, `INSERT INTO link_check_results(link_check_id,target_url,status,link_type,occurrence_count,sources)
		SELECT $1,'https://example.test/shared','healthy','internal',10000,
			jsonb_agg(jsonb_build_object('page_url','https://example.test/page/' || n,
				'element','a','attribute','href','text','Reference') ORDER BY n)
		FROM generate_series(1,10000) n`, job.ID); err != nil {
		t.Fatal(err)
	}
	var count int
	first, last := "", ""
	if err := r.StreamLinkExportRows(ctx, job.ID, func(item models.LinkResult, source models.LinkSource) error {
		if item.TargetURL != "https://example.test/shared" || item.OccurrenceCount != 10000 {
			return fmt.Errorf("unexpected streamed result: %+v", item)
		}
		count++
		if count == 1 {
			first = source.PageURL
		}
		last = source.PageURL
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if count != 10000 || first != "https://example.test/page/1" || last != "https://example.test/page/10000" {
		t.Fatalf("streamed %d sources, first=%q last=%q", count, first, last)
	}
}

func TestStreamLinkExportRowsCancelledSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	job, err := r.CreateLinkCheck(ctx, "https://example.test/", "single", 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.pool.Exec(ctx, `INSERT INTO link_check_results(link_check_id,target_url,status,link_type,occurrence_count,sources)
		VALUES ($1,'https://example.test/a','healthy','internal',1,
		'[{"page_url":"https://example.test/one"}]'::jsonb)`, job.ID); err != nil {
		t.Fatal(err)
	}
	cancelCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	err = r.StreamLinkExportRows(cancelCtx, job.ID, func(models.LinkResult, models.LinkSource) error {
		cancel()
		return nil
	})
	if err != context.Canceled {
		t.Fatalf("cancellation=%v, want context.Canceled", err)
	}
}
