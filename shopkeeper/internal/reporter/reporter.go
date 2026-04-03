package reporter

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"time"

	cdppage "github.com/chromedp/cdproto/page"
	"github.com/chromedp/cdproto/runtime"
	"github.com/chromedp/chromedp"
)

const (
	reportRenderTimeout = 4 * time.Minute
	assetWaitTimeout    = 20 * time.Second
)

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
func (r *Reporter) GenerateIssueReportPDF(ctx context.Context, scanID string) ([]byte, error) {
	if r.baseReportURL == "" {
		return nil, fmt.Errorf("report base URL is not configured")
	}

	reportURL := fmt.Sprintf("%s/reports/scans/%s/issues", r.baseReportURL, url.PathEscape(scanID))
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

	if err := chromedp.Run(tabCtx,
		chromedp.Navigate(reportURL),
		chromedp.WaitReady(`[data-report-ready="true"]`),
		chromedp.Evaluate(
			waitForReportAssetsScript(assetWaitTimeout),
			&imagesReady,
			func(p *runtime.EvaluateParams) *runtime.EvaluateParams {
				return p.WithAwaitPromise(true)
			},
		),
		chromedp.ActionFunc(func(ctx context.Context) error {
			data, _, err := cdppage.PrintToPDF().
				WithPrintBackground(true).
				WithPreferCSSPageSize(true).
				WithDisplayHeaderFooter(false).
				Do(ctx)
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
