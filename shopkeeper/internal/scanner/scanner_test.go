package scanner

import (
	"testing"

	"github.com/sumanbasuli/lime/shopkeeper/internal/juicer"
	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
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

func TestSummarizePersistedURLStatusesCountsCompletedAndFailedOnly(t *testing.T) {
	completedPages, failedPages := summarizePersistedURLStatuses([]models.URL{
		{ID: "1", URL: "https://example.com/a", Status: "completed"},
		{ID: "2", URL: "https://example.com/b", Status: "failed"},
		{ID: "3", URL: "https://example.com/c", Status: "pending"},
		{ID: "4", URL: "https://example.com/d", Status: "scanning"},
	})

	if completedPages != 1 {
		t.Fatalf("expected 1 completed page, got %d", completedPages)
	}
	if failedPages != 1 {
		t.Fatalf("expected 1 failed page, got %d", failedPages)
	}
}

func TestBuildPendingPagesIncludesPendingAndScanningURLs(t *testing.T) {
	pages := buildPendingPages([]models.URL{
		{ID: "1", URL: "https://example.com/a", Status: "completed"},
		{ID: "2", URL: "https://example.com/b", Status: "pending"},
		{ID: "3", URL: "https://example.com/c", Status: "failed"},
		{ID: "4", URL: "https://example.com/d", Status: "scanning"},
	})

	if len(pages) != 2 {
		t.Fatalf("expected 2 pending pages, got %d", len(pages))
	}
	if pages[0].URLID != "2" || pages[0].URL != "https://example.com/b" {
		t.Fatalf("unexpected first pending page: %#v", pages[0])
	}
	if pages[1].URLID != "4" || pages[1].URL != "https://example.com/d" {
		t.Fatalf("unexpected second pending page: %#v", pages[1])
	}
}

func TestRetryFailedPagesResumeOnlyRequeuedFailures(t *testing.T) {
	urls := []models.URL{
		{ID: "1", URL: "https://example.com/completed-a", Status: "completed"},
		{ID: "2", URL: "https://example.com/retry-a", Status: "pending"},
		{ID: "3", URL: "https://example.com/retry-b", Status: "pending"},
		{ID: "4", URL: "https://example.com/completed-b", Status: "completed"},
	}

	completedPages, failedPages := summarizePersistedURLStatuses(urls)
	if completedPages != 2 {
		t.Fatalf("expected 2 completed pages before retry run, got %d", completedPages)
	}
	if failedPages != 0 {
		t.Fatalf("expected 0 failed pages after requeue, got %d", failedPages)
	}

	pages := buildPendingPages(urls)
	if len(pages) != 2 {
		t.Fatalf("expected 2 requeued failed pages to be pending, got %d", len(pages))
	}
	if pages[0].URLID != "2" || pages[1].URLID != "3" {
		t.Fatalf("expected only requeued failed URLs to remain pending, got %#v", pages)
	}
}
