package mcp

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/sumanbasuli/lime/shopkeeper/internal/repository"
)

const mcpSQLURLID = "33333333-3333-4333-8333-333333333333"
const mcpSQLCheckID = "66666666-6666-4666-8666-666666666666"
const mcpSQLResultID = "77777777-7777-4777-8777-777777777777"

func nativeMCPReadSQLFixture(t *testing.T) (*repository.Repository, *pgxpool.Pool, context.Context) {
	t.Helper()
	databaseURL := os.Getenv("LIME_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set LIME_TEST_DATABASE_URL to a disposable PostgreSQL database for SQL/HTTP regressions")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
	admin, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	var suffix [8]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	schema := "mcp_http_test_" + hex.EncodeToString(suffix[:])
	quotedSchema := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+quotedSchema); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := admin.Exec(cleanupCtx, "DROP SCHEMA "+quotedSchema+" CASCADE"); err != nil {
			t.Errorf("failed to remove isolated SQL/HTTP schema: %v", err)
		}
		admin.Close()
	})
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	config.ConnConfig.RuntimeParams["application_name"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	migrations, err := filepath.Glob("../../migrations/*.up.sql")
	if err != nil || len(migrations) == 0 {
		t.Fatalf("cannot locate real SQL migrations: %v", err)
	}
	for _, path := range migrations {
		migration, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		mcpSQLExec(t, pool, ctx, string(migration))
	}
	hash := sha256.Sum256([]byte(testToken))
	mcpSQLExec(t, pool, ctx, `UPDATE app_settings SET mcp_enabled=TRUE,mcp_key_hash=$1,mcp_key_hint='test-hint' WHERE key='global'`, hex.EncodeToString(hash[:]))
	mcpSQLExec(t, pool, ctx, `INSERT INTO scans(id,sitemap_url,status,include_link_check,total_urls,scanned_urls)
		VALUES($1,'https://fixture.test/scan','completed',TRUE,1,1)`, testScanID)
	mcpSQLExec(t, pool, ctx, `INSERT INTO urls(id,scan_id,url,status)
		VALUES($1,$2,'https://fixture.test/page','completed')`, mcpSQLURLID, testScanID)
	mcpSQLExec(t, pool, ctx, `INSERT INTO issues(id,scan_id,violation_type,description,severity)
		VALUES($1,$2,'image-alt','Missing alt','serious')`, testIssueID, testScanID)
	mcpSQLExec(t, pool, ctx, `INSERT INTO issue_occurrences(issue_id,url_id,html_snippet)
		VALUES($1,$2,'<img>')`, testIssueID, mcpSQLURLID)
	mcpSQLExec(t, pool, ctx, `INSERT INTO url_audit_occurrences(url_id,rule_id,outcome,html_snippet)
		VALUES($1,'review-rule','incomplete','<a>')`, mcpSQLURLID)
	mcpSQLExec(t, pool, ctx, `INSERT INTO link_checks(id,scan_id,url,check_type,status,pages_checked,links_checked,summary)
		VALUES($1,$2,'https://fixture.test/links','scan','completed',1,1,'{"broken":1}')`, mcpSQLCheckID, testScanID)
	mcpSQLExec(t, pool, ctx, `INSERT INTO link_check_results(id,link_check_id,target_url,status,link_type,occurrence_count,sources)
		VALUES($1,$2,'https://fixture.test/target','broken','external',1,
		'[{"page_url":"https://fixture.test/page","element":"a","attribute":"href","text":"Example"}]')`, mcpSQLResultID, mcpSQLCheckID)
	return repository.New(pool), pool, ctx
}

func mcpSQLExec(t *testing.T, pool *pgxpool.Pool, ctx context.Context, query string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(ctx, query, args...); err != nil {
		t.Fatal(err)
	}
}

type mcpSQLHTTPReply struct {
	status int
	header http.Header
	body   []byte
	ID     json.RawMessage `json:"id"`
	Error  json.RawMessage `json:"error"`
	Result struct {
		IsError           bool            `json:"isError"`
		StructuredContent json.RawMessage `json:"structuredContent"`
		Content           []struct {
			Text string `json:"text"`
		} `json:"content"`
	} `json:"result"`
}

