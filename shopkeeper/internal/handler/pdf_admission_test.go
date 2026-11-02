package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
	"github.com/sumanbasuli/lime/shopkeeper/internal/reporter"
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

func TestPDFPreflightRejectsBeforeDatabaseAtTen(t *testing.T) {
	entered := make(chan struct{}, 11)
	unblockPolicy := make(chan struct{})
	var unblockOnce sync.Once
	unblock := func() { unblockOnce.Do(func() { close(unblockPolicy) }) }
	t.Cleanup(unblock)
	var policyCalls, scanCalls, renderCalls atomic.Int32
	repo := pdfTestRepo(true, 10)
	repo.pdfPolicy = func(ctx context.Context) (*models.PDFReportPolicy, error) {
		policyCalls.Add(1)
		entered <- struct{}{}
		select {
		case <-unblockPolicy:
			return &models.PDFReportPolicy{Enabled: true, Concurrency: 10}, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	repo.getScan = func(context.Context, string) (*models.Scan, error) {
		scanCalls.Add(1)
		return &models.Scan{ID: "scan-123", SitemapURL: "https://example.test/", CreatedAt: time.Unix(0, 0)}, nil
	}
	h := New(repo, nil, fakePDFReporter{generate: func(context.Context) ([]byte, error) {
		renderCalls.Add(1)
		return []byte("%PDF-fixture"), nil
	}})
	finished := make(chan int, 10)
	for i := 0; i < 10; i++ {
		go func() {
			response := httptest.NewRecorder()
			h.DownloadIssueReport(response, pdfTestRequest())
			finished <- response.Code
		}()
	}
	for i := 0; i < 10; i++ {
		select {
		case <-entered:
		case <-time.After(2 * time.Second):
			t.Fatal("ten PDF policy reads did not start")
		}
	}

	overflow := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		response := httptest.NewRecorder()
		h.DownloadIssueReport(response, pdfTestRequest())
		overflow <- response
	}()
	select {
	case response := <-overflow:
		if response.Code != http.StatusServiceUnavailable || response.Header().Get("Retry-After") != "1" {
			t.Fatalf("preflight overflow: status=%d retry=%q", response.Code, response.Header().Get("Retry-After"))
		}
	case <-time.After(2 * time.Second):
		t.Fatal("eleventh PDF request reached blocked database preflight")
	}
	if policyCalls.Load() != 10 || scanCalls.Load() != 0 || renderCalls.Load() != 0 {
		t.Fatalf("overflow reached work: policy=%d scan=%d render=%d", policyCalls.Load(), scanCalls.Load(), renderCalls.Load())
	}

	unblock()
	for i := 0; i < 10; i++ {
		select {
		case status := <-finished:
			if status != http.StatusOK {
				t.Fatalf("admitted PDF status=%d", status)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("admitted PDF did not finish")
		}
	}
	after := httptest.NewRecorder()
	h.DownloadIssueReport(after, pdfTestRequest())
	if after.Code != http.StatusOK || policyCalls.Load() != 11 || renderCalls.Load() != 11 {
		t.Fatalf("preflight did not recover: status=%d policy=%d render=%d", after.Code, policyCalls.Load(), renderCalls.Load())
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

func TestPDFSlowClientRetainsBufferPermit(t *testing.T) {
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
	if second.Code != http.StatusServiceUnavailable || calls.Load() != 1 {
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
		t.Fatalf("PDF permits after slow response = %d, want 0", active)
	}
	third := httptest.NewRecorder()
	h.DownloadIssueReport(third, pdfTestRequest())
	if third.Code != http.StatusOK || calls.Load() != 2 || third.Header().Get("Content-Length") != "12" {
		t.Fatalf("PDF after slow response: status=%d calls=%d length=%q", third.Code, calls.Load(), third.Header().Get("Content-Length"))
	}
}

func TestPDFOversizedResponseRejectedBeforeHeaders(t *testing.T) {
	h := New(pdfTestRepo(true, 1), nil, fakePDFReporter{
		generate: func(context.Context) ([]byte, error) {
			return make([]byte, maxPDFResponseBytes+1), nil
		},
	})
	response := httptest.NewRecorder()
	h.DownloadIssueReport(response, pdfTestRequest())
	if response.Code != http.StatusRequestEntityTooLarge || response.Header().Get("Content-Type") == "application/pdf" || response.Body.Len() > 512 {
		t.Fatalf("oversized PDF response was not rejected cleanly: status=%d content-type=%q bytes=%d", response.Code, response.Header().Get("Content-Type"), response.Body.Len())
	}
	h.pdfLimiter.mu.Lock()
	active := h.pdfLimiter.active
	h.pdfLimiter.mu.Unlock()
	if active != 0 {
		t.Fatalf("oversized PDF retained permit: %d", active)
	}
}

func TestPDFStreamSizeLimitRejectedBeforeHeaders(t *testing.T) {
	h := New(pdfTestRepo(true, 1), nil, fakePDFReporter{
		generate: func(context.Context) ([]byte, error) {
			return nil, reporter.ErrPDFTooLarge
		},
	})
	response := httptest.NewRecorder()
	h.DownloadIssueReport(response, pdfTestRequest())
	if response.Code != http.StatusRequestEntityTooLarge || response.Header().Get("Content-Type") == "application/pdf" {
		t.Fatalf("reporter size limit response: status=%d content-type=%q", response.Code, response.Header().Get("Content-Type"))
	}
	var body map[string]string
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["csv_url"] != "/api/scans/scan-123/issues/report.csv?mode=full" {
		t.Fatalf("reporter size limit CSV URL = %q", body["csv_url"])
	}
}

func TestPDFHTMLSizeLimitReturnsFullCSVAndReleasesPermit(t *testing.T) {
	var calls atomic.Int32
	h := New(pdfTestRepo(true, 1), nil, fakePDFReporter{
		generate: func(context.Context) ([]byte, error) {
			if calls.Add(1) <= 2 {
				return nil, fmt.Errorf("report navigation: %w", reporter.ErrReportTooLarge)
			}
			return []byte("%PDF-fixture"), nil
		},
	})
	for _, test := range []struct {
		name, path, wantCSV string
	}{
		{"full", "/api/scans/scan-123/issues/report.pdf", "/api/scans/scan-123/issues/report.csv?mode=full"},
		{"scoped", "/api/scans/scan-123/issues/report.pdf?kind=needs_review&key=rule%2F%26", "/api/scans/scan-123/issues/report.csv?key=rule%2F%26&kind=needs_review&mode=full"},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			req := withScanID(httptest.NewRequest(http.MethodGet, test.path, nil), "scan-123")
			h.DownloadIssueReport(response, req)
			if response.Code != http.StatusRequestEntityTooLarge || response.Header().Get("Content-Type") == "application/pdf" {
				t.Fatalf("size response: status=%d content-type=%q", response.Code, response.Header().Get("Content-Type"))
			}
			var body map[string]string
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if body["csv_url"] != test.wantCSV || body["error"] == "" {
				t.Fatalf("size response body = %#v", body)
			}
			h.pdfLimiter.mu.Lock()
			active := h.pdfLimiter.active
			h.pdfLimiter.mu.Unlock()
			if active != 0 {
				t.Fatalf("PDF limit retained %d permits", active)
			}
		})
	}
	after := httptest.NewRecorder()
	h.DownloadIssueReport(after, pdfTestRequest())
	if after.Code != http.StatusOK || calls.Load() != 3 {
		t.Fatalf("normal PDF after size errors: status=%d calls=%d", after.Code, calls.Load())
	}
}

func TestPDFHTMLReportBusyReturnsRetryAndReleasesPermit(t *testing.T) {
	repo := pdfTestRepo(true, 1)
	policyCalls := 0
	scanCalls := 0
	repo.pdfPolicy = func(context.Context) (*models.PDFReportPolicy, error) {
		policyCalls++
		return &models.PDFReportPolicy{Enabled: true, Concurrency: 1}, nil
	}
	repo.getScan = func(_ context.Context, id string) (*models.Scan, error) {
		scanCalls++
		if id != "scan-123" {
			t.Fatalf("scan lookup ID = %q", id)
		}
		return &models.Scan{ID: id, SitemapURL: "https://example.test/", CreatedAt: time.Unix(0, 0)}, nil
	}
	generateCalls := 0
	h := New(repo, nil, fakePDFReporter{generate: func(context.Context) ([]byte, error) {
		generateCalls++
		if generateCalls == 1 {
			return nil, fmt.Errorf("report navigation: %w", reporter.ErrReportBusy)
		}
		return []byte("%PDF-fixture"), nil
	}})

	busy := httptest.NewRecorder()
	h.DownloadIssueReport(busy, pdfTestRequest())
	if busy.Code != http.StatusServiceUnavailable || busy.Header().Get("Retry-After") != "1" {
		t.Fatalf("HTML report busy: status=%d retry=%q", busy.Code, busy.Header().Get("Retry-After"))
	}
	if busy.Header().Get("Content-Type") == "application/pdf" || busy.Header().Get("Content-Disposition") != "" {
		t.Fatalf("HTML report busy exposed PDF headers: %v", busy.Header())
	}
	var body map[string]string
	if err := json.Unmarshal(busy.Body.Bytes(), &body); err != nil || body["error"] != "HTML report generation is busy; retry shortly" {
		t.Fatalf("HTML report busy body=%q, decode error=%v", busy.Body.String(), err)
	}
	if policyCalls != 1 || scanCalls != 1 || generateCalls != 1 {
		t.Fatalf("HTML report busy calls: policy=%d scan=%d renderer=%d", policyCalls, scanCalls, generateCalls)
	}

	after := httptest.NewRecorder()
	h.DownloadIssueReport(after, pdfTestRequest())
	if after.Code != http.StatusOK || after.Body.String() != "%PDF-fixture" || generateCalls != 2 {
		t.Fatalf("PDF after HTML busy: status=%d body=%q renderer calls=%d", after.Code, after.Body.String(), generateCalls)
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
