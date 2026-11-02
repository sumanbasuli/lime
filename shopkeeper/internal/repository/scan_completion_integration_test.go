package repository

import (
	"errors"
	"testing"
)

func TestCompleteReadyScanHonorsPauseAndDiscoveryPublication(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	var id string
	if err := r.pool.QueryRow(ctx, `INSERT INTO scans(sitemap_url,scan_type,status,total_urls,pause_requested)
		VALUES('https://example.test/sitemap.xml','sitemap','scanning',1,TRUE) RETURNING id`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	if _, err := r.pool.Exec(ctx, `INSERT INTO scan_discoveries(scan_id,phase) VALUES($1,'probe')`, id); err != nil {
		t.Fatal(err)
	}
	if _, err := r.pool.Exec(ctx, `INSERT INTO urls(scan_id,url,status) VALUES($1,'https://example.test/a','completed')`, id); err != nil {
		t.Fatal(err)
	}
	if _, err := r.CompleteReadyScan(ctx, id); !errors.Is(err, ErrDiscoveryInvariant) {
		t.Fatalf("partial discovery completed: %v", err)
	}
	if _, err := r.pool.Exec(ctx, `UPDATE scan_discoveries SET phase='complete' WHERE scan_id=$1`, id); err != nil {
		t.Fatal(err)
	}
	status, err := r.CompleteReadyScan(ctx, id)
	if err != nil || status != "paused" {
		t.Fatalf("completion ignored pause: status=%q err=%v", status, err)
	}
	scan, err := r.GetScan(ctx, id)
	if err != nil || scan.Status != "paused" || scan.PauseRequested {
		t.Fatalf("paused state = %+v, %v", scan, err)
	}
}
