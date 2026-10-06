package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
)

const testRequestID = "33333333-3333-4333-8333-333333333333"

type actionRepository struct {
	*stubRepository
	mu                           sync.Mutex
	entries                      map[string]*models.MCPActionRequest
	beginErr, completeErr        error
	completedWithoutCancellation bool
}

func newActionRepository() *actionRepository {
	r := &actionRepository{stubRepository: newStubRepository(), entries: map[string]*models.MCPActionRequest{}}
	r.auth.AllowWrites = true
	return r
}

func (r *actionRepository) BeginMCPAction(_ context.Context, id, name, hash string) (*models.MCPActionRequest, bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.beginErr != nil {
		return nil, false, r.beginErr
	}
	if entry, ok := r.entries[id]; ok {
		cloned := *entry
		cloned.Response = append([]byte(nil), entry.Response...)
		return &cloned, false, nil
	}
	entry := &models.MCPActionRequest{Tool: name, ArgumentsHash: hash}
	r.entries[id] = entry
	return entry, true, nil
}

func (r *actionRepository) CompleteMCPAction(ctx context.Context, id string, response []byte) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.completedWithoutCancellation = ctx.Err() == nil
	if r.completeErr != nil {
		return r.completeErr
	}
	r.entries[id].Response = append([]byte(nil), response...)
	return nil
}

func callAction(t *testing.T, server *Server, name string, args string) map[string]any {
	t.Helper()
	result, rpcErr := server.handleToolCall(context.Background(), json.RawMessage(`{"name":"`+name+`","arguments":`+args+`}`))
	if rpcErr != nil {
		t.Fatalf("%s: unexpected protocol error %v", name, rpcErr)
	}
	return result.(map[string]any)
}

func resultText(result map[string]any) string {
	return result["content"].([]map[string]string)[0]["text"]
}

func TestActionCatalogAndLivePermissionGate(t *testing.T) {
	r := newActionRepository()
	r.auth.AllowWrites = false // An existing configured key must stay read-only.
	var calls atomic.Int32
	s := New(r, http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) { calls.Add(1); writeJSON(w, 200, map[string]any{}) }))
	listed, rpcErr := s.dispatch(context.Background(), rpcRequest{Method: "tools/list"})
	if rpcErr != nil || len(listed.(map[string]any)["tools"].([]map[string]any)) != 17 {
		t.Fatal("read-only catalog must have 17 tools", listed, rpcErr)
	}
	denied := callAction(t, s, "pause_scan", `{"scan_id":"`+testScanID+`"}`)
	if denied["isError"] != true || calls.Load() != 0 {
		t.Fatal("write action executed while disabled", denied)
	}
	r.auth.AllowWrites = true
	listed, _ = s.dispatch(context.Background(), rpcRequest{Method: "tools/list"})
	definitions := listed.(map[string]any)["tools"].([]map[string]any)
	if len(definitions) != 29 {
		t.Fatalf("full catalog has %d tools, want 29", len(definitions))
	}
	for _, definition := range definitions[17:] {
		annotations := definition["annotations"].(map[string]any)
		if annotations["readOnlyHint"] != false {
			t.Fatal("mutation labeled read-only", definition)
		}
		if strings.HasPrefix(definition["name"].(string), "delete_") && annotations["destructiveHint"] != true {
			t.Fatal("delete missing destructive annotation")
		}
	}
	r.auth.AllowWrites = false // Revoke after the client already cached 29 tools.
	denied = callAction(t, s, "pause_scan", `{"scan_id":"`+testScanID+`"}`)
	if denied["isError"] != true || calls.Load() != 0 {
		t.Fatal("cached tool bypassed live permission", denied)
	}
	capabilities := callAction(t, s, "get_capabilities", `{}`)["structuredContent"].(map[string]any)
	if capabilities["mode"] != "read_only" || len(capabilities["write_tools"].([]string)) != 0 {
		t.Fatal("capabilities grant stale permission", capabilities)
	}
}

