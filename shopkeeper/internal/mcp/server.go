package mcp

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math"
	"math/big"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/sumanbasuli/lime/shopkeeper/internal/buildinfo"
	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
	"github.com/sumanbasuli/lime/shopkeeper/internal/repository"
	log "github.com/sumanbasuli/lime/shopkeeper/internal/safelog"
)

const protocolVersion = "2025-11-25"

const maxRequestBodyBytes = 1 << 20
const dashboardTransformHeader = "X-Lime-MCP-Transform"

var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

var errScanNotFound = errors.New("Scan not found. Use list_scans to find an existing scan ID.")
var errIssueNotFound = errors.New("Issue group not found. Use list_scan_issues to find an existing kind and key.")

func supportedProtocolVersion(version string) bool {
	return version == protocolVersion || version == "2025-06-18" || version == "2025-03-26"
}

type Repository interface {
	BeginMCPRead(context.Context) (context.Context, func() time.Time, error)
	BeginMCPActionCall(context.Context) (context.Context, func() time.Time, error)
	GetMCPAuthSettings(ctx context.Context) (*models.MCPAuthSettings, error)
	ListMCPScans(ctx context.Context, limit, offset int) ([]models.Scan, error)
	GetScan(ctx context.Context, id string) (*models.Scan, error)
	GetMCPScanReference(ctx context.Context, id string) (*models.Scan, error)
	GetMCPReportSettings(ctx context.Context) (*models.MCPVisibleSettings, error)
	GetMCPScanScoreSummary(ctx context.Context, scanID string) (*models.MCPScanScoreSummary, error)
	GetMCPIssueSummaries(ctx context.Context, scanID string, limit, offset int) ([]models.MCPIssueSummary, int, error)
	GetMCPIssueDetail(ctx context.Context, scanID, kind, key string, limit, offset int) (*models.MCPIssueDetail, error)
	GetMCPVisibleSettings(ctx context.Context) (*models.MCPVisibleSettings, error)
	ListLinkChecks(ctx context.Context, limit, offset int) ([]models.LinkCheck, int, error)
	GetLinkCheck(ctx context.Context, id string) (*models.LinkCheck, error)
	GetLinkCheckStats(ctx context.Context) (map[string]int64, error)
	GetScanLinkCheck(ctx context.Context, scanID string) (*models.LinkCheck, error)
	GetLinkResults(ctx context.Context, checkID, status string, limit, offset int) ([]models.LinkResult, int, error)
	GetLinkSources(ctx context.Context, checkID, resultID string, limit, offset int) ([]models.LinkSource, int, bool, error)
}

type Server struct {
	repo    Repository
	actions http.Handler
}

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      any             `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcResponse struct {
	JSONRPC string    `json:"jsonrpc"`
	ID      any       `json:"id"`
	Result  any       `json:"result,omitempty"`
	Error   *rpcError `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type toolCallParams struct {
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
}

func decodeToolCallParams(raw json.RawMessage) (toolCallParams, error) {
	var params toolCallParams
	err := json.Unmarshal(raw, &params)
	return params, err
}

func dashboardTransformNeeded(request rpcRequest) bool {
	if request.Method != "tools/call" {
		return false
	}
	params, err := decodeToolCallParams(request.Params)
	if err != nil {
		return false
	}
	switch params.Name {
	case "get_scan", "get_report", "get_screenshot", "get_link_check_export", "update_settings":
		return true
	default:
		return false
	}
}

