package juicer

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"

	cdppage "github.com/chromedp/cdproto/page"
	"github.com/chromedp/cdproto/runtime"
	"github.com/chromedp/chromedp"
)

const (
	// MaxConcurrency is the maximum number of pages scanned simultaneously.
	MaxConcurrency = 5

	// PageTimeout is the maximum time allowed for scanning a single page.
	PageTimeout = 30 * time.Second

	// DelayBetweenRequests is the politeness delay between requests.
	DelayBetweenRequests = 500 * time.Millisecond

	// ScreenshotDir is the base directory for screenshots.
	ScreenshotDir = "/app/screenshots"
)

// PageInput represents a URL to scan with its DB record ID.
type PageInput struct {
	URLID string
	URL   string
}

// ProgressCallback is called after each page is scanned.
type ProgressCallback func(scannedCount int)

// ScanPages scans multiple pages for accessibility issues using chromedp and axe-core.
// It uses a worker pool with bounded concurrency (max 5 simultaneous pages).
func ScanPages(ctx context.Context, allocCtx context.Context, pages []PageInput, scanID string, onProgress ProgressCallback) ([]RawResult, error) {
	if len(pages) == 0 {
		return []RawResult{}, nil
	}

	// Create screenshot directory for this scan
	screenshotDir := filepath.Join(ScreenshotDir, scanID)
	if err := os.MkdirAll(screenshotDir, 0755); err != nil {
		log.Printf("Juicer: warning: could not create screenshot directory %s: %v", screenshotDir, err)
	}

	// Semaphore channel for limiting concurrency
	sem := make(chan struct{}, MaxConcurrency)
	var mu sync.Mutex
	var results []RawResult
	scannedCount := 0

	var wg sync.WaitGroup
	for _, page := range pages {
		// Check for cancellation
		select {
		case <-ctx.Done():
			return results, ctx.Err()
		default:
		}

		wg.Add(1)
		sem <- struct{}{} // Acquire semaphore

		go func(p PageInput) {
			defer wg.Done()
			defer func() { <-sem }() // Release semaphore

			result := scanSinglePage(ctx, allocCtx, p, scanID, screenshotDir)

			mu.Lock()
			results = append(results, result)
			scannedCount++
			count := scannedCount
			mu.Unlock()

			if onProgress != nil {
				onProgress(count)
			}

			// Politeness delay
			time.Sleep(DelayBetweenRequests)
		}(page)
	}

	wg.Wait()

	log.Printf("Juicer: scanned %d pages for scan %s", len(results), scanID)
	return results, nil
}

