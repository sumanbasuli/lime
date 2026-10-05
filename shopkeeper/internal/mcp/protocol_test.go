package mcp

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
)

const testScanID = "11111111-1111-4111-8111-111111111111"
const testIssueID = "22222222-2222-4222-8222-222222222222"
const testToken = "lime-test-only-key"

// This stub counts data reads separately from per-request authentication so
// malformed inputs can be shown not to reach UUID casts or data queries.
type stubRepository struct {
	auth        *models.MCPAuthSettings
	calls       int
	err         error
	scan        *models.Scan
	score       *models.MCPScanScoreSummary
	detail      *models.MCPIssueDetail
	settings    *models.MCPVisibleSettings
	limit       int
	offset      int
	check       *models.LinkCheck
	checks      []models.LinkCheck
	companion   *models.LinkCheck
	results     []models.LinkResult
	sources     []models.LinkSource
	linkStats   map[string]int64
	linkTotal   int
	sourceFound bool
	checkID     string
	resultID    string
	linkStatus  string
	linkErr     error
}

func newStubRepository() *stubRepository {
	sum := sha256.Sum256([]byte(testToken))
	hash := hex.EncodeToString(sum[:])
	return &stubRepository{
		auth:        &models.MCPAuthSettings{Enabled: true, KeyHash: &hash},
		scan:        &models.Scan{ID: testScanID, Status: "completed", TotalURLs: 2, ScannedURLs: 2},
		detail:      &models.MCPIssueDetail{Summary: models.MCPIssueSummary{Key: testIssueID}, Occurrences: []models.IssueOccurrence{}},
		check:       &models.LinkCheck{ID: testCheckID, URL: "https://example.test", Status: "completed", CheckType: "single"},
		checks:      []models.LinkCheck{},
		results:     []models.LinkResult{},
		sources:     []models.LinkSource{},
		sourceFound: true,
		linkStats:   map[string]int64{"total_checks": 0},
		settings: &models.MCPVisibleSettings{
			Reporting:    map[string]any{"pdf_reports_enabled": false, "csv_reports_enabled": true, "llm_reports_enabled": false},
			Integrations: map[string]any{"mcp_enabled": true, "mcp_mode": "read_only"},
		},
	}
}

func (r *stubRepository) GetMCPAuthSettings(context.Context) (*models.MCPAuthSettings, error) {
	return r.auth, nil
}
func (r *stubRepository) ListMCPScans(_ context.Context, limit, offset int) ([]models.Scan, error) {
	r.calls++
	r.limit, r.offset = limit, offset
	return []models.Scan{*r.scan}, r.err
}
func (r *stubRepository) GetScan(context.Context, string) (*models.Scan, error) {
	r.calls++
	return r.scan, r.err
}
func (r *stubRepository) GetMCPScanScoreSummary(context.Context, string) (*models.MCPScanScoreSummary, error) {
	r.calls++
	return r.score, r.err
}
func (r *stubRepository) GetMCPIssueSummaries(_ context.Context, _ string, limit, offset int) ([]models.MCPIssueSummary, int, error) {
	r.calls++
	r.limit, r.offset = limit, offset
	return []models.MCPIssueSummary{{Kind: "failed", Key: testIssueID}}, 1, r.err
}
func (r *stubRepository) GetMCPIssueDetail(_ context.Context, _, _, _ string, limit, offset int) (*models.MCPIssueDetail, error) {
	r.calls++
	r.limit, r.offset = limit, offset
	return r.detail, r.err
}
func (r *stubRepository) GetMCPVisibleSettings(context.Context) (*models.MCPVisibleSettings, error) {
	r.calls++
	return r.settings, r.err
}

func (r *stubRepository) ListLinkChecks(_ context.Context, limit, offset int) ([]models.LinkCheck, int, error) {
	r.calls++
	r.limit, r.offset = limit, offset
	return r.checks, r.linkTotal, r.linkErr
}
func (r *stubRepository) GetLinkCheck(_ context.Context, id string) (*models.LinkCheck, error) {
	r.calls++
	r.checkID = id
	if r.check == nil || !strings.EqualFold(r.check.ID, id) {
		return nil, r.err
	}
	return r.check, r.err
}
func (r *stubRepository) GetLinkCheckStats(context.Context) (map[string]int64, error) {
	r.calls++
	return r.linkStats, r.linkErr
}
func (r *stubRepository) GetScanLinkCheck(_ context.Context, scanID string) (*models.LinkCheck, error) {
	r.calls++
	r.checkID = scanID
	return r.companion, r.linkErr
}
func (r *stubRepository) GetLinkResults(_ context.Context, checkID, status string, limit, offset int) ([]models.LinkResult, int, error) {
	r.calls++
	r.checkID, r.linkStatus, r.limit, r.offset = checkID, status, limit, offset
	return r.results, r.linkTotal, r.linkErr
}
func (r *stubRepository) GetLinkSources(_ context.Context, checkID, resultID string, limit, offset int) ([]models.LinkSource, int, bool, error) {
	r.calls++
	r.checkID, r.resultID, r.limit, r.offset = checkID, resultID, limit, offset
	return r.sources, r.linkTotal, r.sourceFound && strings.EqualFold(checkID, testCheckID) && strings.EqualFold(resultID, testResultID), r.linkErr
}