func New(repo Repository, actions ...http.Handler) *Server {
	s := &Server{repo: repo}
	if len(actions) > 0 {
		s.actions = actions[0]
	}
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !validOrigin(r.Header.Get("Origin")) {
		writeRPCError(w, http.StatusForbidden, nil, -32000, "invalid origin")
		return
	}
	if version := r.Header.Get("MCP-Protocol-Version"); version != "" && !supportedProtocolVersion(version) {
		writeRPCError(w, http.StatusBadRequest, nil, -32600, "unsupported MCP-Protocol-Version")
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
	if !s.authorizeRequest(w, r, nil) {
		return
	}

	request, hasID, rpcErr := decodeRequest(http.MaxBytesReader(w, r.Body, maxRequestBodyBytes))
	if rpcErr != nil {
		status := http.StatusBadRequest
		if rpcErr.Code == -32003 {
			status = http.StatusRequestEntityTooLarge
		}
		writeRPCError(w, status, request.ID, rpcErr.Code, rpcErr.Message)
		return
	}
	// Body decoding can wait on a slow client while the key is rotated or MCP is
	// disabled. Check the live setting again before dispatching any work.
	if !s.authorizeRequest(w, r, request.ID) {
		return
	}

	if !hasID {
		if !strings.HasPrefix(request.Method, "notifications/") {
			writeRPCError(w, http.StatusBadRequest, nil, -32600, "requests must include an id")
			return
		}
		w.WriteHeader(http.StatusAccepted)
		return
	}
	// The dashboard only materializes responses for its own tool enrichments.
	// Classify with the same decoder used by dispatch, including JSON key aliases
	// and duplicate-key ordering, so it cannot disagree about the executed tool.
	w.Header().Set(dashboardTransformHeader, "none")
	if dashboardTransformNeeded(request) {
		w.Header().Set(dashboardTransformHeader, "dashboard")
	}

	state := &readLifecycle{}
	defer state.finish()
	actionState := &actionLifecycle{}
	defer actionState.finish()
	ctx := context.WithValue(r.Context(), readLifecycleKey{}, state)
	ctx = context.WithValue(ctx, actionLifecycleKey{}, actionState)
	result, rpcErr := s.dispatch(ctx, request)
	state.finishRead()
	actionState.finishRead()
	if state.release != nil || actionState.release != nil {
		defer finishReadDelivery(w)()
	}
	if state.busy || actionState.busy {
		w.Header().Set("Retry-After", "1")
		// No slot is available to buffer another potentially 1 MiB RPC ID.
		message := "MCP saved-data read capacity is busy. Retry this read after 1 second."
		if actionState.busy {
			message = "MCP action capacity is busy. No action was started; retry after 1 second using the same request_id."
		}
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": message})
		return
	}
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

func decodeRequest(body io.Reader) (rpcRequest, bool, *rpcError) {
	var request rpcRequest
	decoder := json.NewDecoder(body)
	decoder.UseNumber()
	var raw json.RawMessage
	if err := decoder.Decode(&raw); err != nil {
		var sizeError *http.MaxBytesError
		if errors.As(err, &sizeError) {
			return request, false, &rpcError{Code: -32003, Message: "MCP request body exceeds 1 MiB"}
		}
		return request, false, &rpcError{Code: -32700, Message: "parse error"}
	}
	var extra json.RawMessage
	if err := decoder.Decode(&extra); err != io.EOF {
		var sizeError *http.MaxBytesError
		if errors.As(err, &sizeError) {
			return request, false, &rpcError{Code: -32003, Message: "MCP request body exceeds 1 MiB"}
		}
		return request, false, &rpcError{Code: -32700, Message: "body must contain one JSON-RPC message"}
	}
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(raw, &envelope); err != nil || envelope == nil {
		return request, false, &rpcError{Code: -32600, Message: "expected a JSON-RPC object"}
	}
	if err := json.Unmarshal(envelope["jsonrpc"], &request.JSONRPC); err != nil || request.JSONRPC != "2.0" {
		return request, false, &rpcError{Code: -32600, Message: "jsonrpc must be 2.0"}
	}
	if err := json.Unmarshal(envelope["method"], &request.Method); err != nil || request.Method == "" {
		return request, false, &rpcError{Code: -32600, Message: "method must be a non-empty string"}
	}
	id, hasID := envelope["id"]
	if hasID {
		idDecoder := json.NewDecoder(strings.NewReader(string(id)))
		idDecoder.UseNumber()
		if err := idDecoder.Decode(&request.ID); err != nil {
			return request, false, &rpcError{Code: -32600, Message: "invalid request id"}
		}
		switch value := request.ID.(type) {
		case string:
		case json.Number:
			if !isJSONInteger(value) {
				return rpcRequest{}, false, &rpcError{Code: -32600, Message: "id must be a string or integer"}
			}
		default:
			return rpcRequest{}, false, &rpcError{Code: -32600, Message: "id must be a string or integer"}
		}
	}
	request.Params = envelope["params"]
	if len(request.Params) > 0 {
		var params map[string]json.RawMessage
		if err := json.Unmarshal(request.Params, &params); err != nil || params == nil {
			return request, hasID, &rpcError{Code: -32602, Message: "params must be an object"}
		}
	}
	return request, hasID, nil
}

// Preserve JSON number precision for IDs and pagination. Guard overflow and
// underflow before big.Rat so short inputs with extreme exponents cannot cause
// enormous powers to be allocated. An all-zero coefficient is exactly zero.
func isJSONInteger(value json.Number) bool {
	approximation, err := value.Float64()
	if err != nil || math.IsInf(approximation, 0) {
		return false
	}
	if approximation == 0 {
		coefficient := strings.FieldsFunc(value.String(), func(r rune) bool { return r == 'e' || r == 'E' })[0]
		return strings.Trim(coefficient, "-0.") == ""
	}
	number, ok := new(big.Rat).SetString(value.String())
	return ok && number.IsInt()
}

func (s *Server) authorizeRequest(w http.ResponseWriter, r *http.Request, id any) bool {
	allowed, err := s.authorized(r.Context(), r.Header.Get("Authorization"))
	if err != nil {
		w.Header().Set("Retry-After", "1")
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "MCP authorization is temporarily unavailable. Retry after 1 second."})
		return false
	}
	if !allowed {
		w.Header().Set("WWW-Authenticate", `Bearer realm="LIME MCP"`)
		writeRPCError(w, http.StatusUnauthorized, id, -32001, "unauthorized")
	}
	return allowed
}

