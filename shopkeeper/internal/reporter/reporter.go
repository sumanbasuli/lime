package reporter

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/chromedp/cdproto/cdp"
	cdpio "github.com/chromedp/cdproto/io"
	cdppage "github.com/chromedp/cdproto/page"
	"github.com/chromedp/cdproto/runtime"
	"github.com/chromedp/chromedp"
)

const (
	reportRenderTimeout = 4 * time.Minute
	assetWaitTimeout    = 6 * time.Second
	maxPDFResponseBytes = 64 << 20
	pdfReadChunkBytes   = 64 << 10
)

// ErrPDFTooLarge means Chromium generated more PDF data than a report download allows.
var ErrPDFTooLarge = errors.New("generated PDF exceeds the 64 MiB download limit")

// ErrReportBusy means the HTML report page rejected PDF navigation before
// loading report data. The caller may retry without waiting for render timeout.
var ErrReportBusy = errors.New("HTML report generation is busy")

// ErrReportTooLarge means the HTML page refused to materialize an oversized report.
var ErrReportTooLarge = errors.New("HTML report is too large to render safely")

// Reporter renders scan reports to PDF using the shared Chromium allocator.
type Reporter struct {
	allocCtx      context.Context
	baseReportURL string
}

// New creates a PDF reporter.
func New(allocCtx context.Context, baseReportURL string) *Reporter {
	return &Reporter{
		allocCtx:      allocCtx,
		baseReportURL: strings.TrimRight(baseReportURL, "/"),
	}
}

// GenerateIssueReportPDF renders the expanded issue report for a scan as a PDF.
func (r *Reporter) GenerateIssueReportPDF(ctx context.Context, scanID, kind, key string) ([]byte, error) {
	if r.baseReportURL == "" {
		return nil, fmt.Errorf("report base URL is not configured")
	}

	reportURL := fmt.Sprintf("%s/reports/scans/%s/issues", r.baseReportURL, url.PathEscape(scanID))
	if kind != "" && key != "" {
		query := url.Values{}
		query.Set("kind", kind)
		query.Set("key", key)
		reportURL = fmt.Sprintf("%s?%s", reportURL, query.Encode())
	}
	browserCtx, browserCancel := chromedp.NewContext(r.allocCtx)
	defer browserCancel()

	tabCtx, timeoutCancel := context.WithTimeout(browserCtx, reportRenderTimeout)
	defer timeoutCancel()

	go func() {
		select {
		case <-ctx.Done():
			browserCancel()
		case <-tabCtx.Done():
		}
	}()

	var pdf []byte
	var imagesReady bool
	var reportBusy bool
	var reportTooLarge bool

	if err := chromedp.Run(tabCtx,
		chromedp.Navigate(reportURL),
		chromedp.WaitReady(`[data-report-ready="true"], [data-report-busy="true"], [data-report-too-large="true"]`),
		chromedp.Evaluate(`document.querySelector('[data-report-busy="true"]') !== null`, &reportBusy),
		chromedp.Evaluate(`document.querySelector('[data-report-too-large="true"]') !== null`, &reportTooLarge),
		chromedp.ActionFunc(func(context.Context) error {
			return reportNavigationError(reportBusy, reportTooLarge)
		}),
		chromedp.Evaluate(
			waitForReportAssetsScript(assetWaitTimeout),
			&imagesReady,
			func(p *runtime.EvaluateParams) *runtime.EvaluateParams {
				return p.WithAwaitPromise(true)
			},
		),
		chromedp.ActionFunc(func(ctx context.Context) error {
			data, err := printPDFBounded(ctx)
			if err != nil {
				return err
			}

			pdf = data
			return nil
		}),
	); err != nil {
		return nil, fmt.Errorf("failed to render issue report PDF: %w", err)
	}

	if len(pdf) == 0 {
		return nil, fmt.Errorf("issue report PDF was empty")
	}

	return pdf, nil
}

func reportNavigationError(busy, tooLarge bool) error {
	if busy {
		return ErrReportBusy
	}
	if tooLarge {
		return ErrReportTooLarge
	}
	return nil
}

func printPDFBounded(ctx context.Context) ([]byte, error) {
	params := cdppage.PrintToPDF().
		WithPrintBackground(true).
		WithPreferCSSPageSize(true).
		WithDisplayHeaderFooter(false).
		WithTransferMode(cdppage.PrintToPDFTransferModeReturnAsStream)
	var result cdppage.PrintToPDFReturns
	if err := cdp.Execute(ctx, cdppage.CommandPrintToPDF, params, &result); err != nil {
		return nil, err
	}
	if result.Stream == "" {
		// Falling back to ReturnAsBase64 could allocate an unbounded PDF before
		// the size check; fail closed when Chromium cannot return a stream.
		return nil, errors.New("Chromium did not provide a PDF stream")
	}
	defer func() {
		closeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Second)
		defer cancel()
		_ = cdpio.Close(result.Stream).Do(closeCtx)
	}()
	return readPDFBounded(ctx, result.Stream, maxPDFResponseBytes)
}

func readPDFBounded(ctx context.Context, stream cdpio.StreamHandle, limit int) ([]byte, error) {
	var pdf []byte
	for {
		remaining := limit - len(pdf)
		readSize := pdfReadChunkBytes
		if remaining < readSize {
			readSize = remaining + 1
		}
		var result cdpio.ReadReturns
		if err := cdp.Execute(ctx, cdpio.CommandRead, cdpio.Read(stream).WithSize(int64(readSize)), &result); err != nil {
			return nil, err
		}

		var chunk []byte
		if result.Base64encoded {
			// Check the encoded length before allocating a decoded chunk. The
			// upper bound can exceed the actual length by at most two bytes.
			if base64.StdEncoding.DecodedLen(len(result.Data)) > remaining+2 {
				return nil, ErrPDFTooLarge
			}
			var err error
			chunk, err = base64.StdEncoding.DecodeString(result.Data)
			if err != nil {
				return nil, fmt.Errorf("invalid base64 PDF stream chunk: %w", err)
			}
		} else {
			if len(result.Data) > remaining {
				return nil, ErrPDFTooLarge
			}
			chunk = []byte(result.Data)
		}
		if len(chunk) > remaining {
			return nil, ErrPDFTooLarge
		}
		if len(chunk) == 0 && !result.EOF {
			return nil, errors.New("Chromium PDF stream made no progress")
		}
		pdf = append(pdf, chunk...)
		if result.EOF {
			return pdf, nil
		}
	}
}

func waitForReportAssetsScript(timeout time.Duration) string {
	return fmt.Sprintf(`new Promise((resolve) => {
		const deadline = Date.now() + %d;
		function check() {
			const fontsReady = !document.fonts || document.fonts.status === "loaded";
			const imagesReady = Array.from(document.images || []).every((img) => img.complete);
			if (fontsReady && imagesReady) {
				resolve(true);
				return;
			}
			if (Date.now() >= deadline) {
				resolve(false);
				return;
			}
			setTimeout(check, 100);
		}
		check();
	})`, timeout.Milliseconds())
}
