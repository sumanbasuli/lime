package repository

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

const mcpActionRequestID = "44444444-4444-4444-8444-444444444444"

func mcpAdmissionID(n int) string {
	return fmt.Sprintf("55555555-5555-4555-8555-%012x", n)
}

func setMCPAdmissionFixture(t *testing.T, r *Repository, ctx context.Context, accepted int) {
	t.Helper()
	execMCPFixture(t, r, ctx, `UPDATE mcp_action_admission
		SET day_utc = (clock_timestamp() AT TIME ZONE 'UTC')::date, accepted = $1
		WHERE singleton = TRUE`, accepted)
}

func TestMCPActionAdmissionConcurrentDistinctIDsSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	setMCPAdmissionFixture(t, r, ctx, mcpNewRequestIDsPerUTCDay-1)
	config := r.pool.Config()
	config.ConnConfig.RuntimeParams["default_transaction_isolation"] = "repeatable read"
	otherPool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer otherPool.Close()
	other := New(otherPool)
	type outcome struct {
		id      string
		created bool
		err     error
	}
	results := make(chan outcome, 2)
	start := make(chan struct{})
	for i, repo := range []*Repository{r, other} {
		id := mcpAdmissionID(i + 1)
		go func() {
			<-start
			_, created, err := repo.BeginMCPAction(ctx, id, "create_scan", strings.Repeat("a", 64))
			results <- outcome{id, created, err}
		}()
	}
	close(start)
	var admitted, denied string
	for i := 0; i < 2; i++ {
		result := <-results
		if result.created && result.err == nil {
			admitted = result.id
			continue
		}
		var rate *MCPActionRateLimitError
		if !result.created && errors.As(result.err, &rate) {
			denied = result.id
			continue
		}
		t.Fatalf("unexpected concurrent admission result: %+v", result)
	}
	if admitted == "" || denied == "" || admitted == denied {
		t.Fatalf("distinct IDs were not serialized: admitted=%s denied=%s", admitted, denied)
	}
	var used, rows int
	if err := r.pool.QueryRow(ctx, `SELECT accepted FROM mcp_action_admission WHERE singleton = TRUE`).Scan(&used); err != nil {
		t.Fatal(err)
	}
	if err := r.pool.QueryRow(ctx, `SELECT COUNT(*) FROM mcp_action_requests`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if used != mcpNewRequestIDsPerUTCDay || rows != 1 {
		t.Fatalf("rate state or ledger rows changed incorrectly: accepted=%d rows=%d", used, rows)
	}
	var deniedRows int
	if err := r.pool.QueryRow(ctx, `SELECT COUNT(*) FROM mcp_action_requests WHERE request_id = $1`, denied).Scan(&deniedRows); err != nil || deniedRows != 0 {
		t.Fatalf("denied ID left a ledger row: count=%d err=%v", deniedRows, err)
	}
	entry, created, err := other.BeginMCPAction(ctx, admitted, "create_scan", strings.Repeat("a", 64))
	if err != nil || created || entry == nil || len(entry.Response) != 0 {
		t.Fatalf("saturated pending replay failed across pools: %+v created=%v err=%v", entry, created, err)
	}
}

func TestMCPActionAdmissionConcurrentSameIDSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	setMCPAdmissionFixture(t, r, ctx, mcpNewRequestIDsPerUTCDay-1)
	var createdCount atomic.Int32
	var failures atomic.Int32
	start := make(chan struct{})
	var workers sync.WaitGroup
	for i := 0; i < 12; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			<-start
			entry, created, err := r.BeginMCPAction(ctx, mcpAdmissionID(3), "create_scan", strings.Repeat("b", 64))
			if err != nil || entry == nil || entry.ArgumentsHash != strings.Repeat("b", 64) {
				failures.Add(1)
				return
			}
			if created {
				createdCount.Add(1)
			}
		}()
	}
	close(start)
	workers.Wait()
	if createdCount.Load() != 1 || failures.Load() != 0 {
		t.Fatalf("same-ID contenders at the last quota slot: created=%d failures=%d", createdCount.Load(), failures.Load())
	}
	var accepted, rows int
	if err := r.pool.QueryRow(ctx, `SELECT accepted FROM mcp_action_admission WHERE singleton = TRUE`).Scan(&accepted); err != nil {
		t.Fatal(err)
	}
	if err := r.pool.QueryRow(ctx, `SELECT COUNT(*) FROM mcp_action_requests`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if accepted != mcpNewRequestIDsPerUTCDay || rows != 1 {
		t.Fatalf("same-ID contenders consumed excess quota: accepted=%d rows=%d", accepted, rows)
	}
}