func TestActionsInvokeSameAPIRouterWithFreshChiContext(t *testing.T) {
	tests := []struct{ name, args, method, path string }{
		{"create_scan", `{"request_id":"` + testRequestID + `","sitemap_url":"https://example.test/sitemap.xml"}`, "POST", "/scans/"},
		{"pause_scan", `{"scan_id":"` + testScanID + `"}`, "POST", "/scans/" + testScanID + "/pause"},
		{"resume_scan", `{"scan_id":"` + testScanID + `"}`, "POST", "/scans/" + testScanID + "/resume"},
		{"retry_failed_pages", `{"scan_id":"` + testScanID + `"}`, "POST", "/scans/" + testScanID + "/retry-failed"},
		{"rescan_scan", `{"scan_id":"` + testScanID + `","request_id":"` + testRequestID + `"}`, "POST", "/scans/" + testScanID + "/rescan"},
		{"delete_scan", `{"scan_id":"` + testScanID + `","confirm":true}`, "DELETE", "/scans/" + testScanID},
		{"mark_issue_false_positive", `{"scan_id":"` + testScanID + `","issue_id":"` + testIssueID + `","false_positive":true}`, "POST", "/scans/" + testScanID + "/issues/" + testIssueID + "/false-positive"},
		{"mark_issue_false_positive", `{"scan_id":"` + testScanID + `","issue_id":"` + testIssueID + `","false_positive":false}`, "DELETE", "/scans/" + testScanID + "/issues/" + testIssueID + "/false-positive"},
		{"create_link_check", `{"request_id":"` + testRequestID + `","url":"https://example.test/","check_type":"single","max_pages":500}`, "POST", "/link-checks/"},
		{"cancel_link_check", `{"check_id":"` + testCheckID + `"}`, "POST", "/link-checks/" + testCheckID + "/cancel"},
		{"recheck_link_check", `{"check_id":"` + testCheckID + `","request_id":"` + testRequestID + `"}`, "POST", "/link-checks/" + testCheckID + "/recheck"},
		{"delete_link_check", `{"check_id":"` + testCheckID + `","confirm":true}`, "DELETE", "/link-checks/" + testCheckID},
	}
	for _, tt := range tests {
		t.Run(tt.name+tt.method, func(t *testing.T) {
			r := newActionRepository()
			api := chi.NewRouter()
			var called bool
			api.MethodFunc(tt.method, tt.path, func(w http.ResponseWriter, req *http.Request) {
				called = true
				if req.Method != tt.method || req.URL.Path != tt.path {
					t.Error("wrong action route")
				}
				if tt.name == "create_scan" || tt.name == "create_link_check" {
					var body map[string]any
					if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
						t.Error(err)
					}
					if _, exists := body["request_id"]; exists {
						t.Error("MCP metadata leaked into REST model")
					}
					if tt.name == "create_scan" && (body["scan_type"] != "sitemap" || body["viewport_preset"] != "desktop" || body["include_link_check"] != false) {
						t.Error("scan defaults differ", body)
					}
					if tt.name == "create_link_check" && body["max_pages"] != float64(1) {
						t.Error("single-page link default differs", body)
					}
				}
				writeJSON(w, 201, map[string]any{"id": testScanID})
			})
			outer := chi.NewRouter()
			outer.Handle("/mcp", New(r, api))
			req := httptest.NewRequest("POST", "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"`+tt.name+`","arguments":`+tt.args+`}}`))
			req.Header.Set("Authorization", "Bearer "+testToken)
			w := httptest.NewRecorder()
			outer.ServeHTTP(w, req)
			result := responseObject(t, w)["result"].(map[string]any)
			if !called || result["isError"] == true {
				t.Fatal("action did not reach in-process API", w.Body.String())
			}
			data := result["structuredContent"].(map[string]any)
			if data["action"] != tt.name || data["http_status"] != float64(201) || data["data"].(map[string]any)["id"] != testScanID {
				t.Fatal("actual API response was lost", data)
			}
		})
	}
}

