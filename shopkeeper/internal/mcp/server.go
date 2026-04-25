package mcp

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
)

const protocolVersion = "2025-11-25"

type Repository interface {
	GetMCPAuthSettings(ctx context.Context) (*models.MCPAuthSettings, error)
	ListMCPScans(ctx context.Context, limit, offset int) ([]models.Scan, error)
	GetScan(ctx context.Context, id string) (*models.Scan, error)
	GetMCPScanScoreSummary(ctx context.Context, scanID string) (*models.MCPScanScoreSummary, error)
	GetMCPIssueSummaries(ctx context.Context, scanID string, limit, offset int) ([]models.MCPIssueSummary, int, error)
	GetMCPIssueDetail(ctx context.Context, scanID, kind, key string, limit, offset int) (*models.MCPIssueDetail, error)
	GetMCPVisibleSettings(ctx context.Context) (*models.MCPVisibleSettings, error)
}

type Server struct {
	repo Repository
}

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      any             `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcResponse struct {
	JSONRPC string    `json:"jsonrpc"`
	ID      any       `json:"id,omitempty"`
	Result  any       `json:"result,omitempty"`
	Error   *rpcError `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func New(repo Repository) *Server {
	return &Server{repo: repo}
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !validOrigin(r.Header.Get("Origin")) {
		writeRPCError(w, http.StatusForbidden, nil, -32000, "invalid origin")
		return
	}

	switch r.Method {
	case http.MethodPost:
		s.handlePost(w, r)
	case http.MethodGet:
		w.Header().Set("Allow", "POST")
		http.Error(w, "MCP SSE stream is not enabled", http.StatusMethodNotAllowed)
	default:
		w.Header().Set("Allow", "POST")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) handlePost(w http.ResponseWriter, r *http.Request) {
	if !s.authorized(r.Context(), r.Header.Get("Authorization")) {
		w.Header().Set("WWW-Authenticate", `Bearer realm="LIME MCP"`)
		writeRPCError(w, http.StatusUnauthorized, nil, -32001, "unauthorized")
		return
	}

	var request rpcRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeRPCError(w, http.StatusBadRequest, nil, -32700, "parse error")
		return
	}

	if request.ID == nil {
		w.WriteHeader(http.StatusAccepted)
		return
	}

	result, rpcErr := s.dispatch(r.Context(), request)
	if rpcErr != nil {
		writeJSON(w, http.StatusOK, rpcResponse{
			JSONRPC: "2.0",
			ID:      request.ID,
			Error:   rpcErr,
		})
		return
	}

	writeJSON(w, http.StatusOK, rpcResponse{
		JSONRPC: "2.0",
		ID:      request.ID,
		Result:  result,
	})
}

func (s *Server) authorized(ctx context.Context, authHeader string) bool {
	settings, err := s.repo.GetMCPAuthSettings(ctx)
	if err != nil || settings == nil || !settings.Enabled || settings.KeyHash == nil {
		return false
	}

	token, ok := strings.CutPrefix(authHeader, "Bearer ")
	if !ok || token == "" {
		return false
	}

	sum := sha256.Sum256([]byte(token))
	actual := hex.EncodeToString(sum[:])
	return subtle.ConstantTimeCompare([]byte(actual), []byte(*settings.KeyHash)) == 1
}

func (s *Server) dispatch(ctx context.Context, request rpcRequest) (any, *rpcError) {
	switch request.Method {
	case "initialize":
		return map[string]any{
			"protocolVersion": protocolVersion,
			"capabilities": map[string]any{
				"tools": map[string]any{},
			},
			"serverInfo": map[string]any{
				"name":    "lime",
				"version": "0.1.0",
			},
		}, nil
	case "ping":
		return map[string]any{}, nil
	case "tools/list":
		return map[string]any{"tools": tools()}, nil
	case "tools/call":
		return s.handleToolCall(ctx, request.Params)
	default:
		return nil, &rpcError{Code: -32601, Message: "method not found"}
	}
}

func (s *Server) handleToolCall(ctx context.Context, raw json.RawMessage) (any, *rpcError) {
	var params struct {
		Name      string         `json:"name"`
		Arguments map[string]any `json:"arguments"`
	}
	if err := json.Unmarshal(raw, &params); err != nil {
		return nil, &rpcError{Code: -32602, Message: "invalid tool call parameters"}
	}

	var result any
	var err error
	switch params.Name {
	case "list_scans":
		result, err = s.listScans(ctx, params.Arguments)
	case "get_scan":
		result, err = s.getScan(ctx, params.Arguments)
	case "list_scan_issues":
		result, err = s.listScanIssues(ctx, params.Arguments)
	case "get_issue_detail":
		result, err = s.getIssueDetail(ctx, params.Arguments)
	case "get_report_metadata":
		result, err = s.getReportMetadata(ctx, params.Arguments)
	case "get_settings":
		result, err = s.repo.GetMCPVisibleSettings(ctx)
	default:
		return nil, &rpcError{Code: -32602, Message: "unknown tool"}
	}
	if err != nil {
		return nil, &rpcError{Code: -32000, Message: err.Error()}
	}

	return toolResult(result), nil
}

func (s *Server) listScans(ctx context.Context, args map[string]any) (any, error) {
	limit := boundedInt(args["limit"], 20, 1, 100)
	offset := boundedInt(args["offset"], 0, 0, 100000)
	scans, err := s.repo.ListMCPScans(ctx, limit, offset)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"scans":  scans,
		"limit":  limit,
		"offset": offset,
	}, nil
}