func mcpSQLToolBody(id, name, args string) string {
	return fmt.Sprintf(`{"jsonrpc":"2.0","id":%s,"method":"tools/call","params":{"name":%q,"arguments":%s}}`, id, name, args)
}

func mcpSQLPost(t *testing.T, ctx context.Context, server *httptest.Server, body string) mcpSQLHTTPReply {
	t.Helper()
	return mcpSQLPostToken(t, ctx, server, testToken, body)
}

func mcpSQLPostToken(t *testing.T, ctx context.Context, server *httptest.Server, token, body string) mcpSQLHTTPReply {
	t.Helper()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, server.URL, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	encoded, err := io.ReadAll(io.LimitReader(response.Body, 2<<20))
	if err != nil || len(encoded) == 2<<20 {
		t.Fatalf("SQL/HTTP response read failed or exceeded test bound: bytes=%d err=%v", len(encoded), err)
	}
	var reply mcpSQLHTTPReply
	if err := json.Unmarshal(encoded, &reply); err != nil {
		t.Fatal(err)
	}
	reply.status, reply.header, reply.body = response.StatusCode, response.Header, encoded
	return reply
}

func requireMCPSQLToolSuccess(t *testing.T, reply mcpSQLHTTPReply) map[string]any {
	t.Helper()
	if reply.status != 200 || len(reply.Error) != 0 || reply.Result.IsError || len(reply.Result.Content) != 1 {
		t.Fatalf("SQL-backed MCP tool failed: HTTP=%d response=%s", reply.status, reply.body)
	}
	var structured, content map[string]any
	if err := json.Unmarshal(reply.Result.StructuredContent, &structured); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(reply.Result.Content[0].Text), &content); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(structured, content) {
		t.Fatal("SQL-backed MCP structured and text content disagree")
	}
	return structured
}

func requireMCPSQLBudgetError(t *testing.T, reply mcpSQLHTTPReply) {
	t.Helper()
	var data map[string]any
	if err := json.Unmarshal(reply.Result.StructuredContent, &data); err != nil {
		t.Fatal(err)
	}
	if reply.status != 200 || len(reply.Error) != 0 || !reply.Result.IsError || data["http_status"] != float64(413) || len(reply.body) > 4096 {
		t.Fatalf("SQL read budget changed the MCP tool-error contract: HTTP=%d response=%s", reply.status, reply.body)
	}
	for _, private := range []string{"SELECT ", "SQLSTATE", "FROM scans", "repeat(", "pgx"} {
		if strings.Contains(string(reply.body), private) {
			t.Fatalf("SQL read budget error leaked SQL detail %q", private)
		}
	}
}