func postRPC(server *Server, body string, headers map[string]string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+testToken)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	return response
}

func responseObject(t *testing.T, response *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var payload map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("invalid response JSON: %v (%s)", err, response.Body.String())
	}
	return payload
}

func TestRequestEnvelopeValidation(t *testing.T) {
	cases := []struct {
		name string
		body string
		code int
	}{
		{"syntax", `{`, -32700},
		{"multiple messages", `{"jsonrpc":"2.0","id":1,"method":"ping"} {}`, -32700},
		{"batch", `[{"jsonrpc":"2.0","id":1,"method":"ping"}]`, -32600},
		{"null", `null`, -32600},
		{"version", `{"jsonrpc":"1.0","id":1,"method":"ping"}`, -32600},
		{"method", `{"jsonrpc":"2.0","id":1,"method":17}`, -32600},
		{"null id", `{"jsonrpc":"2.0","id":null,"method":"ping"}`, -32600},
		{"bool id", `{"jsonrpc":"2.0","id":true,"method":"ping"}`, -32600},
		{"fraction id", `{"jsonrpc":"2.0","id":1.0000000000000000001,"method":"ping"}`, -32600},
		{"array params", `{"jsonrpc":"2.0","id":1,"method":"ping","params":[]}`, -32602},
		{"null params", `{"jsonrpc":"2.0","id":1,"method":"ping","params":null}`, -32602},
		{"request missing id", `{"jsonrpc":"2.0","method":"tools/list"}`, -32600},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			repo := newStubRepository()
			response := postRPC(New(repo), test.body, nil)
			if response.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
			}
			payload := responseObject(t, response)
			if got := payload["error"].(map[string]any)["code"]; got != float64(test.code) {
				t.Fatalf("code = %v, want %d", got, test.code)
			}
			if _, exists := payload["id"]; !exists {
				t.Fatal("JSON-RPC error must contain an id (null when unknown)")
			}
			if repo.calls != 0 {
				t.Fatalf("invalid request caused %d data reads", repo.calls)
			}
		})
	}
}

