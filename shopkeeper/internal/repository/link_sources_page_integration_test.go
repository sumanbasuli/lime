package repository

import (
	"fmt"
	"testing"
)

// The stored source array can reach the 10,000-reference job limit. Paginated
// reads must keep their established ordering and total without materializing
// the whole array in Go for a one- or two-reference response.
func TestLinkSourcesLargeJSONBPageSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	job, err := r.CreateLinkCheck(ctx, "https://example.test/", "crawl", 500, nil)
	if err != nil {
		t.Fatal(err)
	}
	other, err := r.CreateLinkCheck(ctx, "https://other.test/", "single", 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	const resultID = "88888888-8888-4888-8888-888888888888"
	_, err = r.pool.Exec(ctx, `INSERT INTO link_check_results
		(id,link_check_id,target_url,status,link_type,occurrence_count,sources)
		SELECT $1,$2,'https://example.test/target','healthy','internal',10000,
			(SELECT jsonb_agg(jsonb_build_object('page_url','https://example.test/page/' || i,
				'element','a','attribute','href','text','source-' || i) ORDER BY i)
			 FROM generate_series(1,10000) AS i)`, resultID, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	var fullBytes int
	if err := r.pool.QueryRow(ctx, `SELECT octet_length(sources::text) FROM link_check_results WHERE id=$1`, resultID).Scan(&fullBytes); err != nil {
		t.Fatal(err)
	}
	var projected []byte
	var projectedTotal int
	if err := r.pool.QueryRow(ctx, linkSourcesPageSQL, job.ID, resultID, 0, 2).Scan(&projectedTotal, &projected); err != nil {
		t.Fatal(err)
	}
	if projectedTotal != 10000 || fullBytes < 500000 || len(projected) > 1000 {
		t.Fatalf("unexpected source projection: total=%d full=%d projected=%d", projectedTotal, fullBytes, len(projected))
	}
	for _, tc := range []struct {
		name   string
		limit  int
		offset int
		want   []int
	}{
		{"first", 2, 0, []int{1, 2}},
		{"middle", 2, 4999, []int{5000, 5001}},
		{"last", 2, 9999, []int{10000}},
		{"past end", 2, 10000, []int{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			items, total, found, err := r.GetLinkSources(ctx, job.ID, resultID, tc.limit, tc.offset)
			if err != nil || !found || total != 10000 || len(items) != len(tc.want) {
				t.Fatalf("page total=%d found=%v items=%d: %v", total, found, len(items), err)
			}
			for i, n := range tc.want {
				if want := fmt.Sprintf("source-%d", n); items[i].Text != want {
					t.Fatalf("source[%d]=%q, want %q", i, items[i].Text, want)
				}
			}
		})
	}
	if items, total, found, err := r.GetLinkSources(ctx, other.ID, resultID, 2, 0); err != nil || found || total != 0 || items != nil {
		t.Fatalf("cross-check result leaked: found=%v total=%d items=%v err=%v", found, total, items, err)
	}
	for _, tc := range []struct{ limit, offset int }{
		{0, 0}, {201, 0}, {1, -1}, {1, 1000001},
	} {
		if _, _, _, err := r.GetLinkSources(ctx, job.ID, resultID, tc.limit, tc.offset); err == nil {
			t.Fatalf("invalid page accepted: limit=%d offset=%d", tc.limit, tc.offset)
		}
	}
}