func TestActionValidationRejectsMalformedInputsBeforeExecuting(t *testing.T) {
	tests := []struct{ name, args string }{
		{"create_scan", `{"sitemap_url":"https://example.test"}`},
		{"create_scan", `{"request_id":"` + testRequestID + `","sitemap_url":"https://user:secret@example.test"}`},
		{"create_scan", `{"request_id":"` + testRequestID + `","sitemap_url":"https:///missing"}`},
		{"create_scan", `{"request_id":"` + testRequestID + `","sitemap_url":"file:///etc/passwd"}`},
		{"create_scan", `{"request_id":"` + testRequestID + `","sitemap_url":"https://example.test","include_link_check":"true"}`},
		{"create_scan", `{"request_id":"` + testRequestID + `","sitemap_url":"https://example.test","include_link_check":null}`},
		{"create_scan", `{"request_id":"` + testRequestID + `","sitemap_url":"https://example.test","tag":null}`},
		{"create_scan", `{"request_id":"` + testRequestID + `","sitemap_url":"https://example.test","viewport_preset":"watch"}`},
		{"pause_scan", `{"scan_id":"` + testScanID + `","unknown":true}`},
		{"delete_scan", `{"scan_id":"` + testScanID + `"}`},
		{"delete_scan", `{"scan_id":"` + testScanID + `","confirm":false}`},
		{"delete_scan", `{"scan_id":"` + testScanID + `","confirm":"true"}`},
		{"mark_issue_false_positive", `{"scan_id":"` + testScanID + `","issue_id":"rule-key","false_positive":true}`},
		{"mark_issue_false_positive", `{"scan_id":"` + testScanID + `","issue_id":"` + testIssueID + `","false_positive":1}`},
		{"create_link_check", `{"request_id":"` + testRequestID + `","url":"https://example.test","max_pages":500.00000000000000001}`},
		{"create_link_check", `{"request_id":"` + testRequestID + `","url":"https://example.test","max_pages":1e-1000000000}`},
		{"create_link_check", `{"request_id":"` + testRequestID + `","url":"https://example.test","max_pages":501}`},
		{"get_screenshot", `{"scan_id":"` + testScanID + `","filename":"../private.png"}`},
		{"get_screenshot", `{"scan_id":"` + testScanID + `","filename":"foo..png"}`},
		{"get_screenshot", `{"scan_id":"` + testScanID + `","filename":"%2e%2e%2fsecret.png"}`},
		{"get_report", `{"scan_id":"` + testScanID + `","format":"html"}`},
		{"get_report", `{"scan_id":"` + testScanID + `","format":"csv","kind":"needs_review"}`},
		{"get_report", `{"scan_id":"` + testScanID + `","format":"pdf","key":"label"}`},
		{"get_report", `{"scan_id":"` + testScanID + `","format":"pdf","kind":"failed","key":"label"}`},
		{"get_report", `{"scan_id":"` + testScanID + `","format":"llm","issue_id":"` + testIssueID + `","kind":"failed","key":"label"}`},
		{"update_settings", `{"confirm":true}`},
		{"update_settings", `{"confirm":true,"mcp_allow_writes":true}`},
		{"update_settings", `{"confirm":true,"summary_cache_ttl_seconds":4}`},
		{"update_settings", `{"confirm":true,"pdf_reports_enabled":null}`},
	}
	for _, tt := range tests {
		t.Run(tt.name+tt.args, func(t *testing.T) {
			r := newActionRepository()
			calls := 0
			s := New(r, http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) { calls++; writeJSON(w, 200, map[string]any{}) }))
			result := callAction(t, s, tt.name, tt.args)
			if result["isError"] != true || calls != 0 || len(r.entries) != 0 {
				t.Fatal("malformed action reached handler/reservation", result)
			}
		})
	}
	r := newActionRepository()
	for _, raw := range []string{`{"name":"delete_scan","arguments":{"scan_id":"` + testScanID + `","confirm":false,"confirm":true}}`, `{"name":"create_scan","arguments":null}`} {
		_, rpcErr := New(r).handleToolCall(context.Background(), json.RawMessage(raw))
		if rpcErr == nil || rpcErr.Code != -32602 {
			t.Fatal("duplicate/null arguments accepted", raw)
		}
	}
}

