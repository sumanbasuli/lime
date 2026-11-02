package mcp

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/sumanbasuli/lime/shopkeeper/internal/handler"
)

// Exercise the actual handlers and durable SQL through HTTP, without launching
// scanner workers or fetching any target URL.
func TestMCPActionHTTPWithRealHandlersAndSQL(t *testing.T) {
	catalog, err := filepath.Abs("../../../data/act-rules.json")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("ACT_RULES_PATH", catalog)
	repo, pool, ctx := nativeMCPReadSQLFixture(t)
	mcpSQLExec(t, pool, ctx, `UPDATE app_settings SET mcp_allow_writes=TRUE WHERE key='global'`)
	h := handler.New(repo, nil, nil).WithLinkChecker(repo, nil)
	api := chi.NewRouter()
	api.Post("/scans/", h.CreateScan)
	api.Post("/scans/{id}/pause", h.PauseScan)
	api.Post("/scans/{id}/resume", h.ResumeScan)
	api.Post("/scans/{id}/retry-failed", h.RetryFailedPages)
	api.Post("/scans/{id}/rescan", h.RescanScan)
	api.Delete("/scans/{id}", h.DeleteScan)
	api.Post("/scans/{id}/issues/{issueId}/false-positive", h.MarkIssueFalsePositive)
	api.Delete("/scans/{id}/issues/{issueId}/false-positive", h.UnmarkIssueFalsePositive)
	api.Post("/link-checks/", h.CreateLinkCheck)
	api.Post("/link-checks/{id}/cancel", h.CancelLinkCheck)
	api.Post("/link-checks/{id}/recheck", h.RecheckLinks)
	api.Delete("/link-checks/{id}", h.DeleteLinkCheck)
	server := httptest.NewServer(New(repo, api))
	defer server.Close()

	call := func(name, args string, status int) map[string]any {
		t.Helper()
		reply := mcpSQLPost(t, ctx, server, mcpSQLToolBody("9007199254740993", name, args))
		var payload map[string]any
		if err := json.Unmarshal(reply.Result.StructuredContent, &payload); err != nil {
			t.Fatalf("%s invalid action response: %s: %v", name, reply.body, err)
		}
		if reply.status != 200 || payload["http_status"] != float64(status) || reply.Result.IsError != (status >= 400) ||
			string(reply.ID) != "9007199254740993" || reply.header.Get(dashboardTransformHeader) != "none" {
			t.Fatalf("%s unexpected result: %s", name, reply.body)
		}
		return payload
	}
	scanArgs := `{"request_id":"` + testRequestID + `","sitemap_url":"https://fixture.test/new","scan_type":"single","include_link_check":true}`
	created := call("create_scan", scanArgs, 201)
	scanID := created["data"].(map[string]any)["id"].(string)
	if replay := call("create_scan", scanArgs, 201); replay["replayed"] != true || replay["data"].(map[string]any)["id"] != scanID {
		t.Fatal("real-handler replay did not return the original scan")
	}
	call("pause_scan", fmt.Sprintf(`{"scan_id":%q}`, scanID), 200)
	mcpSQLExec(t, pool, ctx, `UPDATE scans SET status='paused' WHERE id=$1`, scanID)
	call("resume_scan", fmt.Sprintf(`{"scan_id":%q}`, scanID), 200)
	mcpSQLExec(t, pool, ctx, `UPDATE scans SET status='completed' WHERE id=$1`, scanID)
	mcpSQLExec(t, pool, ctx, `INSERT INTO urls(scan_id,url,status) VALUES ($1,'https://fixture.test/done','completed'),($1,'https://fixture.test/fail','failed')`, scanID)
	call("retry_failed_pages", fmt.Sprintf(`{"scan_id":%q}`, scanID), 200)
	mcpSQLExec(t, pool, ctx, `UPDATE scans SET status='completed',root_public=TRUE WHERE id=$1`, scanID)
	rescanned := call("rescan_scan", fmt.Sprintf(`{"scan_id":%q,"request_id":"44444444-4444-4444-8444-444444444444"}`, scanID), 201)
	rescanID := rescanned["data"].(map[string]any)["id"].(string)
	var public, companion bool
	if err := pool.QueryRow(ctx, `SELECT root_public,include_link_check FROM scans WHERE id=$1`, rescanID).Scan(&public, &companion); err != nil || !public || !companion {
		t.Fatal("rescan lost durable policy or companion selection", err)
	}
	for _, value := range []bool{true, false} {
		call("mark_issue_false_positive", fmt.Sprintf(`{"scan_id":%q,"issue_id":%q,"false_positive":%t}`, testScanID, testIssueID, value), 200)
		var saved bool
		if err := pool.QueryRow(ctx, `SELECT is_false_positive FROM issues WHERE id=$1`, testIssueID).Scan(&saved); err != nil || saved != value {
			t.Fatal("issue triage did not persist", err)
		}
	}
	link := call("create_link_check", `{"request_id":"55555555-5555-4555-8555-555555555555","url":"https://fixture.test/new","check_type":"single"}`, 201)
	linkID := link["data"].(map[string]any)["id"].(string)
	call("cancel_link_check", fmt.Sprintf(`{"check_id":%q}`, linkID), 200)
	rechecked := call("recheck_link_check", fmt.Sprintf(`{"check_id":%q,"request_id":"88888888-8888-4888-8888-888888888888"}`, linkID), 201)
	if rechecked["data"].(map[string]any)["check_type"] != "single" {
		t.Fatal("standalone recheck changed type")
	}
	call("delete_link_check", fmt.Sprintf(`{"check_id":%q,"confirm":true}`, linkID), 204)
	// Companion rechecks copy all seed URLs in SQL and inherit the parent's policy.
	mcpSQLExec(t, pool, ctx, `UPDATE scans SET root_public=TRUE WHERE id=$1`, testScanID)
	mcpSQLExec(t, pool, ctx, `UPDATE link_checks SET seed_urls='["https://fixture.test/a",null,"https://fixture.test/b"]'::jsonb WHERE id=$1`, mcpSQLCheckID)
	copy := call("recheck_link_check", fmt.Sprintf(`{"check_id":%q,"request_id":"99999999-9999-4999-8999-999999999999"}`, mcpSQLCheckID), 201)
	copyID := copy["data"].(map[string]any)["id"].(string)
	var copied, copyPublic bool
	if err := pool.QueryRow(ctx, `SELECT seed_urls=(SELECT seed_urls FROM link_checks WHERE id=$2),root_public FROM link_checks WHERE id=$1`, copyID, mcpSQLCheckID).Scan(&copied, &copyPublic); err != nil || !copied || !copyPublic {
		t.Fatal("companion recheck lost inventory or parent policy", err)
	}
	// Terminal scan deletion also removes its companion through existing cleanup.
	call("delete_scan", fmt.Sprintf(`{"scan_id":%q,"confirm":true}`, scanID), 204)
	var remaining int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM scans WHERE id=$1`, scanID).Scan(&remaining); err != nil || remaining != 0 {
		t.Fatal("scan deletion did not persist", err)
	}
	// Corrupt or oversized historical responses must never create another scan.
	var before int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM scans`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	for _, saved := range []string{"null", `{"data":"` + strings.Repeat("x", 3<<20) + `"}`, `{"data":` + strings.Repeat(`{"x":`, 1600) + "1" + strings.Repeat("}", 1600) + `}`} {
		mcpSQLExec(t, pool, ctx, `UPDATE mcp_action_requests SET response=$2::jsonb WHERE request_id=$1`, testRequestID, saved)
		reply := mcpSQLPost(t, ctx, server, mcpSQLToolBody("1", "create_scan", scanArgs))
		if reply.status != 200 || !reply.Result.IsError || len(reply.body) > 2048 {
			t.Fatal("historical replay did not fail closed", string(reply.body))
		}
		var after int
		var unchanged bool
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM scans`).Scan(&after); err != nil || after != before {
			t.Fatal("historical replay reran the action", err)
		}
		if err := pool.QueryRow(ctx, `SELECT response=$2::jsonb FROM mcp_action_requests WHERE request_id=$1`, testRequestID, saved).Scan(&unchanged); err != nil || !unchanged {
			t.Fatal("historical replay changed the permanent response", err)
		}
	}
}
