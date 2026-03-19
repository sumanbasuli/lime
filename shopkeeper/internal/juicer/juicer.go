package juicer

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image/png"
	"log"
	"math"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/campuspress/lime/shopkeeper/internal/viewport"
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

	pageSettleTimeout            = 5 * time.Second
	postLoadSettleDelay          = 350 * time.Millisecond
	elementScreenshotPadding     = 12.0
	elementContextPadding        = 36.0
	elementScreenshotMinWidth    = 96.0
	elementScreenshotMinHeight   = 64.0
	elementContextMinWidth       = 280.0
	elementContextMinHeight      = 180.0
	elementScreenshotMinByteSize = 128
	elementScreenshotScale       = 2.0
)

// PageInput represents a URL to scan with its DB record ID.
type PageInput struct {
	URLID string
	URL   string
}

// ProgressCallback is called after each page is scanned.
type ProgressCallback func(scannedCount int)

type elementBounds struct {
	X              float64 `json:"x"`
	Y              float64 `json:"y"`
	Width          float64 `json:"width"`
	Height         float64 `json:"height"`
	ViewportWidth  float64 `json:"viewportWidth"`
	ViewportHeight float64 `json:"viewportHeight"`
	Visible        bool    `json:"visible"`
}

// ScanPages scans multiple pages for accessibility issues using chromedp and axe-core.
// It uses a worker pool with bounded concurrency (max 5 simultaneous pages).
func ScanPages(ctx context.Context, allocCtx context.Context, pages []PageInput, scanID string, scanViewport viewport.Settings, onProgress ProgressCallback) ([]RawResult, error) {
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

			result := scanSinglePage(ctx, allocCtx, p, scanID, screenshotDir, scanViewport)

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

func scanSinglePage(ctx context.Context, allocCtx context.Context, page PageInput, scanID, screenshotDir string, scanViewport viewport.Settings) RawResult {
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
		chromedp.EmulateViewport(int64(scanViewport.Width), int64(scanViewport.Height)),
		chromedp.Navigate(page.URL),
		chromedp.WaitReady("body"),
	)
	if err != nil {
		result.Error = fmt.Sprintf("failed to navigate to %s: %v", page.URL, err)
		log.Printf("Juicer: %s", result.Error)
		return result
	}

	if err := waitForPageSettle(tabCtx); err != nil {
		result.Error = fmt.Sprintf("page did not settle for %s: %v", page.URL, err)
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

	if err := waitForPageSettle(tabCtx); err != nil {
		log.Printf("Juicer: warning: page settle before screenshots timed out for %s: %v", page.URL, err)
	}

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

			bounds, err := locateElement(tabCtx, selector)
			if err != nil || !bounds.Visible || bounds.Width == 0 || bounds.Height == 0 {
				if err != nil {
					log.Printf("Juicer: warning: failed to get bounds for %q: %v", selector, err)
				}
				nodeIdx++
				continue
			}

			clip := buildViewportClip(bounds, elementScreenshotPadding, elementScreenshotMinWidth, elementScreenshotMinHeight)
			if clip == nil {
				nodeIdx++
				continue
			}

			elemScreenshot, err := captureClip(tabCtx, clip)
			if err != nil {
				log.Printf("Juicer: warning: failed to screenshot element %q on %s: %v", selector, page.URL, err)
				nodeIdx++
				continue
			}

			if screenshotNeedsContext(elemScreenshot) {
				contextClip := buildViewportClip(bounds, elementContextPadding, elementContextMinWidth, elementContextMinHeight)
				if contextClip != nil {
					contextScreenshot, contextErr := captureClip(tabCtx, contextClip)
					if contextErr != nil {
						log.Printf("Juicer: warning: failed fallback screenshot for %q on %s: %v", selector, page.URL, contextErr)
					} else if !screenshotNeedsContext(contextScreenshot) {
						elemScreenshot = contextScreenshot
					}
				}
			}

			if len(elemScreenshot) >= elementScreenshotMinByteSize && !screenshotNeedsContext(elemScreenshot) {
				elemPath := filepath.Join(screenshotDir, fmt.Sprintf("%s_elem_%d.png", page.URLID, nodeIdx))
				if err := os.WriteFile(elemPath, elemScreenshot, 0644); err != nil {
					log.Printf("Juicer: warning: failed to save element screenshot: %v", err)
				} else {
					node.ElementScreenshotPath = elemPath
				}
			} else {
				viewportScreenshot, viewportErr := captureVisibleViewport(tabCtx)
				if viewportErr != nil {
					log.Printf("Juicer: warning: failed viewport-context screenshot for %q on %s: %v", selector, page.URL, viewportErr)
				} else if len(viewportScreenshot) >= elementScreenshotMinByteSize {
					contextPath := filepath.Join(screenshotDir, fmt.Sprintf("%s_context_%d.png", page.URLID, nodeIdx))
					if err := os.WriteFile(contextPath, viewportScreenshot, 0644); err != nil {
						log.Printf("Juicer: warning: failed to save viewport-context screenshot: %v", err)
					} else {
						node.ElementScreenshotPath = contextPath
					}
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

func waitForPageSettle(ctx context.Context) error {
	timeoutCtx, cancel := context.WithTimeout(ctx, pageSettleTimeout)
	defer cancel()

	script := fmt.Sprintf(`(async () => {
		const waitForLoad = () => new Promise((resolve) => {
			if (document.readyState === "complete") {
				resolve();
				return;
			}
			window.addEventListener("load", () => resolve(), { once: true });
			setTimeout(resolve, 5000);
		});

		const waitForFonts = async () => {
			if (!document.fonts || !document.fonts.ready) {
				return;
			}
			try {
				await Promise.race([
					document.fonts.ready,
					new Promise((resolve) => setTimeout(resolve, 5000)),
				]);
			} catch (_) {}
		};

		const waitForImages = () => new Promise((resolve) => {
			const pending = Array.from(document.images).filter((img) => !img.complete);
			if (pending.length === 0) {
				resolve();
				return;
			}

			let remaining = pending.length;
			const done = () => {
				remaining -= 1;
				if (remaining <= 0) {
					resolve();
				}
			};

			pending.forEach((img) => {
				img.addEventListener("load", done, { once: true });
				img.addEventListener("error", done, { once: true });
			});

			setTimeout(resolve, 5000);
		});

		const waitForFrames = () =>
			new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

		await waitForLoad();
		await waitForFonts();
		await waitForImages();
		await waitForFrames();
		await new Promise((resolve) => setTimeout(resolve, %d));
		await waitForFrames();
		return true;
	})()`, postLoadSettleDelay.Milliseconds())

	return chromedp.Run(timeoutCtx, chromedp.Evaluate(script, nil, func(ep *runtime.EvaluateParams) *runtime.EvaluateParams {
		return ep.WithAwaitPromise(true)
	}))
}

func locateElement(ctx context.Context, selector string) (elementBounds, error) {
	var bounds elementBounds

	err := chromedp.Run(ctx, chromedp.Evaluate(fmt.Sprintf(`(async () => {
		const el = document.querySelector(%q);
		if (!el) {
			return null;
		}

		el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
		await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

		const style = window.getComputedStyle(el);
		const rect = el.getBoundingClientRect();

		return {
			x: rect.x,
			y: rect.y,
			width: rect.width,
			height: rect.height,
			viewportWidth: window.innerWidth,
			viewportHeight: window.innerHeight,
			visible:
				rect.width > 0 &&
				rect.height > 0 &&
				style.display !== "none" &&
				style.visibility !== "hidden" &&
				Number(style.opacity || 1) > 0
		};
	})()`, selector), &bounds, func(ep *runtime.EvaluateParams) *runtime.EvaluateParams {
		return ep.WithAwaitPromise(true)
	}))
	if err != nil {
		return elementBounds{}, err
	}

	return bounds, nil
}

func buildViewportClip(bounds elementBounds, padding, minWidth, minHeight float64) *cdppage.Viewport {
	width := bounds.Width + padding*2
	height := bounds.Height + padding*2
	x := bounds.X - padding
	y := bounds.Y - padding

	if width < minWidth {
		x -= (minWidth - width) / 2
		width = minWidth
	}
	if height < minHeight {
		y -= (minHeight - height) / 2
		height = minHeight
	}

	if x < 0 {
		width += x
		x = 0
	}
	if y < 0 {
		height += y
		y = 0
	}

	if x+width > bounds.ViewportWidth {
		width = bounds.ViewportWidth - x
	}
	if y+height > bounds.ViewportHeight {
		height = bounds.ViewportHeight - y
	}

	width = math.Max(0, width)
	height = math.Max(0, height)
	if width == 0 || height == 0 {
		return nil
	}

	return &cdppage.Viewport{
		X:      x,
		Y:      y,
		Width:  width,
		Height: height,
		Scale:  elementScreenshotScale,
	}
}

func captureClip(ctx context.Context, clip *cdppage.Viewport) ([]byte, error) {
	if clip == nil {
		return nil, fmt.Errorf("missing viewport clip")
	}

	var screenshot []byte
	err := chromedp.Run(ctx, chromedp.ActionFunc(func(ctx context.Context) error {
		data, err := cdppage.CaptureScreenshot().
			WithFormat(cdppage.CaptureScreenshotFormatPng).
			WithClip(clip).
			Do(ctx)
		if err != nil {
			return err
		}
		screenshot = data
		return nil
	}))
	if err != nil {
		return nil, err
	}
	return screenshot, nil
}

func captureVisibleViewport(ctx context.Context) ([]byte, error) {
	var screenshot []byte
	err := chromedp.Run(ctx, chromedp.ActionFunc(func(ctx context.Context) error {
		data, err := cdppage.CaptureScreenshot().
			WithFormat(cdppage.CaptureScreenshotFormatPng).
			Do(ctx)
		if err != nil {
			return err
		}
		screenshot = data
		return nil
	}))
	if err != nil {
		return nil, err
	}
	return screenshot, nil
}

func screenshotNeedsContext(data []byte) bool {
	if len(data) < elementScreenshotMinByteSize {
		return true
	}

	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		return false
	}

	bounds := img.Bounds()
	width := bounds.Dx()
	height := bounds.Dy()
	if width < int(elementScreenshotMinWidth) || height < int(elementScreenshotMinHeight) {
		return true
	}

	samplesX := min(width, 24)
	samplesY := min(height, 24)
	if samplesX == 0 || samplesY == 0 {
		return true
	}

	stepX := math.Max(1, float64(width)/float64(samplesX))
	stepY := math.Max(1, float64(height)/float64(samplesY))

	baseSet := false
	var baseR, baseG, baseB uint32
	total := 0
	varied := 0

	for sampleY := 0; sampleY < samplesY; sampleY++ {
		for sampleX := 0; sampleX < samplesX; sampleX++ {
			x := bounds.Min.X + int(float64(sampleX)*stepX)
			y := bounds.Min.Y + int(float64(sampleY)*stepY)
			if x >= bounds.Max.X {
				x = bounds.Max.X - 1
			}
			if y >= bounds.Max.Y {
				y = bounds.Max.Y - 1
			}

			r, g, b, a := img.At(x, y).RGBA()
			if a == 0 {
				continue
			}

			if !baseSet {
				baseR, baseG, baseB = r, g, b
				baseSet = true
			}

			total++
			if colorDistance(baseR, baseG, baseB, r, g, b) > 12000 {
				varied++
			}
		}
	}

	if total == 0 {
		return true
	}

	return float64(varied)/float64(total) < 0.015
}

func colorDistance(r1, g1, b1, r2, g2, b2 uint32) float64 {
	dr := float64(int64(r1) - int64(r2))
	dg := float64(int64(g1) - int64(g2))
	db := float64(int64(b1) - int64(b2))
	return math.Sqrt(dr*dr + dg*dg + db*db)
}
