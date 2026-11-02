package repository

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

// A saved JSONB response must be size-checked in SQL before its bytes cross
// into Go. Existing IDs bypass daily new-ID admission even when oversized.
func TestMCPActionOversizeSavedResponseProjectionSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	const largeID = "66666666-6666-4666-8666-666666666666"
	const smallID = "77777777-7777-4777-8777-777777777777"
	hash := strings.Repeat("a", 64)
	for _, id := range []string{largeID, smallID} {
		if _, created, err := r.BeginMCPAction(ctx, id, "create_scan", hash); err != nil || !created {
			t.Fatalf("reserve %s: created=%v err=%v", id, created, err)
		}
	}
	large := []byte(`{"action":"create_scan","http_status":201,"data":{"text":"` + strings.Repeat("a", 6<<20) + `"}}`)
	small := []byte(`{"action":"create_scan","http_status":201,"data":{"id":"small"}}`)
	if err := r.CompleteMCPAction(ctx, largeID, large); err != nil {
		t.Fatal(err)
	}
	if err := r.CompleteMCPAction(ctx, smallID, small); err != nil {
		t.Fatal(err)
	}
	setMCPAdmissionFixture(t, r, ctx, mcpNewRequestIDsPerUTCDay)

	entry, created, err := r.BeginMCPAction(ctx, smallID, "create_scan", hash)
	if err != nil || created || entry == nil || entry.ResponseTooLarge {
		t.Fatalf("small replay failed at saturated quota: created=%v entry=%+v err=%v", created, entry, err)
	}
	var payload map[string]any
	if err := json.Unmarshal(entry.Response, &payload); err != nil || payload["http_status"] != float64(201) || payload["data"].(map[string]any)["id"] != "small" {
		t.Fatalf("small replay lost saved result: response=%s err=%v", entry.Response, err)
	}

	entry, created, err = r.BeginMCPAction(ctx, largeID, "create_scan", hash)
	if err != nil || created || entry == nil || entry.Tool != "create_scan" || entry.ArgumentsHash != hash || !entry.ResponseTooLarge || len(entry.Response) != 0 {
		t.Fatalf("large replay transferred saved response: created=%v entry=%+v err=%v", created, entry, err)
	}
	var storedBytes, accepted int
	if err := r.pool.QueryRow(ctx, `SELECT octet_length(response::text) FROM mcp_action_requests WHERE request_id = $1`, largeID).Scan(&storedBytes); err != nil {
		t.Fatal(err)
	}
	if err := r.pool.QueryRow(ctx, `SELECT accepted FROM mcp_action_admission WHERE singleton = TRUE`).Scan(&accepted); err != nil {
		t.Fatal(err)
	}
	if storedBytes < 6<<20 || accepted != mcpNewRequestIDsPerUTCDay {
		t.Fatalf("replay changed ledger or quota: stored_bytes=%d accepted=%d", storedBytes, accepted)
	}
}

func TestMCPActionCanceledCallRetainsUncertainSQLLease(t *testing.T) {
	r, fixtureCtx := mcpTestRepository(t)
	parent, cancel := context.WithCancel(fixtureCtx)
	callCtx, finish, err := r.BeginMCPActionCall(parent)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	const id = "88888888-8888-4888-8888-888888888888"
	if _, reserved, err := r.BeginMCPAction(callCtx, id, "create_scan", strings.Repeat("a", 64)); err != nil || !reserved {
		cancel()
		t.Fatalf("could not exercise action SQL guard: reserved=%v err=%v", reserved, err)
	}
	cancel()
	retainUntil := finish()
	if retainUntil.Before(time.Now().Add(15 * time.Second)) {
		t.Fatalf("canceled action did not retain its uncertain SQL lease: until=%s", retainUntil)
	}
}

func TestMCPActionRecheckSeedCompatibilitySQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	cases := []struct {
		name, id, kind, seeds string
		wantEmptyError        bool
	}{
		{"null element", "99999999-1111-4111-8111-111111111111", "crawl", `["https://example.test/a",null]`, false},
		{"top-level null ordinary", "99999999-2222-4222-8222-222222222222", "crawl", `null`, false},
		{"top-level null scan", "99999999-3333-4333-8333-333333333333", "scan", `null`, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			execMCPFixture(t, r, ctx, `INSERT INTO link_checks(id,url,check_type,status,max_pages,seed_urls)
				VALUES ($1,'https://example.test/a',$2,'completed',1,$3::jsonb)`, tc.id, tc.kind, tc.seeds)
			callCtx, finish, err := r.BeginMCPActionCall(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer finish()
			created, err := r.CreateLinkCheckFrom(callCtx, tc.id)
			if tc.wantEmptyError {
				if !errors.Is(err, ErrRecheckEmptyInventory) || created != nil {
					t.Fatalf("empty scan inventory was copied: created=%+v err=%v", created, err)
				}
				return
			}
			if err != nil || created == nil || len(created.SeedURLs) != 0 {
				t.Fatalf("hidden seed projection changed recheck: created=%+v err=%v", created, err)
			}
			var same bool
			if err := r.pool.QueryRow(ctx, `SELECT source.seed_urls = copied.seed_urls
				FROM link_checks source, link_checks copied
				WHERE source.id=$1 AND copied.id=$2`, tc.id, created.ID).Scan(&same); err != nil || !same {
				t.Fatalf("recheck changed saved seed JSON: same=%v err=%v", same, err)
			}
		})
	}
}