func TestDurableActionReplayCanonicalDefaultsAndCollisions(t *testing.T) {
	r := newActionRepository()
	var calls int
	s := New(r, http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		calls++
		writeJSON(w, 201, map[string]any{"id": testScanID})
	}))
	firstArgs := `{"request_id":"` + testRequestID + `","sitemap_url":"https://example.test"}`
	first := callAction(t, s, "create_scan", firstArgs)
	replay := callAction(t, s, "create_scan", `{"request_id":"`+testRequestID+`","sitemap_url":"https://example.test","scan_type":"sitemap","viewport_preset":"desktop","include_link_check":false}`)
	if first["isError"] == true || replay["isError"] == true || calls != 1 || replay["structuredContent"].(map[string]any)["replayed"] != true {
		t.Fatal("canonical retry duplicated action", first, replay, calls)
	}
	// A new Server instance reads the same durable record after restart.
	replay = callAction(t, New(r, s.actions), "create_scan", firstArgs)
	if replay["isError"] == true || calls != 1 {
		t.Fatal("restart replay created another scan")
	}
	for _, tc := range []struct{ name, args string }{{"create_scan", `{"request_id":"` + testRequestID + `","sitemap_url":"https://different.test"}`}, {"create_link_check", `{"request_id":"` + testRequestID + `","url":"https://example.test"}`}} {
		result := callAction(t, s, tc.name, tc.args)
		if result["isError"] != true || calls != 1 {
			t.Fatal("request collision launched job", result)
		}
	}
	r.auth.AllowWrites = false
	if result := callAction(t, s, "create_scan", firstArgs); result["isError"] != true || calls != 1 {
		t.Fatal("replay bypassed revoked write access", result)
	}
}

func TestConcurrentReplayDoesNotLaunchDuplicateJob(t *testing.T) {
	r := newActionRepository()
	var calls atomic.Int32
	started, release := make(chan struct{}), make(chan struct{})
	s := New(r, http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		calls.Add(1)
		close(started)
		<-release
		writeJSON(w, 201, map[string]any{"id": testScanID})
	}))
	args := `{"request_id":"` + testRequestID + `","sitemap_url":"https://example.test"}`
	finished := make(chan map[string]any, 1)
	go func() {
		result, _ := s.handleToolCall(context.Background(), json.RawMessage(`{"name":"create_scan","arguments":`+args+`}`))
		finished <- result.(map[string]any)
	}()
	<-started
	inFlight := callAction(t, s, "create_scan", args)
	if inFlight["isError"] != true || !strings.Contains(resultText(inFlight), "in progress") || calls.Load() != 1 {
		t.Fatal("concurrent retry duplicated execution", inFlight)
	}
	close(release)
	if (<-finished)["isError"] == true {
		t.Fatal("original job failed")
	}
	if replay := callAction(t, s, "create_scan", args); replay["isError"] == true || calls.Load() != 1 {
		t.Fatal("completed retry didn't replay", replay)
	}
}

