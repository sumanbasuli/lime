package mcp

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/sumanbasuli/lime/shopkeeper/internal/buildinfo"
	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
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

func TestScanAndIssueMCPResponsesRedactURLSecrets(t *testing.T) {
	const raw = "https://alice:s%40cret@example.test/page?owner=a@b"
	const public = "https://example.test/page"
	repo := newStubRepository()
	repo.scan.SitemapURL = raw
	repo.detail.Occurrences = []models.IssueOccurrence{{PageURL: raw}}
	server := New(repo)
	for _, tc := range []struct{ name, arguments string }{
		{"list_scans", `{}`},
		{"get_scan", `{"scan_id":"` + testScanID + `"}`},
		{"get_issue_detail", `{"scan_id":"` + testScanID + `","kind":"failed","key":"` + testIssueID + `"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			result := callAction(t, server, tc.name, tc.arguments)
			if result["isError"] == true {
				t.Fatal("MCP read failed", result)
			}
			structured, err := json.Marshal(result["structuredContent"])
			if err != nil {
				t.Fatal(err)
			}
			for _, value := range []string{string(structured), resultText(result)} {
				if strings.Contains(value, "alice") || strings.Contains(value, "s%40cret") || !strings.Contains(value, public) {
					t.Fatalf("unsafe MCP response: %s", value)
				}
			}
		})
	}
	if repo.scan.SitemapURL != raw || repo.detail.Occurrences[0].PageURL != raw {
		t.Fatal("MCP read mutated persisted models")
	}
}

type urlSummaryRepo struct {
	*stubRepository
	raw string
}

func (r *urlSummaryRepo) GetMCPIssueSummaries(context.Context, string, int, int) ([]models.MCPIssueSummary, int, error) {
	return []models.MCPIssueSummary{{Kind: "failed", Key: testIssueID, HelpURL: &r.raw}}, 1, nil
}

func TestMCPIssueSummariesHideSavedHelpURLQueries(t *testing.T) {
	const raw = "https://docs.test/rule?token=QUERY_TOKEN_CANARY"
	repo := &urlSummaryRepo{stubRepository: newStubRepository(), raw: raw}
	repo.detail.Summary.HelpURL = &repo.raw
	server := New(repo)
	for _, tc := range []struct{ name, args string }{
		{"list_scan_issues", `{"scan_id":"` + testScanID + `"}`},
		{"get_issue_detail", `{"scan_id":"` + testScanID + `","kind":"failed","key":"` + testIssueID + `"}`},
	} {
		result := callAction(t, server, tc.name, tc.args)
		if result["isError"] == true {
			t.Fatal("MCP issue read failed", result)
		}
		structured, err := json.Marshal(result["structuredContent"])
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(structured), "QUERY_TOKEN_CANARY") || !strings.Contains(string(structured), "https://docs.test/rule") {
			t.Fatalf("issue help URL was not projected: %s", structured)
		}
	}
	if repo.raw != raw || *repo.detail.Summary.HelpURL != raw {
		t.Fatal("MCP issue read changed saved help URL")
	}
}