func (s *Server) authorized(ctx context.Context, authHeader string) (bool, error) {
	settings, err := s.repo.GetMCPAuthSettings(ctx)
	if err != nil {
		return false, err
	}
	if settings == nil || !settings.Enabled || settings.KeyHash == nil {
		return false, nil
	}

	parts := strings.Fields(authHeader)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return false, nil
	}
	token := parts[1]

	sum := sha256.Sum256([]byte(token))
	actual := hex.EncodeToString(sum[:])
	return subtle.ConstantTimeCompare([]byte(actual), []byte(*settings.KeyHash)) == 1, nil
}

func (s *Server) dispatch(ctx context.Context, request rpcRequest) (any, *rpcError) {
	switch request.Method {
	case "initialize":
		var params struct {
			ProtocolVersion string                     `json:"protocolVersion"`
			Capabilities    map[string]json.RawMessage `json:"capabilities"`
			ClientInfo      struct {
				Name    string `json:"name"`
				Version string `json:"version"`
			} `json:"clientInfo"`
		}
		if err := json.Unmarshal(request.Params, &params); err != nil || params.ProtocolVersion == "" || params.Capabilities == nil || params.ClientInfo.Name == "" || params.ClientInfo.Version == "" {
			return nil, &rpcError{Code: -32602, Message: "initialize requires protocolVersion, capabilities and clientInfo name/version"}
		}
		negotiatedVersion := params.ProtocolVersion
		if !supportedProtocolVersion(negotiatedVersion) {
			negotiatedVersion = protocolVersion
		}
		return map[string]any{
			"protocolVersion": negotiatedVersion,
			"capabilities": map[string]any{
				"tools": map[string]any{},
			},
			"serverInfo": map[string]any{
				"name":    "lime",
				"version": buildinfo.Version,
			},
		}, nil
	case "ping":
		return map[string]any{}, nil
	case "tools/list":
		definitions := append(append(tools(), capabilitiesTool()), dashboardReadTools()...)
		if s.writesAllowed(ctx) && s.actions != nil {
			definitions = append(definitions, actionTools()...)
		}
		return map[string]any{"tools": definitions}, nil
	case "tools/call":
		return s.handleToolCall(ctx, request.Params)
	default:
		return nil, &rpcError{Code: -32601, Message: "method not found"}
	}
}