func TestNativeMCPReadsRealSQLHTTP(t *testing.T) {
	repo, pool, ctx := nativeMCPReadSQLFixture(t)
	server := httptest.NewServer(New(repo))
	defer server.Close()
	for _, tool := range []struct{ name, args, want string }{
		{"list_scans", `{}`, testScanID},
		{"get_scan", `{"scan_id":"` + testScanID + `"}`, testScanID},
		{"list_scan_issues", `{"scan_id":"` + testScanID + `"}`, testIssueID},
		{"get_issue_detail", `{"scan_id":"` + testScanID + `","kind":"failed","key":"` + testIssueID + `"}`, "Missing alt"},
		{"get_issue_detail", `{"scan_id":"` + testScanID + `","kind":"needs_review","key":"review-rule"}`, "review-rule"},
		{"get_report_metadata", `{"scan_id":"` + testScanID + `"}`, "/issues/report.pdf"},
		{"get_settings", `{}`, "test-hint"},
		{"list_link_checks", `{}`, mcpSQLCheckID},
		{"get_link_check", `{"check_id":"` + mcpSQLCheckID + `"}`, mcpSQLCheckID},
		{"get_link_check_stats", `{}`, `"broken_links":1`},
		{"get_scan_link_check", `{"scan_id":"` + testScanID + `"}`, mcpSQLCheckID},
		{"list_link_check_results", `{"check_id":"` + mcpSQLCheckID + `"}`, mcpSQLResultID},
		{"list_link_check_sources", `{"check_id":"` + mcpSQLCheckID + `","result_id":"` + mcpSQLResultID + `"}`, "Example"},
	} {
		t.Run(tool.name+"/"+tool.want, func(t *testing.T) {
			reply := mcpSQLPost(t, ctx, server, mcpSQLToolBody("9007199254740993", tool.name, tool.args))
			requireMCPSQLToolSuccess(t, reply)
			transform := "none"
			if tool.name == "get_scan" {
				transform = "dashboard"
			}
			if string(reply.ID) != "9007199254740993" || reply.header.Get(dashboardTransformHeader) != transform || !strings.Contains(string(reply.Result.StructuredContent), tool.want) {
				t.Fatalf("normal SQL tool wire contract changed: ID=%s transform=%q response=%s", reply.ID, reply.header.Get(dashboardTransformHeader), reply.body)
			}
		})
	}
	largeID, err := json.Marshal(strings.Repeat("large-id-", 32<<10))
	if err != nil {
		t.Fatal(err)
	}
	// Case aliases use the same decoder for dispatch and transform classification.
	body := `{"jsonrpc":"2.0","id":` + string(largeID) + `,"method":"tools/call","params":{"Name":"get_scan","arguments":{"scan_id":"` + testScanID + `"}}}`
	largeReply := mcpSQLPost(t, ctx, server, body)
	requireMCPSQLToolSuccess(t, largeReply)
	if string(largeReply.ID) != string(largeID) || largeReply.header.Get(dashboardTransformHeader) != "dashboard" {
		t.Fatal("large raw request ID or aliased-tool transform classification changed")
	}
	mcpSQLExec(t, pool, ctx, `UPDATE link_checks SET seed_urls=jsonb_build_object('malformed',repeat('x',6*1024*1024)) WHERE id=$1`, mcpSQLCheckID)
	for _, tool := range []struct{ name, args string }{
		{"get_link_check", `{"check_id":"` + mcpSQLCheckID + `"}`},
		{"list_link_check_results", `{"check_id":"` + mcpSQLCheckID + `"}`},
	} {
		reply := mcpSQLPost(t, ctx, server, mcpSQLToolBody("2", tool.name, tool.args))
		requireMCPSQLToolSuccess(t, reply)
		if len(reply.body) > 8192 || strings.Contains(string(reply.body), "seed_urls") || strings.Contains(string(reply.body), "malformed") {
			t.Fatal("hidden malformed seed escaped the native SQL projection")
		}
	}
	mcpSQLExec(t, pool, ctx, `UPDATE scans SET sitemap_url=repeat('x',6*1024*1024),tag=repeat('t',64*1024) WHERE id=$1`, testScanID)
	requireMCPSQLBudgetError(t, mcpSQLPost(t, ctx, server, mcpSQLToolBody("3", "get_scan", `{"scan_id":"`+testScanID+`"}`)))
	mcpSQLExec(t, pool, ctx, `UPDATE app_settings SET mcp_key_hint=repeat('x',6*1024*1024) WHERE key='global'`)
	requireMCPSQLBudgetError(t, mcpSQLPost(t, ctx, server, mcpSQLToolBody("4", "get_settings", `{}`)))
	for _, name := range []string{"get_report_metadata", "get_scan_link_check"} {
		reply := mcpSQLPost(t, ctx, server, mcpSQLToolBody("5", name, `{"scan_id":"`+testScanID+`"}`))
		requireMCPSQLToolSuccess(t, reply)
		if len(reply.body) > 8192 {
			t.Fatal("metadata prerequisites materialized unused oversized text")
		}
	}
	if len(nativeReadSlots) != 0 {
		t.Fatal("normal SQL/HTTP requests leaked native read capacity")
	}
}