func TestMCPActionAdmissionSaturatedReplayAndResetSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	hash := strings.Repeat("c", 64)
	for i, status := range []int{201, 404, 503, 0} {
		id := mcpAdmissionID(i + 10)
		_, created, err := r.BeginMCPAction(ctx, id, "create_scan", hash)
		if err != nil || !created {
			t.Fatalf("fixture reservation %d: created=%v err=%v", i, created, err)
		}
		if status != 0 {
			response := fmt.Sprintf(`{"action":"create_scan","http_status":%d,"request_id":"%s","replayed":false}`, status, id)
			if status == 503 {
				response = fmt.Sprintf(`{"action":"create_scan","http_status":503,"retry_with_new_request_id":true,"request_id":"%s","replayed":false}`, id)
			}
			if err := r.CompleteMCPAction(ctx, id, []byte(response)); err != nil {
				t.Fatal(err)
			}
		}
	}
	setMCPAdmissionFixture(t, r, ctx, mcpNewRequestIDsPerUTCDay)
	restarted := New(r.pool)
	for i, status := range []int{201, 404, 503, 0} {
		id := mcpAdmissionID(i + 10)
		entry, created, err := restarted.BeginMCPAction(ctx, id, "create_scan", hash)
		if err != nil || created || entry == nil {
			t.Fatalf("saturated replay %d: entry=%+v created=%v err=%v", status, entry, created, err)
		}
		if status == 0 {
			if len(entry.Response) != 0 {
				t.Fatal("unfinished reservation gained a response", string(entry.Response))
			}
			continue
		}
		var payload map[string]any
		if err := json.Unmarshal(entry.Response, &payload); err != nil || payload["http_status"] != float64(status) {
			t.Fatalf("saved status %d lost at saturation: %s err=%v", status, entry.Response, err)
		}
		if status == 503 && payload["retry_with_new_request_id"] != true {
			t.Fatal("saved queue-full retry semantics were lost", payload)
		}
	}
	entry, created, err := restarted.BeginMCPAction(ctx, mcpAdmissionID(10), "create_scan", strings.Repeat("d", 64))
	if err != nil || created || entry == nil || entry.ArgumentsHash != hash {
		t.Fatalf("conflicting ID did not reach original reservation: %+v created=%v err=%v", entry, created, err)
	}
	deniedID := mcpAdmissionID(99)
	_, created, err = restarted.BeginMCPAction(ctx, deniedID, "create_scan", hash)
	var rate *MCPActionRateLimitError
	if created || !errors.As(err, &rate) || rate.RetryAfterSeconds < 1 || rate.RetryAfterSeconds > 86401 || rate.RetryAt.UTC().Hour() != 0 || rate.RetryAt.UTC().Minute() != 0 {
		t.Fatalf("new ID at saturation was not denied with UTC retry: created=%v err=%v", created, err)
	}
	var deniedRows int
	if err := r.pool.QueryRow(ctx, `SELECT COUNT(*) FROM mcp_action_requests WHERE request_id = $1`, deniedID).Scan(&deniedRows); err != nil || deniedRows != 0 {
		t.Fatalf("denial persisted a ledger row: count=%d err=%v", deniedRows, err)
	}
	execMCPFixture(t, r, ctx, `UPDATE mcp_action_admission SET day_utc = (clock_timestamp() AT TIME ZONE 'UTC')::date - 1 WHERE singleton = TRUE`)
	_, created, err = restarted.BeginMCPAction(ctx, deniedID, "create_scan", hash)
	if err != nil || !created {
		t.Fatalf("same denied ID was not admitted after UTC reset: created=%v err=%v", created, err)
	}
	var accepted int
	if err := r.pool.QueryRow(ctx, `SELECT accepted FROM mcp_action_admission WHERE singleton = TRUE`).Scan(&accepted); err != nil || accepted != 1 {
		t.Fatalf("new UTC window did not reset to one admission: accepted=%d err=%v", accepted, err)
	}
}

func TestMCPActionAdmissionMigrationSeedsTodayAndKeepsLedgerSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	id := mcpAdmissionID(200)
	hash := strings.Repeat("e", 64)
	execMCPFixture(t, r, ctx, `INSERT INTO mcp_action_requests(request_id, tool, arguments_hash)
		VALUES ($1, 'create_scan', $2)`, id, hash)
	down, err := os.ReadFile("../../migrations/000018_add_mcp_action_admission.down.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.pool.Exec(ctx, string(down)); err != nil {
		t.Fatal("admission down migration failed", err)
	}
	up, err := os.ReadFile("../../migrations/000018_add_mcp_action_admission.up.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.pool.Exec(ctx, string(up)); err != nil {
		t.Fatal("admission up migration failed", err)
	}
	var accepted int
	if err := r.pool.QueryRow(ctx, `SELECT accepted FROM mcp_action_admission WHERE singleton = TRUE`).Scan(&accepted); err != nil || accepted != 1 {
		t.Fatalf("upgrade did not count existing today's ID: accepted=%d err=%v", accepted, err)
	}
	entry, created, err := r.BeginMCPAction(ctx, id, "create_scan", hash)
	if err != nil || created || entry == nil || entry.ArgumentsHash != hash {
		t.Fatalf("migration lost permanent reservation: %+v created=%v err=%v", entry, created, err)
	}
}

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
