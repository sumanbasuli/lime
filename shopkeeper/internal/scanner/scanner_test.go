package scanner

import (
	"testing"

	"github.com/sumanbasuli/lime/shopkeeper/internal/juicer"
)

func TestSummarizePageResultsCountsSuccessesAndFailures(t *testing.T) {
	successfulPages, failedPages := summarizePageResults([]juicer.RawResult{
		{URLID: "1", URL: "https://example.com/a"},
		{URLID: "2", URL: "https://example.com/b", Error: "context deadline exceeded"},
		{URLID: "3", URL: "https://example.com/c"},
	})

	if successfulPages != 2 {
		t.Fatalf("expected 2 successful pages, got %d", successfulPages)
	}
	if failedPages != 1 {
		t.Fatalf("expected 1 failed page, got %d", failedPages)
	}
}

func TestSummarizePageResultsTreatsAllErroredPagesAsFailures(t *testing.T) {
	successfulPages, failedPages := summarizePageResults([]juicer.RawResult{
		{URLID: "1", URL: "https://example.com/a", Error: "navigation failed"},
		{URLID: "2", URL: "https://example.com/b", Error: "page did not settle"},
	})

	if successfulPages != 0 {
		t.Fatalf("expected no successful pages, got %d", successfulPages)
	}
	if failedPages != 2 {
		t.Fatalf("expected 2 failed pages, got %d", failedPages)
	}
}