func (s *Server) handleToolCall(ctx context.Context, raw json.RawMessage) (any, *rpcError) {
	params, decodeErr := decodeToolCallParams(raw)
	if decodeErr != nil {
		return nil, &rpcError{Code: -32602, Message: "invalid tool call parameters"}
	}
	if params.Name == "" {
		return nil, &rpcError{Code: -32602, Message: "tool name is required"}
	}
	var arguments map[string]any
	if len(params.Arguments) > 0 {
		var err error
		arguments, err = decodeArguments(params.Arguments)
		if err != nil || arguments == nil {
			return nil, &rpcError{Code: -32602, Message: "tool arguments must be an object"}
		}
	}
	var definition map[string]any
	for _, candidate := range append(append(append(tools(), capabilitiesTool()), dashboardReadTools()...), actionTools()...) {
		if candidate["name"] == params.Name {
			definition = candidate
			break
		}
	}
	if definition == nil {
		return nil, &rpcError{Code: -32602, Message: "unknown tool"}
	}
	if message := validateArguments(definition, arguments); message != "" {
		return toolError(message), nil
	}
	if definition["annotations"].(map[string]any)["readOnlyHint"] == false {
		// Check live settings even when a client cached an earlier tools/list.
		if !s.writesAllowed(ctx) {
			return toolError("MCP write access is disabled. An instance owner must enable write access in Settings > Integrations."), nil
		}
		if s.actions == nil {
			return toolError("MCP actions are unavailable on this endpoint. Use the dashboard MCP endpoint."), nil
		}
		if params.Name != "update_settings" {
			state, _ := ctx.Value(actionLifecycleKey{}).(*actionLifecycle)
			if state == nil {
				state = &actionLifecycle{}
				defer state.finish()
			}
			actionCtx, admitted, err := state.begin(ctx, s.repo)
			if !admitted {
				return readToolError("MCP action capacity is busy. No action was started; retry after 1 second using the same request_id.", 503, true), nil
			}
			if err != nil {
				return toolError("Unable to prepare the LIME action. No action was started; retry using the same request_id."), nil
			}
			ctx = actionCtx
		}
		return s.handleAction(ctx, params.Name, arguments), nil
	}
	// Dashboard dispatch markers contain only already-validated arguments; they
	// do not read saved evidence or occupy native read capacity.
	if params.Name != "get_report" && params.Name != "get_screenshot" && params.Name != "get_link_check_export" {
		state, _ := ctx.Value(readLifecycleKey{}).(*readLifecycle)
		if state == nil {
			state = &readLifecycle{}
			defer state.finish()
		}
		readCtx, admitted, err := state.begin(ctx, s.repo)
		if !admitted {
			return readToolError("MCP saved-data read capacity is busy. Retry this read after 1 second.", 503, true), nil
		}
		if err != nil {
			return toolError("Unable to prepare the LIME data read. Retry this read."), nil
		}
		ctx = readCtx
	}

	var result any
	var err error
	switch params.Name {
	case "get_capabilities":
		result = s.getCapabilities(ctx)
	case "get_workspace_stats":
		result, err = s.getWorkspaceStats(ctx)
	case "get_report", "get_screenshot", "get_link_check_export":
		return dashboardRequired(params.Name, arguments), nil
	case "list_scans":
		result, err = s.listScans(ctx, arguments)
	case "get_scan":
		result, err = s.getScan(ctx, arguments)
	case "list_scan_issues":
		result, err = s.listScanIssues(ctx, arguments)
	case "get_issue_detail":
		result, err = s.getIssueDetail(ctx, arguments)
	case "get_report_metadata":
		result, err = s.getReportMetadata(ctx, arguments)
	case "get_settings":
		result, err = s.repo.GetMCPVisibleSettings(ctx)
	case "list_link_checks":
		result, err = s.listLinkChecks(ctx, arguments)
	case "get_link_check":
		result, err = s.getLinkCheck(ctx, arguments)
	case "get_link_check_stats":
		result, err = s.getLinkCheckStats(ctx)
	case "get_scan_link_check":
		result, err = s.getScanLinkCheck(ctx, arguments)
	case "list_link_check_results":
		result, err = s.listLinkCheckResults(ctx, arguments)
	case "list_link_check_sources":
		result, err = s.listLinkCheckSources(ctx, arguments)
	default:
		return nil, &rpcError{Code: -32602, Message: "unknown tool"}
	}
	if err != nil {
		if errors.Is(err, repository.ErrMCPReadTooLarge) {
			return readToolError("Selected LIME data is too large for one MCP response. Reduce limit or use the dashboard; no data was truncated.", 413, false), nil
		}
		if errors.Is(err, errScanNotFound) || errors.Is(err, errIssueNotFound) || errors.Is(err, errLinkCheckNotFound) || errors.Is(err, errLinkResultNotFound) {
			return toolError(err.Error()), nil
		}
		log.Printf("MCP tool %s failed: %v", params.Name, err)
		return toolError("Unable to read LIME data. Try again or check the LIME server logs."), nil
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
		"scans":  models.PublicScans(scans),
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
		return nil, errScanNotFound
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

	publicScan := models.PublicScan(*scan)
	return models.MCPScanDetail{
		Scan: &publicScan,
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
		"issues": models.PublicMCPIssueSummaries(issues),
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
	if detail == nil {
		return nil, errIssueNotFound
	}
	publicDetail := *detail
	publicDetail.Summary = models.PublicMCPIssueSummary(detail.Summary)
	publicDetail.Occurrences = models.PublicIssueOccurrences(detail.Occurrences)
	return map[string]any{"detail": &publicDetail}, nil
}

func (s *Server) getReportMetadata(ctx context.Context, args map[string]any) (any, error) {
	scanID := stringArg(args, "scan_id")
	scan, err := s.repo.GetMCPScanReference(ctx, scanID)
	if err != nil {
		return nil, err
	}
	if scan == nil {
		return nil, errScanNotFound
	}
	settings, err := s.repo.GetMCPReportSettings(ctx)
	if err != nil {
		return nil, err
	}
	availability := map[string]bool{"pdf": true, "csv": true, "llm": true}
	if settings != nil {
		for format := range availability {
			if enabled, ok := settings.Reporting[format+"_reports_enabled"].(bool); ok {
				availability[format] = enabled
			}
		}
	}

	return map[string]any{
		"scan_id":                  scanID,
		"availability":             availability,
		"report_paths_relative_to": "dashboard_origin",
		"reports": map[string]any{
			"pdf": "/api/scans/" + scanID + "/issues/report.pdf",
			"csv": "/api/scans/" + scanID + "/issues/report.csv",
			"llm": "/api/scans/" + scanID + "/issues/report.llm.txt",
		},
	}, nil
}

func tools() []map[string]any {
	return append([]map[string]any{
		tool("list_scans", "List scans with status and progress metadata.", map[string]any{
			"limit":  integerSchema("Maximum scans to return.", 1, 100, 20),
			"offset": integerSchema("Number of scans to skip.", 0, 100000, 0),
		}),
		tool("get_scan", "Get one scan by ID.", map[string]any{
			"scan_id": uuidSchema("Scan ID."),
		}, "scan_id"),
		tool("list_scan_issues", "List failed and needs-review issue groups for a scan.", map[string]any{
			"scan_id": uuidSchema("Scan ID."),
			"limit":   integerSchema("Maximum issue groups to return.", 1, 100, 20),
			"offset":  integerSchema("Number of issue groups to skip.", 0, 100000, 0),
		}, "scan_id"),
		tool("get_issue_detail", "Get paginated occurrences for one issue group.", map[string]any{
			"scan_id": uuidSchema("Scan ID."),
			"kind":    map[string]any{"type": "string", "enum": []string{"failed", "needs_review"}},
			"key":     stringSchema("Issue key from list_scan_issues."),
			"limit":   integerSchema("Maximum occurrences to return.", 1, 100, 25),
			"offset":  integerSchema("Number of occurrences to skip.", 0, 100000, 0),
		}, "scan_id", "kind", "key"),
		tool("get_report_metadata", "Get report endpoint metadata for a scan.", map[string]any{
			"scan_id": uuidSchema("Scan ID."),
		}, "scan_id"),
		tool("get_settings", "Read MCP settings visible to clients.", map[string]any{}),
	}, linkTools()...)
}

func tool(name, description string, properties map[string]any, required ...string) map[string]any {
	inputSchema := map[string]any{
		"type":                 "object",
		"properties":           properties,
		"additionalProperties": false,
	}
	if len(required) > 0 {
		inputSchema["required"] = required
	}
	return map[string]any{
		"name":        name,
		"description": description,
		"inputSchema": inputSchema,
		"annotations": map[string]any{
			"readOnlyHint":    true,
			"destructiveHint": false,
			"idempotentHint":  true,
			"openWorldHint":   false,
		},
	}
}

func stringSchema(description string) map[string]any {
	return map[string]any{"type": "string", "description": description, "minLength": 1, "maxLength": 256}
}

func uuidSchema(description string) map[string]any {
	return map[string]any{"type": "string", "description": description, "pattern": uuidPattern.String()}
}

func integerSchema(description string, minimum, maximum, fallback int) map[string]any {
	return map[string]any{"type": "integer", "description": description, "minimum": minimum, "maximum": maximum, "default": fallback}
}

func validateArguments(definition map[string]any, args map[string]any) string {
	schema := definition["inputSchema"].(map[string]any)
	properties := schema["properties"].(map[string]any)
	if required, ok := schema["required"].([]string); ok {
		for _, key := range required {
			if _, exists := args[key]; !exists {
				return key + " is required."
			}
		}
	}
	for key, value := range args {
		candidate, ok := properties[key]
		if !ok {
			return "Unknown argument: " + key
		}
		property := candidate.(map[string]any)
		switch property["type"] {
		case "string":
			text, ok := value.(string)
			maximum := 256
			if configured, ok := property["maxLength"].(int); ok {
				maximum = configured
			}
			if !ok || strings.TrimSpace(text) == "" || len(text) > maximum {
				return key + " must be a non-empty string of at most " + strconv.Itoa(maximum) + " characters."
			}
			if pattern, hasPattern := property["pattern"].(string); hasPattern && !regexp.MustCompile(pattern).MatchString(text) {
				if pattern == uuidPattern.String() {
					return key + " must be a UUID."
				}
				return key + " does not match its allowed format."
			}
			if allowed, ok := property["enum"].([]string); ok {
				valid := false
				for _, option := range allowed {
					valid = valid || text == option
				}
				if !valid {
					return key + " must be one of: " + strings.Join(allowed, ", ")
				}
			}
			if property["format"] == "uri" && !validActionURL(text) {
				return key + " must be an absolute HTTP/HTTPS URL without credentials."
			}
		case "boolean":
			boolean, ok := value.(bool)
			if !ok {
				return key + " must be a boolean."
			}
			if required, ok := property["const"].(bool); ok && boolean != required {
				return key + " must be true to confirm deletion."
			}
		case "integer":
			number, ok := value.(json.Number)
			approximation, err := number.Float64()
			if !ok || err != nil || approximation < float64(property["minimum"].(int)) || approximation > float64(property["maximum"].(int)) || !isJSONInteger(number) {
				return key + " must be an integer between " + strconv.Itoa(property["minimum"].(int)) + " and " + strconv.Itoa(property["maximum"].(int)) + "."
			}
		}
	}
	if definition["name"] == "get_issue_detail" && args["kind"] == "failed" {
		if key, ok := args["key"].(string); !ok || !uuidPattern.MatchString(key) {
			return "key must be an issue UUID when kind is failed."
		}
	}
	if definition["name"] == "get_screenshot" && strings.Contains(stringArg(args, "filename"), "..") {
		return "filename must be a saved basename without '..'."
	}
	if definition["name"] == "get_report" {
		_, hasKind := args["kind"]
		_, hasKey := args["key"]
		_, hasIssueID := args["issue_id"]
		if hasKind != hasKey {
			return "kind and key must be supplied together."
		}
		if hasIssueID && (hasKind || hasKey) {
			return "Use either issue_id or kind/key, never both."
		}
		if args["kind"] == "failed" && !uuidPattern.MatchString(stringArg(args, "key")) {
			return "key must be an issue UUID when kind is failed."
		}
	}
	if definition["name"] == "update_settings" && len(args) < 2 {
		return "At least one reporting or performance setting is required."
	}
	return ""
}

func toolError(message string) map[string]any {
	return map[string]any{
		"isError": true,
		"content": []map[string]string{{"type": "text", "text": message}},
	}
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
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return false
	}
	host := strings.ToLower(parsed.Hostname())
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

func stringArg(args map[string]any, key string) string {
	value, _ := args[key].(string)
	return value
}

func boundedInt(value any, fallback, minimum, maximum int) int {
	var parsed int
	switch v := value.(type) {
	case json.Number:
		number, err := v.Float64()
		if err != nil {
			parsed = fallback
		} else {
			parsed = int(number)
		}
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