func (s *Server) getScan(ctx context.Context, args map[string]any) (any, error) {
	scanID := stringArg(args, "scan_id")
	scan, err := s.repo.GetScan(ctx, scanID)
	if err != nil {
		return nil, err
	}
	if scan == nil {
		return models.MCPScanDetail{Scan: nil, ScoreSummary: nil}, nil
	}

	scoreSummary, err := s.repo.GetMCPScanScoreSummary(ctx, scanID)
	if err != nil {
		return nil, err
	}

	total := scan.TotalURLs
	scanned := scan.ScannedURLs
	percent := 0.0
	if total > 0 {
		percent = float64(scanned) / float64(total) * 100
	}

	return models.MCPScanDetail{
		Scan: scan,
		Progress: map[string]any{
			"scanned_urls": scanned,
			"total_urls":   total,
			"percent":      percent,
			"status":       scan.Status,
		},
		ScoreSummary: scoreSummary,
	}, nil
}

func (s *Server) listScanIssues(ctx context.Context, args map[string]any) (any, error) {
	scanID := stringArg(args, "scan_id")
	limit := boundedInt(args["limit"], 20, 1, 100)
	offset := boundedInt(args["offset"], 0, 0, 100000)
	issues, total, err := s.repo.GetMCPIssueSummaries(ctx, scanID, limit, offset)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"issues": issues,
		"total":  total,
		"limit":  limit,
		"offset": offset,
	}, nil
}

func (s *Server) getIssueDetail(ctx context.Context, args map[string]any) (any, error) {
	scanID := stringArg(args, "scan_id")
	kind := stringArg(args, "kind")
	key := stringArg(args, "key")
	limit := boundedInt(args["limit"], 25, 1, 100)
	offset := boundedInt(args["offset"], 0, 0, 100000)
	detail, err := s.repo.GetMCPIssueDetail(ctx, scanID, kind, key, limit, offset)
	if err != nil {
		return nil, err
	}
	return map[string]any{"detail": detail}, nil
}

func (s *Server) getReportMetadata(ctx context.Context, args map[string]any) (any, error) {
	scanID := stringArg(args, "scan_id")
	scan, err := s.repo.GetScan(ctx, scanID)
	if err != nil {
		return nil, err
	}
	if scan == nil {
		return map[string]any{"scan": nil}, nil
	}

	return map[string]any{
		"scan_id": scanID,
		"reports": map[string]any{
			"pdf": "/api/scans/" + scanID + "/issues/report.pdf",
			"csv": "/api/scans/" + scanID + "/issues/report.csv",
			"llm": "/api/scans/" + scanID + "/issues/report.llm.txt",
		},
	}, nil
}

func tools() []map[string]any {
	return []map[string]any{
		tool("list_scans", "List scans with status and progress metadata.", map[string]any{
			"limit":  numberSchema("Maximum scans to return."),
			"offset": numberSchema("Number of scans to skip."),
		}),
		tool("get_scan", "Get one scan by ID.", map[string]any{
			"scan_id": stringSchema("Scan ID."),
		}),
		tool("list_scan_issues", "List failed and needs-review issue groups for a scan.", map[string]any{
			"scan_id": stringSchema("Scan ID."),
			"limit":   numberSchema("Maximum issue groups to return."),
			"offset":  numberSchema("Number of issue groups to skip."),
		}),
		tool("get_issue_detail", "Get paginated occurrences for one issue group.", map[string]any{
			"scan_id": stringSchema("Scan ID."),
			"kind":    stringSchema("Issue kind: failed or needs_review."),
			"key":     stringSchema("Issue key from list_scan_issues."),
			"limit":   numberSchema("Maximum occurrences to return."),
			"offset":  numberSchema("Number of occurrences to skip."),
		}),
		tool("get_report_metadata", "Get report endpoint metadata for a scan.", map[string]any{
			"scan_id": stringSchema("Scan ID."),
		}),
		tool("get_settings", "Read MCP settings visible to clients.", map[string]any{}),
	}
}

func tool(name, description string, properties map[string]any) map[string]any {
	return map[string]any{
		"name":        name,
		"description": description,
		"inputSchema": map[string]any{
			"type":       "object",
			"properties": properties,
		},
	}
}

func stringSchema(description string) map[string]any {
	return map[string]any{"type": "string", "description": description}
}

func numberSchema(description string) map[string]any {
	return map[string]any{"type": "number", "description": description}
}

func toolResult(payload any) map[string]any {
	data, _ := json.MarshalIndent(payload, "", "  ")
	return map[string]any{
		"content": []map[string]string{
			{
				"type": "text",
				"text": string(data),
			},
		},
		"structuredContent": payload,
	}
}

func validOrigin(origin string) bool {
	if origin == "" {
		return true
	}
	parsed, err := url.Parse(origin)
	if err != nil {
		return false
	}
	host := parsed.Hostname()
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

func stringArg(args map[string]any, key string) string {
	value, _ := args[key].(string)
	return value
}

func boundedInt(value any, fallback, minimum, maximum int) int {
	var parsed int
	switch v := value.(type) {
	case float64:
		parsed = int(v)
	case int:
		parsed = v
	case string:
		n, err := strconv.Atoi(v)
		if err != nil {
			parsed = fallback
		} else {
			parsed = n
		}
	default:
		parsed = fallback
	}
	if parsed < minimum {
		return minimum
	}
	if parsed > maximum {
		return maximum
	}
	return parsed
}

func writeRPCError(w http.ResponseWriter, status int, id any, code int, message string) {
	writeJSON(w, status, rpcResponse{
		JSONRPC: "2.0",
		ID:      id,
		Error: &rpcError{
			Code:    code,
			Message: message,
		},
	})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