func scanSinglePage(ctx context.Context, allocCtx context.Context, page PageInput, scanID, screenshotDir string) RawResult {
	result := RawResult{
		URLID: page.URLID,
		URL:   page.URL,
	}

	// Create a new browser tab context with timeout
	tabCtx, cancel := chromedp.NewContext(allocCtx)
	defer cancel()

	tabCtx, cancel = context.WithTimeout(tabCtx, PageTimeout)
	defer cancel()

	var screenshot []byte

	// Navigate to the page
	err := chromedp.Run(tabCtx,
		chromedp.Navigate(page.URL),
		chromedp.WaitReady("body"),
	)
	if err != nil {
		result.Error = fmt.Sprintf("failed to navigate to %s: %v", page.URL, err)
		log.Printf("Juicer: %s", result.Error)
		return result
	}

	// Inject axe-core
	err = chromedp.Run(tabCtx,
		chromedp.Evaluate(axeMinJS, nil),
	)
	if err != nil {
		result.Error = fmt.Sprintf("failed to inject axe-core on %s: %v", page.URL, err)
		log.Printf("Juicer: %s", result.Error)
		return result
	}

	// Run axe-core and get results as a JSON string
	// Use WithAwaitPromise to properly handle the async axe.run() call
	var axeResultJSON string
	err = chromedp.Run(tabCtx,
		chromedp.Evaluate(`
			axe.run(document, {
				resultTypes: ['violations']
			}).then(results => {
				return JSON.stringify({violations: results.violations});
			})
		`, &axeResultJSON, func(ep *runtime.EvaluateParams) *runtime.EvaluateParams {
			return ep.WithAwaitPromise(true)
		}),
	)
	if err != nil {
		result.Error = fmt.Sprintf("failed to run axe-core on %s: %v", page.URL, err)
		log.Printf("Juicer: %s", result.Error)
		return result
	}

	// Parse axe results
	var axeRes axeResult
	if err := json.Unmarshal([]byte(axeResultJSON), &axeRes); err != nil {
		result.Error = fmt.Sprintf("failed to parse axe results for %s: %v", page.URL, err)
		log.Printf("Juicer: %s", result.Error)
		return result
	}
	result.Violations = axeRes.Violations

	// Wait for page images to finish loading before taking screenshots
	chromedp.Run(tabCtx,
		chromedp.Evaluate(`new Promise(r => {
			const imgs = Array.from(document.images);
			if (imgs.every(i => i.complete)) return r();
			let remaining = imgs.filter(i => !i.complete).length;
			if (remaining === 0) return r();
			imgs.filter(i => !i.complete).forEach(i => {
				i.onload = i.onerror = () => { remaining--; if (remaining <= 0) r(); };
			});
			setTimeout(r, 3000);
		})`, nil, func(ep *runtime.EvaluateParams) *runtime.EvaluateParams {
			return ep.WithAwaitPromise(true)
		}),
	)

	// Take element-level screenshots BEFORE the full-page screenshot
	// (FullScreenshot changes the viewport/device metrics and can break subsequent element screenshots)
	// Use CDP Page.CaptureScreenshot with clip for reliable element capture
	nodeIdx := 0
	for vi := range result.Violations {
		for ni := range result.Violations[vi].Nodes {
			node := &result.Violations[vi].Nodes[ni]
			if len(node.Target) == 0 {
				nodeIdx++
				continue
			}
			selector := node.Target[0]

			// Scroll element into view and get its viewport-relative bounds
			var bounds struct {
				X      float64 `json:"x"`
				Y      float64 `json:"y"`
				Width  float64 `json:"width"`
				Height float64 `json:"height"`
			}
			err := chromedp.Run(tabCtx,
				chromedp.Evaluate(fmt.Sprintf(`(() => {
					const el = document.querySelector(%q);
					if (!el) return null;
					el.scrollIntoView({block: 'center', behavior: 'instant'});
					const r = el.getBoundingClientRect();
					return {x: r.x, y: r.y, width: r.width, height: r.height};
				})()`, selector), &bounds),
			)
			if err != nil || bounds.Width == 0 || bounds.Height == 0 {
				if err != nil {
					log.Printf("Juicer: warning: failed to get bounds for %q: %v", selector, err)
				}
				nodeIdx++
				continue
			}

			// Capture screenshot clipped to the element's viewport bounds
			var elemScreenshot []byte
			err = chromedp.Run(tabCtx, chromedp.ActionFunc(func(ctx context.Context) error {
				data, err := cdppage.CaptureScreenshot().
					WithFormat(cdppage.CaptureScreenshotFormatPng).
					WithClip(&cdppage.Viewport{
						X:      bounds.X,
						Y:      bounds.Y,
						Width:  bounds.Width,
						Height: bounds.Height,
						Scale:  2,
					}).
					Do(ctx)
				if err != nil {
					return err
				}
				elemScreenshot = data
				return nil
			}))
			if err != nil {
				log.Printf("Juicer: warning: failed to screenshot element %q on %s: %v", selector, page.URL, err)
				nodeIdx++
				continue
			}
			if len(elemScreenshot) > 0 {
				elemPath := filepath.Join(screenshotDir, fmt.Sprintf("%s_elem_%d.png", page.URLID, nodeIdx))
				if err := os.WriteFile(elemPath, elemScreenshot, 0644); err != nil {
					log.Printf("Juicer: warning: failed to save element screenshot: %v", err)
				} else {
					node.ElementScreenshotPath = elemPath
				}
			}
			nodeIdx++
		}
	}

	// Take a full-page screenshot (last, since it alters viewport metrics)
	err = chromedp.Run(tabCtx,
		chromedp.FullScreenshot(&screenshot, 80),
	)
	if err != nil {
		log.Printf("Juicer: warning: failed to take screenshot of %s: %v", page.URL, err)
	} else if len(screenshot) > 0 {
		screenshotPath := filepath.Join(screenshotDir, page.URLID+".png")
		if err := os.WriteFile(screenshotPath, screenshot, 0644); err != nil {
			log.Printf("Juicer: warning: failed to save screenshot for %s: %v", page.URL, err)
		} else {
			result.ScreenshotPath = screenshotPath
		}
	}

	log.Printf("Juicer: scanned %s — %d violations found", page.URL, len(result.Violations))
	return result
}
