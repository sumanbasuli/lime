package repository

import (
	"encoding/json"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

const mcpActionRequestID = "44444444-4444-4444-8444-444444444444"

func TestMCPActionLedgerDurabilityAndConcurrentReservationSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	hash := strings.Repeat("a", 64)
	var reserved atomic.Int32
	var failures atomic.Int32
	var workers sync.WaitGroup
	for i := 0; i < 12; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			entry, created, err := r.BeginMCPAction(ctx, mcpActionRequestID, "create_scan", hash)
			if err != nil || entry == nil || entry.Tool != "create_scan" || entry.ArgumentsHash != hash {
				failures.Add(1)
				return
			}
			if created {
				reserved.Add(1)
			}
		}()
	}
	workers.Wait()
	if failures.Load() != 0 || reserved.Load() != 1 {
		t.Fatalf("concurrent reservations: new=%d failures=%d", reserved.Load(), failures.Load())
	}
	entry, created, err := r.BeginMCPAction(ctx, mcpActionRequestID, "create_scan", hash)
	if err != nil || created || len(entry.Response) != 0 {
		t.Fatalf("unfinished request was rerun: %+v/%v/%v", entry, created, err)
	}
	response := []byte(`{"action":"create_scan","http_status":201,"data":{"id":"` + mcpScanID + `"},"request_id":"` + mcpActionRequestID + `","replayed":false}`)
	if err := r.CompleteMCPAction(ctx, mcpActionRequestID, response); err != nil {
		t.Fatal(err)
	}
	// A newly constructed repository models a process restart over persisted SQL.
	restarted := New(r.pool)
	entry, created, err = restarted.BeginMCPAction(ctx, mcpActionRequestID, "create_link_check", strings.Repeat("b", 64))
	if err != nil || created || entry.Tool != "create_scan" || entry.ArgumentsHash != hash {
		t.Fatalf("request reuse overwrote original operation: %+v/%v/%v", entry, created, err)
	}
	var payload map[string]any
	if err := json.Unmarshal(entry.Response, &payload); err != nil || payload["http_status"] != float64(201) || payload["data"].(map[string]any)["id"] != mcpScanID {
		t.Fatalf("restart lost replay data: %s (%v)", entry.Response, err)
	}
	if err := restarted.CompleteMCPAction(ctx, mcpActionRequestID, []byte(`{"changed":true}`)); err == nil {
		t.Fatal("completed replay response could be overwritten")
	}
	var total int
	if err := r.pool.QueryRow(ctx, `SELECT COUNT(*) FROM mcp_action_requests`).Scan(&total); err != nil || total != 1 {
		t.Fatal("duplicate ledger rows", total, err)
	}
}

func TestMCPWriteAccessUpgradeDefaultsAndMigrationReversibilitySQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	execMCPFixture(t, r, ctx, `UPDATE app_settings SET mcp_enabled = true, mcp_key_hash = $1 WHERE key = 'global'`, strings.Repeat("c", 64))
	auth, err := r.GetMCPAuthSettings(ctx)
	if err != nil || !auth.Enabled || auth.KeyHash == nil || auth.AllowWrites {
		t.Fatal("configured old key gained write access", auth, err)
	}
	visible, err := r.GetMCPVisibleSettings(ctx)
	if err != nil || visible.Integrations["mcp_allow_writes"] != false || visible.Integrations["mcp_mode"] != "read_only" {
		t.Fatal("default visible mode is not read-only", visible, err)
	}
	execMCPFixture(t, r, ctx, `UPDATE app_settings SET mcp_allow_writes = true WHERE key = 'global'`)
	visible, err = r.GetMCPVisibleSettings(ctx)
	if err != nil || visible.Integrations["mcp_allow_writes"] != true || visible.Integrations["mcp_mode"] != "read_write" {
		t.Fatal("opt-in mode not visible", visible, err)
	}
	down, err := os.ReadFile("../../migrations/000014_add_mcp_actions.down.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.pool.Exec(ctx, string(down)); err != nil {
		t.Fatal("down migration failed", err)
	}
	var enabled bool
	var key string
	if err := r.pool.QueryRow(ctx, `SELECT mcp_enabled, mcp_key_hash FROM app_settings WHERE key = 'global'`).Scan(&enabled, &key); err != nil || !enabled || key != strings.Repeat("c", 64) {
		t.Fatal("down migration harmed existing MCP credentials", err)
	}
	up, err := os.ReadFile("../../migrations/000014_add_mcp_actions.up.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.pool.Exec(ctx, string(up)); err != nil {
		t.Fatal("up migration failed", err)
	}
	auth, err = r.GetMCPAuthSettings(ctx)
	if err != nil || !auth.Enabled || auth.AllowWrites {
		t.Fatal("re-upgrade silently broadened existing key", auth, err)
	}
}
