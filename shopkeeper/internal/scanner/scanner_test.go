package scanner

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/sumanbasuli/lime/shopkeeper/internal/juicer"
	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
)

func TestPersistURLStatusesStopsOnFirstWriteFailure(t *testing.T) {
	failure := errors.New("database write failed")
	results := []juicer.RawResult{
		{URLID: "url-1"},
		{URLID: "url-2", Error: "navigation failed"},
		{URLID: "url-3"},
	}
	var calls []string
	err := persistURLStatuses(context.Background(), results, func(_ context.Context, urlID, status string) error {
		calls = append(calls, urlID+"="+status)
		if urlID == "url-2" {
			return failure
		}
		return nil
	})
	if !errors.Is(err, failure) {
		t.Fatalf("expected URL status write failure, got %v", err)
	}
	if want := []string{"url-1=completed", "url-2=failed"}; !slices.Equal(calls, want) {
		t.Fatalf("status writes = %v, want %v", calls, want)
	}
}

func TestPersistURLStatusesKeepsSuccessfulPageStatusMapping(t *testing.T) {
	var calls []string
	err := persistURLStatuses(context.Background(), []juicer.RawResult{
		{URLID: "url-1"},
		{URLID: "url-2", Error: "navigation failed"},
	}, func(_ context.Context, urlID, status string) error {
		calls = append(calls, urlID+"="+status)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"url-1=completed", "url-2=failed"}; !slices.Equal(calls, want) {
		t.Fatalf("status writes = %v, want %v", calls, want)
	}
}

func TestCheckpointPageResultCommitsEvidenceBeforeTerminalStatus(t *testing.T) {
	var calls []string
	result := juicer.RawResult{URLID: "url-1"}
	err := checkpointPageResult(context.Background(), result,
		func(context.Context, juicer.RawResult) error {
			calls = append(calls, "evidence")
			return nil
		},
		func(_ context.Context, id, status string) error {
			calls = append(calls, id+"="+status)
			return nil
		})
	if err != nil || !slices.Equal(calls, []string{"evidence", "url-1=completed"}) {
		t.Fatalf("checkpoint = %v, calls = %v", err, calls)
	}
}

func TestCheckpointPageResultDoesNotCompleteAfterEvidenceFailure(t *testing.T) {
	failure := errors.New("incomplete evidence")
	statusWritten := false
	err := checkpointPageResult(context.Background(), juicer.RawResult{URLID: "url-1"},
		func(context.Context, juicer.RawResult) error { return failure },
		func(context.Context, string, string) error {
			statusWritten = true
			return nil
		})
	if !errors.Is(err, failure) || statusWritten {
		t.Fatalf("incomplete page became terminal: err=%v, statusWritten=%v", err, statusWritten)
	}
}

func TestCheckpointPageResultFailedPageSkipsEvidence(t *testing.T) {
	called := false
	err := checkpointPageResult(context.Background(), juicer.RawResult{URLID: "url-1", Error: "navigation failed"},
		func(context.Context, juicer.RawResult) error {
			called = true
			return nil
		},
		func(_ context.Context, _, status string) error {
			if status != "failed" {
				t.Fatalf("status = %s", status)
			}
			return nil
		})
	if err != nil || called {
		t.Fatalf("failed page checkpoint: err=%v, evidenceCalled=%v", err, called)
	}
}

func TestScanSliceDeadlineDoesNotSwallowCheckpointTimeout(t *testing.T) {
	runCtx := context.Background()
	sliceCtx, cancel := context.WithDeadline(runCtx, time.Now().Add(-time.Second))
	defer cancel()
	if !isScanSliceDeadline(context.DeadlineExceeded, sliceCtx, runCtx) {
		t.Fatal("expired slice was not recognized")
	}
	checkpointTimeout := errors.Join(juicer.ErrResultCheckpoint, context.DeadlineExceeded)
	if isScanSliceDeadline(checkpointTimeout, sliceCtx, runCtx) {
		t.Fatal("checkpoint timeout was mistaken for a normal slice expiry")
	}
}

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
