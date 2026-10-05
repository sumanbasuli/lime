package mcp

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/sumanbasuli/lime/shopkeeper/internal/buildinfo"
)

func TestInitializeReportsBuildVersion(t *testing.T) {
	server := New(nil)
	result, rpcErr := server.dispatch(context.Background(), rpcRequest{Method: "initialize", Params: json.RawMessage(`{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"test","version":"1"}}`)})
	if rpcErr != nil {
		t.Fatalf("initialize returned an error: %v", rpcErr)
	}

	response, ok := result.(map[string]any)
	if !ok {
		t.Fatalf("expected initialize response object, got %T", result)
	}
	serverInfo, ok := response["serverInfo"].(map[string]any)
	if !ok {
		t.Fatalf("expected serverInfo object, got %T", response["serverInfo"])
	}
	if serverInfo["name"] != "lime" {
		t.Fatalf("expected server name lime, got %v", serverInfo["name"])
	}
	if serverInfo["version"] != buildinfo.Version {
		t.Fatalf("expected build version %q, got %v", buildinfo.Version, serverInfo["version"])
	}
}