func TestInterruptedActionsRemainReservedAndBusinessErrorsReplay(t *testing.T) {
	t.Run("panic", func(t *testing.T) {
		r := newActionRepository()
		calls := 0
		s := New(r, http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) { calls++; panic("handler interrupted") }))
		args := `{"request_id":"` + testRequestID + `","scan_id":"` + testScanID + `"}`
		if result := callAction(t, s, "rescan_scan", args); result["isError"] != true {
			t.Fatal("panic reported success", result)
		}
		if result := callAction(t, s, "rescan_scan", args); result["isError"] != true || calls != 1 {
			t.Fatal("uncertain action was rerun", result)
		}
	})
	t.Run("business error", func(t *testing.T) {
		r := newActionRepository()
		calls := 0
		s := New(r, http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			calls++
			writeJSON(w, 409, map[string]any{"error": "Only terminal scans can be rescanned"})
		}))
		args := `{"request_id":"` + testRequestID + `","scan_id":"` + testScanID + `"}`
		for i := 0; i < 2; i++ {
			result := callAction(t, s, "rescan_scan", args)
			if result["isError"] != true || !strings.Contains(resultText(result), "Only terminal") {
				t.Fatal("business error lost", result)
			}
		}
		if calls != 1 {
			t.Fatal("business error wasn't durably replayed")
		}
	})
	t.Run("reserve fails", func(t *testing.T) {
		r := newActionRepository()
		r.beginErr = errors.New("database unavailable")
		calls := 0
		s := New(r, http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) { calls++ }))
		result := callAction(t, s, "create_link_check", `{"request_id":"`+testRequestID+`","url":"https://example.test"}`)
		if result["isError"] != true || calls != 0 {
			t.Fatal("executed without durable reservation", result)
		}
	})
	t.Run("completion fails", func(t *testing.T) {
		r := newActionRepository()
		r.completeErr = errors.New("database unavailable")
		calls := 0
		s := New(r, http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			calls++
			writeJSON(w, 201, map[string]any{"id": testScanID})
		}))
		args := `{"request_id":"` + testRequestID + `","url":"https://example.test"}`
		result := callAction(t, s, "create_link_check", args)
		if result["isError"] == true || result["structuredContent"].(map[string]any)["idempotency_warning"] == nil {
			t.Fatal("observed result/warning lost", result)
		}
		if retry := callAction(t, s, "create_link_check", args); retry["isError"] != true || calls != 1 {
			t.Fatal("completion failure reran job", retry)
		}
	})
}

func TestActionCompletesReservationAfterClientDisconnect(t *testing.T) {
	r := newActionRepository()
	ctx, cancel := context.WithCancel(context.Background())
	s := New(r, http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		cancel()
		writeJSON(w, 201, map[string]any{"id": testScanID})
	}))
	result, rpcErr := s.handleToolCall(ctx, json.RawMessage(`{"name":"create_scan","arguments":{"request_id":"`+testRequestID+`","sitemap_url":"https://example.test"}}`))
	if rpcErr != nil || result.(map[string]any)["isError"] == true || !r.completedWithoutCancellation || len(r.entries[testRequestID].Response) == 0 {
		t.Fatal("disconnect lost durable completed response", result, rpcErr)
	}
}

func TestDashboardMarkersAndWorkspaceStats(t *testing.T) {
	r := newActionRepository()
	api := chi.NewRouter()
	api.Get("/stats", func(w http.ResponseWriter, req *http.Request) { writeJSON(w, 200, map[string]any{"total_scans": 3}) })
	api.Get("/version", func(w http.ResponseWriter, req *http.Request) { writeJSON(w, 200, map[string]any{"version": "2.0.0"}) })
	s := New(r, api)
	stats := callAction(t, s, "get_workspace_stats", `{}`)
	if stats["isError"] == true || !strings.Contains(resultText(stats), "total_scans") {
		t.Fatal("workspace stats not read from actual API", stats)
	}
	for _, tc := range []struct{ name, args string }{
		{"get_report", `{"scan_id":"` + testScanID + `","format":"pdf"}`},
		{"get_report", `{"scan_id":"` + testScanID + `","format":"csv","kind":"failed","key":"` + testIssueID + `"}`},
		{"get_report", `{"scan_id":"` + testScanID + `","format":"llm","kind":"needs_review","key":"color-contrast"}`},
		{"get_screenshot", `{"scan_id":"` + testScanID + `","filename":"saved-page.png"}`},
		{"get_link_check_export", `{"check_id":"` + testCheckID + `"}`},
		{"update_settings", `{"confirm":true,"small_csv_occurrence_limit":10}`},
	} {
		result := callAction(t, s, tc.name, tc.args)
		marker := result["structuredContent"].(map[string]any)
		if result["isError"] != true || marker["requires_dashboard"] != true || marker["operation"] != tc.name {
			t.Fatal("direct backend implied execution", result)
		}
	}
	r.auth.AllowWrites = false
	result := callAction(t, s, "update_settings", `{"confirm":true,"small_csv_occurrence_limit":10}`)
	if result["structuredContent"] != nil {
		t.Fatal("disabled writes emitted trusted execution marker", result)
	}
}