func TestProtocolTransportAndAuthentication(t *testing.T) {
	repo := newStubRepository()
	server := New(repo)
	ping := `{"jsonrpc":"2.0","id":"client-1","method":"ping"}`
	for _, header := range []string{"", "Bearer wrong", "Basic " + testToken, "Bearer " + testToken + " extra"} {
		response := postRPC(server, ping, map[string]string{"Authorization": header})
		if response.Code != http.StatusUnauthorized || response.Header().Get("WWW-Authenticate") == "" {
			t.Fatalf("header %q: expected challenged 401, got %d", header, response.Code)
		}
	}
	response := postRPC(server, ping, map[string]string{"Authorization": "bearer " + testToken})
	if response.Code != http.StatusOK || responseObject(t, response)["id"] != "client-1" {
		t.Fatal("case-insensitive Bearer scheme or string ID failed")
	}
	repo.auth.Enabled = false
	if got := postRPC(server, ping, nil).Code; got != http.StatusUnauthorized {
		t.Fatalf("disabled endpoint status = %d", got)
	}
	repo.auth = newStubRepository().auth
	rotated := sha256.Sum256([]byte("rotated-test-key"))
	hash := hex.EncodeToString(rotated[:])
	repo.auth.KeyHash = &hash
	if got := postRPC(server, ping, nil).Code; got != http.StatusUnauthorized {
		t.Fatalf("rotated key accepted old token: %d", got)
	}
	repo.auth = newStubRepository().auth
	for _, version := range []string{"2025-11-25", "2025-06-18", "2025-03-26", ""} {
		if got := postRPC(server, ping, map[string]string{"MCP-Protocol-Version": version}).Code; got != http.StatusOK {
			t.Fatalf("supported protocol %q status = %d", version, got)
		}
	}
	if got := postRPC(server, ping, map[string]string{"MCP-Protocol-Version": "1999-01-01"}).Code; got != http.StatusBadRequest {
		t.Fatalf("unsupported protocol status = %d", got)
	}
	for _, origin := range []string{"https://evil.example", "null", "file://localhost", "http://localhost/path", "http://user@localhost"} {
		if got := postRPC(server, ping, map[string]string{"Origin": origin}).Code; got != http.StatusForbidden {
			t.Fatalf("invalid origin %q status = %d", origin, got)
		}
	}
	for _, origin := range []string{"", "http://localhost:3000", "https://127.0.0.1", "http://[::1]:3000"} {
		if got := postRPC(server, ping, map[string]string{"Origin": origin}).Code; got != http.StatusOK {
			t.Fatalf("local origin %q status = %d", origin, got)
		}
	}
	response = postRPC(server, `{"jsonrpc":"2.0","method":"notifications/initialized"}`, nil)
	if response.Code != http.StatusAccepted || response.Body.Len() != 0 {
		t.Fatalf("notification = %d %s", response.Code, response.Body.String())
	}
	response = postRPC(server, `{"jsonrpc":"2.0","id":9007199254740993,"method":"ping"}`, nil)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"id":9007199254740993`) {
		t.Fatal("integer request ID must be preserved without float precision loss")
	}
	response = postRPC(server, `{"jsonrpc":"2.0","id":1,"method":"ping","params":{"padding":"`+strings.Repeat("x", maxRequestBodyBytes)+`"}}`, nil)
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized request status = %d", response.Code)
	}
	for _, method := range []string{http.MethodGet, http.MethodPut, http.MethodDelete} {
		response = httptest.NewRecorder()
		server.ServeHTTP(response, httptest.NewRequest(method, "/mcp", nil))
		if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != "POST" {
			t.Fatalf("%s expected 405 with Allow: POST", method)
		}
	}
}

func TestInitializeNegotiation(t *testing.T) {
	for _, version := range []string{"2025-11-25", "2025-06-18", "2025-03-26", "unknown-client-version"} {
		params := json.RawMessage(`{"protocolVersion":"` + version + `","capabilities":{},"clientInfo":{"name":"test","version":"1"}}`)
		result, rpcErr := New(nil).dispatch(context.Background(), rpcRequest{Method: "initialize", Params: params})
		if rpcErr != nil {
			t.Fatal(rpcErr)
		}
		want := version
		if !supportedProtocolVersion(version) {
			want = protocolVersion
		}
		if got := result.(map[string]any)["protocolVersion"]; got != want {
			t.Fatalf("requested %s: negotiated %v, want %s", version, got, want)
		}
	}
	for _, params := range []string{`{}`, `{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{}}`, `{"protocolVersion":"2025-11-25","capabilities":[],"clientInfo":{"name":"test","version":"1"}}`} {
		_, rpcErr := New(nil).dispatch(context.Background(), rpcRequest{Method: "initialize", Params: json.RawMessage(params)})
		if rpcErr == nil || rpcErr.Code != -32602 {
			t.Fatalf("invalid initialize params accepted: %s", params)
		}
	}
}

func TestToolSchemasAndArgumentValidation(t *testing.T) {
	definitions := tools()
	if len(definitions) != 12 {
		t.Fatalf("expected six existing and six Link Checker tools, got %d", len(definitions))
	}
	for _, definition := range definitions {
		annotations := definition["annotations"].(map[string]any)
		if annotations["readOnlyHint"] != true || annotations["destructiveHint"] != false {
			t.Fatalf("missing read-only annotations: %s", definition["name"])
		}
		properties := definition["inputSchema"].(map[string]any)["properties"].(map[string]any)
		if pagination, ok := properties["limit"].(map[string]any); ok {
			if pagination["type"] != "integer" || pagination["minimum"] != 1 || pagination["maximum"] != 100 {
				t.Fatalf("unbounded/non-integer pagination: %s", definition["name"])
			}
		}
	}
	cases := []struct{ name, args string }{
		{"get_scan", `{}`},
		{"get_scan", `{"scan_id":"not-a-uuid"}`},
		{"get_scan", `{"scan_id":null}`},
		{"list_scans", `{"limit":1.5}`},
		{"list_scans", `{"limit":"10"}`},
		{"list_scans", `{"limit":0}`},
		{"list_scans", `{"limit":101}`},
		{"list_scans", `{"offset":-1}`},
		{"list_scans", `{"offset":100001}`},
		{"list_scans", `{"unknown":true}`},
		{"get_issue_detail", `{"scan_id":"` + testScanID + `","kind":"unsupported","key":"foo"}`},
		{"get_issue_detail", `{"scan_id":"` + testScanID + `","kind":"failed","key":"not-a-uuid"}`},
		{"get_issue_detail", `{"scan_id":"` + testScanID + `","kind":"needs_review","key":" "}`},
	}
	for _, test := range cases {
		t.Run(test.name+test.args, func(t *testing.T) {
			repo := newStubRepository()
			result, rpcErr := New(repo).handleToolCall(context.Background(), json.RawMessage(`{"name":"`+test.name+`","arguments":`+test.args+`}`))
			if rpcErr != nil || result.(map[string]any)["isError"] != true {
				t.Fatalf("expected actionable tool error, got %v / %v", result, rpcErr)
			}
			if repo.calls != 0 {
				t.Fatalf("invalid argument caused %d data reads", repo.calls)
			}
		})
	}
	for _, params := range []string{`{"name":"unknown"}`, `{"arguments":{}}`, `{"name":1}`, `{"name":"get_scan","arguments":[]}`} {
		_, rpcErr := New(newStubRepository()).handleToolCall(context.Background(), json.RawMessage(params))
		if rpcErr == nil || rpcErr.Code != -32602 {
			t.Fatalf("malformed/unknown tool expected protocol error: %s", params)
		}
	}
}

func TestToolResultsAndErrorRedaction(t *testing.T) {
	cases := []struct {
		name, args string
		limit      int
	}{
		{"list_scans", `{}`, 20},
		{"get_scan", `{"scan_id":"` + testScanID + `"}`, 0},
		{"list_scan_issues", `{"scan_id":"` + testScanID + `","limit":100,"offset":2}`, 100},
		{"get_issue_detail", `{"scan_id":"` + testScanID + `","kind":"failed","key":"` + testIssueID + `"}`, 25},
		{"get_issue_detail", `{"scan_id":"` + testScanID + `","kind":"needs_review","key":"color-contrast"}`, 25},
		{"get_report_metadata", `{"scan_id":"` + testScanID + `"}`, 0},
		{"get_settings", `{}`, 0},
	}
	for _, test := range cases {
		t.Run(test.name+test.args, func(t *testing.T) {
			repo := newStubRepository()
			result, rpcErr := New(repo).handleToolCall(context.Background(), json.RawMessage(`{"name":"`+test.name+`","arguments":`+test.args+`}`))
			if rpcErr != nil {
				t.Fatal(rpcErr)
			}
			payload := result.(map[string]any)
			content := payload["content"].([]map[string]string)
			var text any
			if err := json.Unmarshal([]byte(content[0]["text"]), &text); err != nil {
				t.Fatal(err)
			}
			encoded, _ := json.Marshal(payload["structuredContent"])
			var structured any
			_ = json.Unmarshal(encoded, &structured)
			if !reflect.DeepEqual(text, structured) {
				t.Fatal("text and structured content differ")
			}
			if test.limit > 0 && repo.limit != test.limit {
				t.Fatalf("limit = %d, want %d", repo.limit, test.limit)
			}
			if test.name == "get_scan" && structured.(map[string]any)["score_summary"] != nil {
				t.Fatal("cold direct score cache should explicitly return null")
			}
			if test.name == "get_report_metadata" {
				metadata := structured.(map[string]any)
				if metadata["report_paths_relative_to"] != "dashboard_origin" || !reflect.DeepEqual(metadata["availability"], map[string]any{"pdf": false, "csv": true, "llm": false}) {
					t.Fatalf("incorrect report availability/base: %v", metadata)
				}
				if metadata["reports"].(map[string]any)["csv"] != "/api/scans/"+testScanID+"/issues/report.csv" {
					t.Fatal("existing report paths changed")
				}
			}
		})
	}
	repo := newStubRepository()
	repo.err = errors.New("connection failed: postgres://secret:password@private-host/internal-table")
	result, rpcErr := New(repo).handleToolCall(context.Background(), json.RawMessage(`{"name":"get_scan","arguments":{"scan_id":"`+testScanID+`"}}`))
	if rpcErr != nil || result.(map[string]any)["isError"] != true {
		t.Fatal("data read failure must be a tool execution error")
	}
	encoded, _ := json.Marshal(result)
	if strings.Contains(string(encoded), "password") || strings.Contains(string(encoded), "private-host") {
		t.Fatal("repository error leaked to MCP client")
	}
	for _, name := range []string{"get_scan", "get_report_metadata", "get_issue_detail"} {
		repo := newStubRepository()
		repo.scan, repo.detail = nil, nil
		args := `{"scan_id":"` + testScanID + `"}`
		if name == "get_issue_detail" {
			args = `{"scan_id":"` + testScanID + `","kind":"failed","key":"` + testIssueID + `"}`
		}
		result, rpcErr := New(repo).handleToolCall(context.Background(), json.RawMessage(`{"name":"`+name+`","arguments":`+args+`}`))
		if rpcErr != nil || result.(map[string]any)["isError"] != true {
			t.Fatalf("missing %s data must return an actionable tool error: %v / %v", name, result, rpcErr)
		}
	}
}