func TestNativeMCPCanceledSQLReadRetainsCapacityHTTP(t *testing.T) {
	if os.Getenv("LIME_TEST_MCP_DELIVERY") != "1" {
		t.Skip("set LIME_TEST_MCP_DELIVERY=1 for the 30-second SQL cancellation lease regression")
	}
	repo, pool, ctx := nativeMCPReadSQLFixture(t)
	if len(nativeReadSlots) != 0 {
		t.Fatal("native capacity must be empty before the isolated SQL cancellation test")
	}
	server := httptest.NewServer(New(repo))
	locker, err := pool.Begin(ctx)
	if err != nil {
		server.Close()
		t.Fatal(err)
	}
	if _, err := locker.Exec(ctx, `LOCK TABLE scans IN ACCESS EXCLUSIVE MODE`); err != nil {
		locker.Rollback(ctx)
		server.Close()
		t.Fatal(err)
	}
	cancelFirst, cancelSecond := func() {}, func() {}
	t.Cleanup(func() {
		cancelFirst()
		cancelSecond()
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = locker.Rollback(cleanupCtx)
		server.CloseClientConnections()
		server.Close()
		deadline := time.Now().Add(35 * time.Second)
		for len(nativeReadSlots) != 0 && time.Now().Before(deadline) {
			time.Sleep(20 * time.Millisecond)
		}
		if len(nativeReadSlots) != 0 {
			t.Error("SQL cancellation test left native read slots occupied")
		}
	})
	type outcome struct {
		status int
		body   []byte
		err    error
	}
	start := func(id string) (context.CancelFunc, <-chan outcome) {
		requestCtx, cancel := context.WithCancel(ctx)
		request, err := http.NewRequestWithContext(requestCtx, http.MethodPost, server.URL,
			strings.NewReader(mcpSQLToolBody(id, "get_scan", `{"scan_id":"`+testScanID+`"}`)))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Authorization", "Bearer "+testToken)
		finished := make(chan outcome, 1)
		go func() {
			response, err := server.Client().Do(request)
			result := outcome{err: err}
			if err == nil {
				result.status = response.StatusCode
				result.body, result.err = io.ReadAll(response.Body)
				response.Body.Close()
			}
			finished <- result
		}()
		return cancel, finished
	}
	blockedCount := func() int {
		var count int
		if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM pg_stat_activity WHERE application_name=$1
			AND state='active' AND wait_event_type='Lock' AND strpos(query,'FROM scans WHERE id=')>0`,
			pool.Config().ConnConfig.RuntimeParams["application_name"]).Scan(&count); err != nil {
			t.Fatal(err)
		}
		return count
	}
	waitBlocked := func(want int) {
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			if blockedCount() == want {
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatalf("did not observe %d actual blocked PostgreSQL reads", want)
	}
	firstStarted := time.Now()
	var first, second <-chan outcome
	cancelFirst, first = start("1")
	waitBlocked(1)
	cancelFirst()
	select {
	case result := <-first:
		if !errors.Is(result.err, context.Canceled) {
			t.Fatalf("aborted HTTP client did not observe cancellation: %v", result.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("aborted HTTP client did not stop")
	}
	// Cancellation starts the retained relative timeout. Begin the second read
	// later so it still runs when that first canceled lease finally expires.
	time.Sleep(4 * time.Second)
	cancelSecond, second = start("2")
	waitBlocked(1)
	largeID, _ := json.Marshal(strings.Repeat("capacity-id-", 16<<10))
	requireBusy := func() {
		reply := mcpSQLPost(t, ctx, server, mcpSQLToolBody(string(largeID), "get_settings", `{}`))
		var plain map[string]any
		if err := json.Unmarshal(reply.body, &plain); err != nil {
			t.Fatal(err)
		}
		if reply.status != 503 || reply.header.Get("Retry-After") != "1" || len(reply.body) > 1024 || plain["error"] == nil || plain["id"] != nil || plain["result"] != nil || plain["jsonrpc"] != nil {
			t.Fatalf("native capacity must be small plain HTTP 503 without echoing its ID: HTTP=%d response=%s", reply.status, reply.body)
		}
	}
	requireBusy()
	for time.Since(firstStarted) < 29*time.Second {
		time.Sleep(20 * time.Millisecond)
	}
	requireBusy()
	deadline := firstStarted.Add(32 * time.Second)
	for len(nativeReadSlots) == 2 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if len(nativeReadSlots) != 1 || time.Since(firstStarted) < 30*time.Second || blockedCount() != 1 {
		t.Fatalf("canceled read lease did not survive to its SQL deadline or recover alone: slots=%d elapsed=%v", len(nativeReadSlots), time.Since(firstStarted))
	}
	requireMCPSQLToolSuccess(t, mcpSQLPost(t, ctx, server, mcpSQLToolBody("3", "get_settings", `{}`)))
	if err := locker.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case result := <-second:
		if result.err != nil {
			t.Fatalf("remaining SQL read did not complete after unlocking: HTTP=%d err=%v", result.status, result.err)
		}
		var reply mcpSQLHTTPReply
		if err := json.Unmarshal(result.body, &reply); err != nil {
			t.Fatal(err)
		}
		reply.status, reply.body = result.status, result.body
		requireMCPSQLToolSuccess(t, reply)
	case <-time.After(5 * time.Second):
		t.Fatal("remaining SQL read did not finish after unlocking")
	}
	var cacheRows int
	if err := pool.QueryRow(ctx, `SELECT (SELECT COUNT(*) FROM scan_score_summary_cache) +
		(SELECT COUNT(*) FROM scan_issue_summary_cache) + (SELECT COUNT(*) FROM scan_report_data_cache)`).Scan(&cacheRows); err != nil || cacheRows != 0 {
		t.Fatalf("native reads mutated persisted SQL caches: rows=%d err=%v", cacheRows, err)
	}
}

func TestNativeMCPAuthSQLLockAdmissionAndFreshKeyHTTP(t *testing.T) {
	if os.Getenv("LIME_TEST_MCP_DELIVERY") != "1" {
		t.Skip("set LIME_TEST_MCP_DELIVERY=1 for the 30-second SQL authentication lease regression")
	}
	repo, pool, ctx := nativeMCPReadSQLFixture(t)
	server := httptest.NewServer(New(repo))
	locker, err := pool.Begin(ctx)
	if err != nil {
		server.Close()
		t.Fatal(err)
	}
	if _, err := locker.Exec(ctx, `LOCK TABLE app_settings IN ACCESS EXCLUSIVE MODE`); err != nil {
		locker.Rollback(ctx)
		server.Close()
		t.Fatal(err)
	}
	cancels := []context.CancelFunc{}
	authBusyObserved := false
	t.Cleanup(func() {
		for _, cancel := range cancels {
			cancel()
		}
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = locker.Rollback(cleanupCtx)
		server.CloseClientConnections()
		server.Close()
		if t.Failed() && authBusyObserved {
			// Any auth read canceled by failure cleanup retains its SQL lease.
			time.Sleep(35 * time.Second)
		}
		if len(nativeReadSlots) != 0 {
			t.Error("authentication-only SQL waits occupied native evidence capacity")
		}
	})
	type outcome struct {
		status int
		body   []byte
		err    error
	}
	start := func(body io.Reader) (context.CancelFunc, <-chan outcome) {
		requestCtx, cancel := context.WithCancel(ctx)
		cancels = append(cancels, cancel)
		request, err := http.NewRequestWithContext(requestCtx, http.MethodPost, server.URL, body)
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Authorization", "Bearer "+testToken)
		finished := make(chan outcome, 1)
		go func() {
			response, err := server.Client().Do(request)
			result := outcome{err: err}
			if err == nil {
				result.status = response.StatusCode
				result.body, result.err = io.ReadAll(response.Body)
				response.Body.Close()
			}
			finished <- result
		}()
		return cancel, finished
	}
	waitBlocked := func(want int) {
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			var count int
			if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM pg_stat_activity WHERE application_name=$1
				AND state='active' AND wait_event_type='Lock' AND strpos(query,'FROM app_settings')>0`,
				pool.Config().ConnConfig.RuntimeParams["application_name"]).Scan(&count); err != nil {
				t.Fatal(err)
			}
			if count == want {
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatalf("did not observe %d actual blocked authentication SQL reads", want)
	}
	firstStarted := time.Now()
	// No unread body lets net/http observe disconnects during initial auth SQL.
	cancelFirst, first := start(http.NoBody)
	waitBlocked(1)
	if len(nativeReadSlots) != 0 {
		t.Fatal("authentication wait consumed native evidence capacity")
	}
	cancelFirst()
	select {
	case result := <-first:
		if !errors.Is(result.err, context.Canceled) {
			t.Fatalf("aborted authentication client did not observe cancellation: %v", result.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("aborted authentication client did not stop")
	}
	firstCanceled := time.Now()
	time.Sleep(4 * time.Second)
	_, second := start(strings.NewReader(mcpSQLToolBody("2", "get_settings", `{}`)))
	waitBlocked(1)
	largeID, _ := json.Marshal(strings.Repeat("auth-capacity-id-", 16<<10))
	requireBusy := func() {
		probeCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
		defer cancel()
		started := time.Now()
		reply := mcpSQLPost(t, probeCtx, server, mcpSQLToolBody(string(largeID), "get_settings", `{}`))
		authBusyObserved = authBusyObserved || reply.status == 503
		var plain map[string]any
		if err := json.Unmarshal(reply.body, &plain); err != nil {
			t.Fatal(err)
		}
		if reply.status != 503 || reply.header.Get("Retry-After") != "1" || len(reply.body) > 1024 || plain["error"] == nil || plain["id"] != nil || plain["result"] != nil || plain["jsonrpc"] != nil || time.Since(started) >= time.Second {
			t.Fatalf("authentication capacity must promptly return plain HTTP 503 without its ID: HTTP=%d response=%s", reply.status, reply.body)
		}
		if len(nativeReadSlots) != 0 {
			t.Fatal("authentication capacity exhausted native evidence slots")
		}
	}
	requireBusy()
	for time.Since(firstStarted) < 29*time.Second {
		time.Sleep(20 * time.Millisecond)
	}
	requireBusy()
	for time.Since(firstCanceled) < 31*time.Second {
		time.Sleep(20 * time.Millisecond)
	}
	// The first retained auth lease has expired. A replacement reaches SQL
	// while the second reader remains blocked, rather than returning busy.
	_, replacement := start(strings.NewReader(mcpSQLToolBody("3", "get_settings", `{}`)))
	waitBlocked(2)
	rotatedToken := "lime-rotated-sql-http-key"
	rotatedHash := sha256.Sum256([]byte(rotatedToken))
	if _, err := locker.Exec(ctx, `UPDATE app_settings SET mcp_key_hash=$1 WHERE key='global'`, hex.EncodeToString(rotatedHash[:])); err != nil {
		t.Fatal(err)
	}
	if err := locker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	for _, finished := range []<-chan outcome{second, replacement} {
		select {
		case result := <-finished:
			if result.err != nil || result.status != 401 || !strings.Contains(string(result.body), "unauthorized") {
				t.Fatalf("blocked auth read accepted a stale key after rotation: HTTP=%d err=%v response=%s", result.status, result.err, result.body)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("authentication SQL wait did not finish after unlocking")
		}
	}
	if reply := mcpSQLPost(t, ctx, server, mcpSQLToolBody("4", "get_settings", `{}`)); reply.status != 401 {
		t.Fatalf("old key was accepted by fresh authentication: HTTP=%d", reply.status)
	}
	requireMCPSQLToolSuccess(t, mcpSQLPostToken(t, ctx, server, rotatedToken, mcpSQLToolBody("5", "get_settings", `{}`)))
}
