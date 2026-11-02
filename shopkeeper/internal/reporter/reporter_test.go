package reporter

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/chromedp/cdproto/cdp"
	cdpio "github.com/chromedp/cdproto/io"
	cdppage "github.com/chromedp/cdproto/page"
	"github.com/chromedp/chromedp"
)

type pdfExecutorFunc func(context.Context, string, any, any) error

func (f pdfExecutorFunc) Execute(ctx context.Context, method string, params, result any) error {
	return f(ctx, method, params, result)
}

func TestPrintPDFBoundedReadsMixedStreamChunksAndClosesHandle(t *testing.T) {
	want := append([]byte("%PDF-"), 0, 255, 'X')
	readCount := 0
	closeCount := 0
	ctx := cdp.WithExecutor(context.Background(), pdfExecutorFunc(func(_ context.Context, method string, params, result any) error {
		switch method {
		case cdppage.CommandPrintToPDF:
			options := params.(*cdppage.PrintToPDFParams)
			if options.TransferMode != cdppage.PrintToPDFTransferModeReturnAsStream || !options.PrintBackground || !options.PreferCSSPageSize || options.DisplayHeaderFooter {
				t.Errorf("print options changed: %+v", options)
			}
			*result.(*cdppage.PrintToPDFReturns) = cdppage.PrintToPDFReturns{Stream: "pdf-stream"}
		case cdpio.CommandRead:
			if params.(*cdpio.ReadParams).Handle != "pdf-stream" {
				t.Error("read used the wrong PDF stream")
			}
			readCount++
			if readCount == 1 {
				*result.(*cdpio.ReadReturns) = cdpio.ReadReturns{Data: "%PDF-"}
			} else {
				*result.(*cdpio.ReadReturns) = cdpio.ReadReturns{
					Base64encoded: true,
					Data:          base64.StdEncoding.EncodeToString([]byte{0, 255, 'X'}),
					EOF:           true,
				}
			}
		case cdpio.CommandClose:
			if params.(*cdpio.CloseParams).Handle != "pdf-stream" {
				t.Error("close used the wrong PDF stream")
			}
			closeCount++
		default:
			return fmt.Errorf("unexpected CDP method %s", method)
		}
		return nil
	}))

	got, err := printPDFBounded(ctx)
	if err != nil || !bytes.Equal(got, want) || readCount != 2 || closeCount != 1 {
		t.Fatalf("streamed PDF = %q, err=%v, reads=%d, closes=%d", got, err, readCount, closeCount)
	}
}

func TestReadPDFBoundedAcceptsExactLimitAndRejectsNextByte(t *testing.T) {
	for _, test := range []struct {
		name    string
		second  cdpio.ReadReturns
		wantErr error
	}{
		{name: "exact limit", second: cdpio.ReadReturns{EOF: true}},
		{name: "raw overflow", second: cdpio.ReadReturns{Data: "6", EOF: true}, wantErr: ErrPDFTooLarge},
		{name: "base64 overflow", second: cdpio.ReadReturns{Base64encoded: true, Data: base64.StdEncoding.EncodeToString([]byte("6")), EOF: true}, wantErr: ErrPDFTooLarge},
	} {
		t.Run(test.name, func(t *testing.T) {
			reads := 0
			ctx := cdp.WithExecutor(context.Background(), pdfExecutorFunc(func(_ context.Context, method string, params, result any) error {
				if method != cdpio.CommandRead {
					return fmt.Errorf("unexpected CDP method %s", method)
				}
				reads++
				if reads == 1 {
					*result.(*cdpio.ReadReturns) = cdpio.ReadReturns{Data: "12345"}
				} else {
					if params.(*cdpio.ReadParams).Size != 1 {
						t.Errorf("overflow probe size = %d, want 1", params.(*cdpio.ReadParams).Size)
					}
					*result.(*cdpio.ReadReturns) = test.second
				}
				return nil
			}))
			got, err := readPDFBounded(ctx, "pdf-stream", 5)
			if !errors.Is(err, test.wantErr) {
				t.Fatalf("read error = %v, want %v", err, test.wantErr)
			}
			if test.wantErr == nil && string(got) != "12345" {
				t.Fatalf("exact-limit PDF = %q", got)
			}
		})
	}
}

func TestPrintPDFBoundedRejectsMissingStreamWithoutBase64Fallback(t *testing.T) {
	ctx := cdp.WithExecutor(context.Background(), pdfExecutorFunc(func(_ context.Context, method string, _ any, result any) error {
		if method != cdppage.CommandPrintToPDF {
			return fmt.Errorf("unexpected CDP method %s", method)
		}
		*result.(*cdppage.PrintToPDFReturns) = cdppage.PrintToPDFReturns{Data: "JVBERi0="}
		return nil
	}))
	if _, err := printPDFBounded(ctx); err == nil || !strings.Contains(err.Error(), "did not provide a PDF stream") {
		t.Fatalf("missing-stream error = %v", err)
	}
}

