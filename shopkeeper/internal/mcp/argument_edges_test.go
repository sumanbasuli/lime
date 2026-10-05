package mcp

import (
	"context"
	"encoding/json"
	"testing"
)

func TestToolPaginationRejectsExactJSONFractions(t *testing.T) {
	for _, args := range []string{
		`{"limit":1.0000000000000000001}`,
		`{"limit":100.0000000000000000001}`,
		`{"offset":0.00000000000000000000000000000000000000000000000000000001}`,
		`{"offset":1e-400}`,
		`{"offset":1e-1000000000}`,
		`{"offset":1e1000000000}`,
	} {
		t.Run(args, func(t *testing.T) {
			repo := newStubRepository()
			result, rpcErr := New(repo).handleToolCall(context.Background(), json.RawMessage(`{"name":"list_scans","arguments":`+args+`}`))
			if rpcErr != nil || result.(map[string]any)["isError"] != true {
				t.Fatalf("exact fractional pagination must fail schema validation without a query: result=%v rpcError=%v dataReads=%d", result, rpcErr, repo.calls)
			}
			if repo.calls != 0 {
				t.Fatalf("invalid fraction triggered %d data reads", repo.calls)
			}
		})
	}
}

func TestToolPaginationAcceptsExactIntegers(t *testing.T) {
	for _, test := range []struct {
		args string
		want int
	}{
		{`{"limit":1.0}`, 1},
		{`{"limit":1e2}`, 100},
		{`{"limit":1.0000000000000000000}`, 1},
		{`{"offset":0e-1000000000}`, 20},
		{`{"offset":0e1000000000}`, 20},
	} {
		t.Run(test.args, func(t *testing.T) {
			repo := newStubRepository()
			result, rpcErr := New(repo).handleToolCall(context.Background(), json.RawMessage(`{"name":"list_scans","arguments":`+test.args+`}`))
			if rpcErr != nil || result.(map[string]any)["isError"] == true || repo.calls != 1 || repo.limit != test.want {
				t.Fatalf("exact integer pagination should retain its value: result=%v rpcError=%v dataReads=%d limit=%d", result, rpcErr, repo.calls, repo.limit)
			}
		})
	}
}

func TestToolCallRejectsExplicitNullArguments(t *testing.T) {
	repo := newStubRepository()
	result, rpcErr := New(repo).handleToolCall(context.Background(), json.RawMessage(`{"name":"get_settings","arguments":null}`))
	if rpcErr == nil || rpcErr.Code != -32602 || repo.calls != 0 {
		t.Fatalf("arguments must be an object when present: result=%v rpcError=%v dataReads=%d", result, rpcErr, repo.calls)
	}
}

func TestToolCallOptionalArgumentsRemainValid(t *testing.T) {
	for _, params := range []string{`{"name":"get_settings"}`, `{"name":"get_settings","arguments":{}}`} {
		repo := newStubRepository()
		result, rpcErr := New(repo).handleToolCall(context.Background(), json.RawMessage(params))
		if rpcErr != nil || result.(map[string]any)["isError"] == true || repo.calls != 1 {
			t.Fatalf("omitted or empty optional arguments must stay valid: result=%v rpcError=%v dataReads=%d", result, rpcErr, repo.calls)
		}
	}
}
