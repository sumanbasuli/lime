package repository

import (
	"testing"
)

func TestScanListPageBoundsTagAndStableOrderSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	execMCPFixture(t, r, ctx, `INSERT INTO scans (id,sitemap_url,status,tag,created_at)
		SELECT md5(n::text)::uuid,'https://fixture.test/' || n,'completed',
			CASE WHEN n<=1000 THEN 'production' ELSE 'other' END,
			TIMESTAMPTZ '2026-01-01 00:00:00+00'
		FROM generate_series(1,1001) n`)

	all, err := r.ListScansPage(ctx, "", 1001, 0)
	if err != nil || len(all) != 1001 {
		t.Fatalf("bounded sentinel returned %d scans: %v", len(all), err)
	}
	for i := 1; i < len(all); i++ {
		if all[i-1].ID <= all[i].ID {
			t.Fatalf("tied created_at order is unstable at %d: %s <= %s", i, all[i-1].ID, all[i].ID)
		}
	}
	production, err := r.ListScansPage(ctx, "production", 1001, 0)
	if err != nil || len(production) != 1000 {
		t.Fatalf("exact tagged threshold returned %d scans: %v", len(production), err)
	}
	for _, scan := range production {
		if scan.Tag == nil || *scan.Tag != "production" {
			t.Fatalf("tag filter leaked scan %+v", scan)
		}
	}
	other, err := r.ListScansPage(ctx, "other", 200, 0)
	if err != nil || len(other) != 1 {
		t.Fatalf("other tag returned %d scans: %v", len(other), err)
	}

	var paged []string
	for offset := 0; offset < 1001; offset += 200 {
		items, err := r.ListScansPage(ctx, "", 200, offset)
		if err != nil {
			t.Fatal(err)
		}
		for _, scan := range items {
			paged = append(paged, scan.ID)
		}
	}
	if len(paged) != len(all) {
		t.Fatalf("pages yielded %d of %d scans", len(paged), len(all))
	}
	for i, scan := range all {
		if paged[i] != scan.ID {
			t.Fatalf("page seam at %d: got %s want %s", i, paged[i], scan.ID)
		}
	}
	past, err := r.ListScansPage(ctx, "", 200, 1001)
	if err != nil || len(past) != 0 {
		t.Fatalf("past-end page = %d rows: %v", len(past), err)
	}
	for _, args := range [][2]int{{0, 0}, {1002, 0}, {1, -1}, {1, 1_000_001}} {
		if _, err := r.ListScansPage(ctx, "", args[0], args[1]); err == nil {
			t.Fatalf("accepted invalid page limit=%d offset=%d", args[0], args[1])
		}
	}
}