func TestPrintPDFBoundedClosesStreamAfterCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	closeCount := 0
	ctx = cdp.WithExecutor(ctx, pdfExecutorFunc(func(callCtx context.Context, method string, _ any, result any) error {
		switch method {
		case cdppage.CommandPrintToPDF:
			*result.(*cdppage.PrintToPDFReturns) = cdppage.PrintToPDFReturns{Stream: "pdf-stream"}
		case cdpio.CommandRead:
			cancel()
			return context.Canceled
		case cdpio.CommandClose:
			if callCtx.Err() != nil {
				t.Errorf("cleanup context was cancelled: %v", callCtx.Err())
			}
			closeCount++
		default:
			return fmt.Errorf("unexpected CDP method %s", method)
		}
		return nil
	}))
	_, err := printPDFBounded(ctx)
	if !errors.Is(err, context.Canceled) || closeCount != 1 {
		t.Fatalf("cancelled read error = %v, closes=%d", err, closeCount)
	}
}

func TestReporterChromeStreamFixture(t *testing.T) {
	chrome := os.Getenv("LIME_REPORTER_CHROME_BIN")
	if chrome == "" {
		t.Skip("set LIME_REPORTER_CHROME_BIN to run the local Chromium stream fixture")
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/reports/scans/scan-123/issues" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(`<html><head><title>PDF stream fixture</title></head><body><main data-report-ready="true"><h1>PDF stream fixture</h1><p>Normal report content.</p></main></body></html>`))
	}))
	defer server.Close()

	opts := append([]chromedp.ExecAllocatorOption{}, chromedp.DefaultExecAllocatorOptions[:]...)
	opts = append(opts, chromedp.ExecPath(chrome), chromedp.Flag("no-sandbox", false))
	allocCtx, allocCancel := chromedp.NewExecAllocator(context.Background(), opts...)
	defer allocCancel()
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	pdf, err := New(allocCtx, server.URL).GenerateIssueReportPDF(ctx, "scan-123", "", "")
	if err != nil {
		t.Fatalf("Chrome PDF stream fixture: %v", err)
	}
	if !bytes.HasPrefix(pdf, []byte("%PDF-")) || !bytes.Contains(pdf, []byte("%%EOF")) {
		t.Fatalf("Chrome returned invalid PDF envelope: prefix=%q, size=%d", pdf[:min(len(pdf), 8)], len(pdf))
	}
}

func TestReporterChromeBusyHTMLFixture(t *testing.T) {
	chrome := os.Getenv("LIME_REPORTER_CHROME_BIN")
	if chrome == "" {
		t.Skip("set LIME_REPORTER_CHROME_BIN to run the local Chromium busy HTML fixture")
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/reports/scans/scan-123/issues" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`<html><body><main data-report-busy="true">Report generation is busy</main></body></html>`))
	}))
	defer server.Close()

	opts := append([]chromedp.ExecAllocatorOption{}, chromedp.DefaultExecAllocatorOptions[:]...)
	opts = append(opts, chromedp.ExecPath(chrome), chromedp.Flag("no-sandbox", false))
	allocCtx, allocCancel := chromedp.NewExecAllocator(context.Background(), opts...)
	defer allocCancel()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	started := time.Now()
	pdf, err := New(allocCtx, server.URL).GenerateIssueReportPDF(ctx, "scan-123", "", "")
	if !errors.Is(err, ErrReportBusy) || len(pdf) != 0 {
		t.Fatalf("Chrome busy HTML fixture: PDF size=%d, error=%v", len(pdf), err)
	}
	if elapsed := time.Since(started); elapsed > 10*time.Second {
		t.Fatalf("Chrome busy HTML fixture took %s, want under 10s", elapsed)
	}
}

func TestReportNavigationErrorShortCircuitsSizeMarker(t *testing.T) {
	if err := reportNavigationError(false, false); err != nil {
		t.Fatalf("normal report error = %v", err)
	}
	if err := reportNavigationError(false, true); !errors.Is(err, ErrReportTooLarge) {
		t.Fatalf("oversized report error = %v", err)
	}
	if err := reportNavigationError(true, false); !errors.Is(err, ErrReportBusy) {
		t.Fatalf("busy report error = %v", err)
	}
}

func TestReporterChromeTooLargeHTMLFixture(t *testing.T) {
	chrome := os.Getenv("LIME_REPORTER_CHROME_BIN")
	if chrome == "" {
		t.Skip("set LIME_REPORTER_CHROME_BIN to run the local Chromium size-marker fixture")
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusRequestEntityTooLarge)
		_, _ = w.Write([]byte(`<html><body><main data-report-too-large="true">Download the complete CSV export</main></body></html>`))
	}))
	defer server.Close()
	opts := append([]chromedp.ExecAllocatorOption{}, chromedp.DefaultExecAllocatorOptions[:]...)
	opts = append(opts, chromedp.ExecPath(chrome), chromedp.Flag("no-sandbox", false))
	allocCtx, allocCancel := chromedp.NewExecAllocator(context.Background(), opts...)
	defer allocCancel()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	started := time.Now()
	pdf, err := New(allocCtx, server.URL).GenerateIssueReportPDF(ctx, "scan-123", "", "")
	if !errors.Is(err, ErrReportTooLarge) || len(pdf) != 0 {
		t.Fatalf("oversized HTML fixture: PDF size=%d, error=%v", len(pdf), err)
	}
	if elapsed := time.Since(started); elapsed > 10*time.Second {
		t.Fatalf("oversized HTML fixture took %s, want under 10s", elapsed)
	}
}
