package handler

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
)

type fakePDFReporter struct {
	generate func(context.Context) ([]byte, error)
}

type blockingPDFWriter struct {
	*httptest.ResponseRecorder
	entered chan struct{}
	release chan struct{}
}

func (w *blockingPDFWriter) Write(bytes []byte) (int, error) {
	close(w.entered)
	<-w.release
	return w.ResponseRecorder.Write(bytes)
}

func (r fakePDFReporter) GenerateIssueReportPDF(ctx context.Context, _, _, _ string) ([]byte, error) {
	return r.generate(ctx)
}

func pdfTestRepo(enabled bool, concurrency int) stubRepo {
	return stubRepo{
		pdfPolicy: func(context.Context) (*models.PDFReportPolicy, error) {
			return &models.PDFReportPolicy{Enabled: enabled, Concurrency: concurrency}, nil
		},
		getScan: func(context.Context, string) (*models.Scan, error) {
			return &models.Scan{ID: "scan-123", SitemapURL: "https://example.test/", CreatedAt: time.Unix(0, 0)}, nil
		},
	}
}

func pdfTestRequest() *http.Request {
	return withScanID(httptest.NewRequest(http.MethodGet, "/api/scans/scan-123/issues/report.pdf", nil), "scan-123")
}

func TestPDFDisabledNeverStartsRenderer(t *testing.T) {
	var calls atomic.Int32
	h := New(pdfTestRepo(false, 1), nil, fakePDFReporter{
		generate: func(context.Context) ([]byte, error) {
			calls.Add(1)
			return []byte("%PDF-fixture"), nil
		},
	})
	response := httptest.NewRecorder()
	h.DownloadIssueReport(response, pdfTestRequest())
	if response.Code != http.StatusForbidden || calls.Load() != 0 {
		t.Fatalf("disabled PDF: status=%d renderer calls=%d", response.Code, calls.Load())
	}
}

func TestPDFBusyRejectsDirectRequestAndReleasesPermit(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	finished := make(chan int, 1)
	var calls atomic.Int32
	h := New(pdfTestRepo(true, 1), nil, fakePDFReporter{
		generate: func(context.Context) ([]byte, error) {
			if calls.Add(1) == 1 {
				close(started)
				<-release
			}
			return []byte("%PDF-fixture"), nil
		},
	})
	go func() {
		response := httptest.NewRecorder()
		h.DownloadIssueReport(response, pdfTestRequest())
		finished <- response.Code
	}()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("first PDF did not start")
	}

	busy := httptest.NewRecorder()
	h.DownloadIssueReport(busy, pdfTestRequest())
	if busy.Code != http.StatusServiceUnavailable || busy.Header().Get("Retry-After") != "1" || calls.Load() != 1 {
		t.Fatalf("busy PDF: status=%d retry=%q renderer calls=%d", busy.Code, busy.Header().Get("Retry-After"), calls.Load())
	}
	close(release)
	select {
	case status := <-finished:
		if status != http.StatusOK {
			t.Fatalf("first PDF status=%d", status)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("first PDF did not finish")
	}

	after := httptest.NewRecorder()
	h.DownloadIssueReport(after, pdfTestRequest())
	if after.Code != http.StatusOK || calls.Load() != 2 {
		t.Fatalf("PDF after release: status=%d renderer calls=%d", after.Code, calls.Load())
	}
}

func TestPDFCancelReleasesPermit(t *testing.T) {
	started := make(chan struct{})
	finished := make(chan struct{})
	var calls atomic.Int32
	h := New(pdfTestRepo(true, 1), nil, fakePDFReporter{
		generate: func(ctx context.Context) ([]byte, error) {
			if calls.Add(1) == 1 {
				close(started)
				<-ctx.Done()
				return nil, ctx.Err()
			}
			return []byte("%PDF-fixture"), nil
		},
	})
	request := pdfTestRequest()
	ctx, cancel := context.WithCancel(request.Context())
	request = request.WithContext(ctx)
	go func() {
		h.DownloadIssueReport(httptest.NewRecorder(), request)
		close(finished)
	}()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("PDF did not start")
	}
	cancel()
	select {
	case <-finished:
	case <-time.After(2 * time.Second):
		t.Fatal("cancelled PDF did not finish")
	}
	after := httptest.NewRecorder()
	h.DownloadIssueReport(after, pdfTestRequest())
	if after.Code != http.StatusOK || calls.Load() != 2 {
		t.Fatalf("PDF after cancellation: status=%d renderer calls=%d", after.Code, calls.Load())
	}
}

func TestPDFSlowClientDoesNotHoldRenderPermit(t *testing.T) {
	var calls atomic.Int32
	h := New(pdfTestRepo(true, 1), nil, fakePDFReporter{
		generate: func(context.Context) ([]byte, error) {
			calls.Add(1)
			return []byte("%PDF-fixture"), nil
		},
	})
	first := &blockingPDFWriter{
		ResponseRecorder: httptest.NewRecorder(),
		entered:          make(chan struct{}),
		release:          make(chan struct{}),
	}
	finished := make(chan struct{})
	go func() {
		h.DownloadIssueReport(first, pdfTestRequest())
		close(finished)
	}()
	select {
	case <-first.entered:
	case <-time.After(2 * time.Second):
		t.Fatal("first PDF did not reach response write")
	}

	second := httptest.NewRecorder()
	h.DownloadIssueReport(second, pdfTestRequest())
	if second.Code != http.StatusOK || calls.Load() != 2 {
		t.Fatalf("PDF during slow response: status=%d renderer calls=%d", second.Code, calls.Load())
	}
	close(first.release)
	select {
	case <-finished:
	case <-time.After(2 * time.Second):
		t.Fatal("first PDF did not finish")
	}
	h.pdfLimiter.mu.Lock()
	active := h.pdfLimiter.active
	h.pdfLimiter.mu.Unlock()
	if active != 0 {
		t.Fatalf("PDF render permits after both responses = %d, want 0", active)
	}
}

func TestPDFPolicyReadFailureDoesNotRender(t *testing.T) {
	var calls atomic.Int32
	repo := pdfTestRepo(true, 1)
	repo.pdfPolicy = func(context.Context) (*models.PDFReportPolicy, error) {
		return nil, errors.New("database unavailable")
	}
	h := New(repo, nil, fakePDFReporter{
		generate: func(context.Context) ([]byte, error) {
			calls.Add(1)
			return []byte("%PDF-fixture"), nil
		},
	})
	response := httptest.NewRecorder()
	h.DownloadIssueReport(response, pdfTestRequest())
	if response.Code != http.StatusServiceUnavailable || calls.Load() != 0 {
		t.Fatalf("missing policy: status=%d renderer calls=%d", response.Code, calls.Load())
	}
}
