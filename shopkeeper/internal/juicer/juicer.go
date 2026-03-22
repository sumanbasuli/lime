package juicer

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/draw"
	"image/png"
	"log"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/campuspress/lime/shopkeeper/internal/viewport"
	cdpinput "github.com/chromedp/cdproto/input"
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
	elementContextPadding        = 36.0
	elementPreviewPadding        = 18.0
	elementScreenshotMinWidth    = 96.0
	elementScreenshotMinHeight   = 64.0
	elementContextMinWidth       = 280.0
	elementContextMinHeight      = 180.0
	elementPreviewMinWidth       = 160.0
	elementPreviewMinHeight      = 112.0
	elementScreenshotMinByteSize = 128
	elementScreenshotScale       = 2.0
	elementHighlightOutline      = "#FFED00"
	elementHighlightShadow       = "0 0 0 9999px rgba(17, 17, 17, 0.58), 0 18px 48px rgba(17, 17, 17, 0.32)"
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

type captureLocator struct {
	Selector string
	Index    int
}

type captureCandidate struct {
	Index int    `json:"index"`
	HTML  string `json:"html"`
}

type capturePreparation struct {
	Found          bool          `json:"found"`
	Target         elementBounds `json:"target"`
	HoverTarget    elementBounds `json:"hoverTarget"`
	HasHoverTarget bool          `json:"hasHoverTarget"`
	Focusable      bool          `json:"focusable"`
}

type captureAssignmentState struct {
	exactCursor    map[string]int
	selectorCursor map[string]int
}

type axeRuleOverride struct {
	Enabled bool `json:"enabled"`
}

type axeRunOnly struct {
	Type   string   `json:"type"`
	Values []string `json:"values"`
}

type axeRunOptions struct {
	ElementRef  bool                       `json:"elementRef"`
	RunOnly     axeRunOnly                 `json:"runOnly"`
	ResultTypes []string                   `json:"resultTypes"`
	Rules       map[string]axeRuleOverride `json:"rules"`
}

var lighthouseAxeRuleOverrides = map[string]axeRuleOverride{
	"accesskeys":                   {Enabled: true},
	"area-alt":                     {Enabled: false},
	"aria-allowed-role":            {Enabled: true},
	"aria-braille-equivalent":      {Enabled: false},
	"aria-conditional-attr":        {Enabled: true},
	"aria-deprecated-role":         {Enabled: true},
	"aria-dialog-name":             {Enabled: true},
	"aria-prohibited-attr":         {Enabled: true},
	"aria-roledescription":         {Enabled: false},
	"aria-text":                    {Enabled: true},
	"aria-treeitem-name":           {Enabled: true},
	"audio-caption":                {Enabled: false},
	"blink":                        {Enabled: false},
	"duplicate-id":                 {Enabled: false},
	"empty-heading":                {Enabled: true},
	"frame-focusable-content":      {Enabled: false},
	"frame-title-unique":           {Enabled: false},
	"heading-order":                {Enabled: true},
	"html-xml-lang-mismatch":       {Enabled: true},
	"identical-links-same-purpose": {Enabled: true},
	"image-redundant-alt":          {Enabled: true},
	"input-button-name":            {Enabled: true},
	"label-content-name-mismatch":  {Enabled: true},
	"landmark-one-main":            {Enabled: true},
	"link-in-text-block":           {Enabled: true},
	"marquee":                      {Enabled: false},
	"meta-viewport":                {Enabled: true},
	"nested-interactive":           {Enabled: false},
	"no-autoplay-audio":            {Enabled: false},
	"role-img-alt":                 {Enabled: false},
	"scrollable-region-focusable":  {Enabled: false},
	"select-name":                  {Enabled: true},
	"server-side-image-map":        {Enabled: false},
	"skip-link":                    {Enabled: true},
	"summary-name":                 {Enabled: false},
	"svg-img-alt":                  {Enabled: false},
	"tabindex":                     {Enabled: true},
	"table-duplicate-name":         {Enabled: true},
	"table-fake-caption":           {Enabled: true},
	"target-size":                  {Enabled: true},
	"td-has-header":                {Enabled: true},
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
		log.Printf("Juicer: warning: page settle before axe timed out for %s: %v", page.URL, err)
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

	axeRunScript, err := lighthouseAxeRunScript()
	if err != nil {
		result.Error = fmt.Sprintf("failed to prepare accessibility script for %s: %v", page.URL, err)
		log.Printf("Juicer: %s", result.Error)
		return result
	}

	// Run axe-core using Lighthouse-style accessibility configuration and get results as a JSON string.
	var axeResultJSON string
	err = chromedp.Run(tabCtx,
		chromedp.Evaluate(axeRunScript, &axeResultJSON, func(ep *runtime.EvaluateParams) *runtime.EvaluateParams {
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
	result.Incomplete = axeRes.Incomplete
	result.NotApplicable = axeRes.NotApplicable
	result.Passes = axeRes.Passes
	result.Version = axeRes.Version

	if err := assignCaptureIndices(tabCtx, result.Violations); err != nil {
		log.Printf("Juicer: warning: failed to assign exact capture indices for %s: %v", page.URL, err)
	}

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
			locator := captureLocatorForNode(*node)
			selector := locator.Selector

			bounds, err := prepareElementForCapture(tabCtx, locator)
			if err != nil || !bounds.Visible || bounds.Width == 0 || bounds.Height == 0 {
				if err != nil {
					log.Printf("Juicer: warning: failed to get bounds for %q: %v", selector, err)
				}
				nodeIdx++
				continue
			}

			elemScreenshot, previewScreenshot, err := captureHighlightedScreenshots(tabCtx, locator, bounds)
			if err != nil {
				log.Printf("Juicer: warning: failed to screenshot element %q on %s: %v", selector, page.URL, err)
				nodeIdx++
				continue
			}

			if len(elemScreenshot) >= elementScreenshotMinByteSize {
				elemPath := filepath.Join(screenshotDir, fmt.Sprintf("%s_focus_%d.png", page.URLID, nodeIdx))
				if err := os.WriteFile(elemPath, elemScreenshot, 0644); err != nil {
					log.Printf("Juicer: warning: failed to save element screenshot: %v", err)
				} else {
					node.ElementScreenshotPath = elemPath

					if len(previewScreenshot) >= elementScreenshotMinByteSize {
						if err := os.WriteFile(focusedPreviewPath(elemPath), previewScreenshot, 0644); err != nil {
							log.Printf("Juicer: warning: failed to save preview screenshot: %v", err)
						}
					}
				}
			}
			nodeIdx++
		}
	}

	// Take a full-page screenshot (last, since it alters viewport metrics)
	screenshot, err = captureFullPage(tabCtx)
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

	log.Printf(
		"Juicer: scanned %s — %d violations, %d incomplete, %d not-applicable (axe %s)",
		page.URL,
		len(result.Violations),
		len(result.Incomplete),
		len(result.NotApplicable),
		result.Version,
	)
	return result
}

func lighthouseAxeRunOptions() axeRunOptions {
	return axeRunOptions{
		ElementRef: true,
		RunOnly: axeRunOnly{
			Type:   "tag",
			Values: []string{"wcag2a", "wcag2aa"},
		},
		ResultTypes: []string{"violations", "inapplicable"},
		Rules:       lighthouseAxeRuleOverrides,
	}
}

func lighthouseAxeRunConfigJSON() (string, error) {
	payload, err := json.Marshal(lighthouseAxeRunOptions())
	if err != nil {
		return "", err
	}

	return string(payload), nil
}

func lighthouseAxeRunScript() (string, error) {
	configJSON, err := lighthouseAxeRunConfigJSON()
	if err != nil {
		return "", err
	}

	return fmt.Sprintf(`(async () => {
		const axe = window.axe;
		const impactToNumber = (impact) => [null, "minor", "moderate", "serious", "critical"].indexOf(impact);
		const describeElement = (element, fallbackTarget) => {
			let html = "";
			try {
				html = element && element.outerHTML ? element.outerHTML : "";
			} catch (_) {}

			return {
				html,
				target: Array.isArray(fallbackTarget) ? fallbackTarget : [],
			};
		};

		const collectRelatedNodes = (node, element) => {
			const relatedElements = new Set();
			const relatedNodeDetails = [];
			const checkResults = [...(node.any || []), ...(node.all || []), ...(node.none || [])]
				.sort((a, b) => impactToNumber(b.impact) - impactToNumber(a.impact));

			for (const checkResult of checkResults) {
				for (const relatedNode of checkResult.relatedNodes || []) {
					if (relatedNodeDetails.length >= 3) break;

					const relatedElement = relatedNode.element;
					if (!relatedElement || relatedElement === element || relatedElements.has(relatedElement)) {
						continue;
					}

					relatedElements.add(relatedElement);
					relatedNodeDetails.push(describeElement(relatedElement, relatedNode.target));
				}

				if (relatedNodeDetails.length >= 3) {
					break;
				}
			}

			return relatedNodeDetails;
		};

		const serializeRuleResult = (result) => ({
			id: result.id,
			description: result.description,
			help: result.help,
			helpUrl: result.helpUrl,
			impact: result.impact,
			tags: result.tags || [],
			nodes: (result.nodes || []).map((node) => {
				const element = node.element || null;
				const details = describeElement(element, node.target);
				return {
					html: details.html,
					target: details.target,
					failureSummary: node.failureSummary || "",
					relatedNodes: collectRelatedNodes(node, element),
				};
			}),
		});

		axe.configure({
			branding: {
				application: "lime-lighthouse-aligned",
			},
			noHtml: true,
		});

		const originalScrollPosition = {
			x: window.scrollX,
			y: window.scrollY,
		};

		try {
			const axeResults = await axe.run(document, %s);
			document.documentElement.scrollTop = 0;

			return JSON.stringify({
				violations: (axeResults.violations || []).map(serializeRuleResult),
				incomplete: (axeResults.incomplete || []).map(serializeRuleResult),
				notApplicable: (axeResults.inapplicable || []).map((result) => ({id: result.id})),
				passes: (axeResults.passes || []).map((result) => ({id: result.id})),
				version: axeResults.testEngine && axeResults.testEngine.version ? axeResults.testEngine.version : "",
			});
		} finally {
			window.scrollTo(originalScrollPosition.x, originalScrollPosition.y);
		}
	})()`, configJSON), nil
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

func assignCaptureIndices(ctx context.Context, violations []Violation) error {
	selectors := uniqueCaptureSelectors(violations)
	if len(selectors) == 0 {
		return nil
	}

	candidates, err := collectCaptureCandidates(ctx, selectors)
	if err != nil {
		return err
	}

	state := captureAssignmentState{
		exactCursor:    make(map[string]int),
		selectorCursor: make(map[string]int),
	}

	for vi := range violations {
		for ni := range violations[vi].Nodes {
			node := &violations[vi].Nodes[ni]
			if len(node.Target) == 0 {
				continue
			}

			index, ok := selectCaptureIndex(node.Target[0], node.HTML, candidates[node.Target[0]], &state)
			if !ok {
				continue
			}

			node.CaptureIndex = index
			node.HasCaptureIndex = true
		}
	}

	return nil
}

func uniqueCaptureSelectors(violations []Violation) []string {
	seen := make(map[string]struct{})
	selectors := make([]string, 0)

	for _, violation := range violations {
		for _, node := range violation.Nodes {
			if len(node.Target) == 0 {
				continue
			}

			selector := strings.TrimSpace(node.Target[0])
			if selector == "" {
				continue
			}

			if _, exists := seen[selector]; exists {
				continue
			}
			seen[selector] = struct{}{}
			selectors = append(selectors, selector)
		}
	}

	return selectors
}

func collectCaptureCandidates(ctx context.Context, selectors []string) (map[string][]captureCandidate, error) {
	payload, err := json.Marshal(selectors)
	if err != nil {
		return nil, err
	}

	var candidates map[string][]captureCandidate
	script := fmt.Sprintf(`(() => {
		const selectors = %s;
		const describe = (selector) => {
			try {
				return Array.from(document.querySelectorAll(selector)).map((el, index) => ({
					index,
					html: el.outerHTML || ""
				}));
			} catch (_) {
				return [];
			}
		};

		return Object.fromEntries(selectors.map((selector) => [selector, describe(selector)]));
	})()`, payload)

	if err := chromedp.Run(ctx, chromedp.Evaluate(script, &candidates)); err != nil {
		return nil, err
	}

	return candidates, nil
}

func selectCaptureIndex(selector, html string, candidates []captureCandidate, state *captureAssignmentState) (int, bool) {
	if len(candidates) == 0 {
		return 0, false
	}

	normalizedHTML := normalizeCaptureHTML(html)
	if normalizedHTML != "" {
		exactMatches := make([]captureCandidate, 0, len(candidates))
		for _, candidate := range candidates {
			if normalizeCaptureHTML(candidate.HTML) == normalizedHTML {
				exactMatches = append(exactMatches, candidate)
			}
		}

		switch len(exactMatches) {
		case 1:
			return exactMatches[0].Index, true
		case 0:
		default:
			key := selector + "\x00" + normalizedHTML
			cursor := state.exactCursor[key]
			if cursor >= len(exactMatches) {
				cursor = len(exactMatches) - 1
			}
			state.exactCursor[key] = cursor + 1
			return exactMatches[cursor].Index, true
		}
	}

	if len(candidates) == 1 {
		return candidates[0].Index, true
	}

	cursor := state.selectorCursor[selector]
	if cursor >= len(candidates) {
		cursor = len(candidates) - 1
	}
	state.selectorCursor[selector] = cursor + 1
	return candidates[cursor].Index, true
}

func normalizeCaptureHTML(html string) string {
	return strings.Join(strings.Fields(strings.TrimSpace(html)), " ")
}

func captureLocatorForNode(node Node) captureLocator {
	index := 0
	if node.HasCaptureIndex && node.CaptureIndex >= 0 {
		index = node.CaptureIndex
	}

	selector := ""
	if len(node.Target) > 0 {
		selector = node.Target[0]
	}

	return captureLocator{
		Selector: selector,
		Index:    index,
	}
}

func waitForAnimationFrames(ctx context.Context) error {
	return chromedp.Run(ctx, chromedp.Evaluate(`new Promise((resolve) => {
		requestAnimationFrame(() => requestAnimationFrame(resolve));
	})`, nil, func(ep *runtime.EvaluateParams) *runtime.EvaluateParams {
		return ep.WithAwaitPromise(true)
	}))
}

func captureHighlightedScreenshots(ctx context.Context, locator captureLocator, bounds elementBounds) ([]byte, []byte, error) {
	var viewportScreenshot []byte

	_, err := withHighlightOverlay(ctx, locator, func() ([]byte, error) {
		var err error
		viewportScreenshot, err = captureViewport(ctx)
		if err != nil {
			return nil, err
		}

		return viewportScreenshot, nil
	})
	if err != nil {
		return nil, nil, err
	}

	previewClip := buildViewportClip(bounds, elementPreviewPadding, elementPreviewMinWidth, elementPreviewMinHeight)
	if previewClip == nil {
		return viewportScreenshot, nil, nil
	}

	previewScreenshot, err := cropPNG(viewportScreenshot, previewClip, bounds.ViewportWidth, bounds.ViewportHeight)
	if err != nil {
		return viewportScreenshot, nil, err
	}
	if screenshotNeedsContext(previewScreenshot) {
		contextClip := buildViewportClip(bounds, elementContextPadding, elementContextMinWidth, elementContextMinHeight)
		if contextClip != nil {
			contextScreenshot, contextErr := cropPNG(viewportScreenshot, contextClip, bounds.ViewportWidth, bounds.ViewportHeight)
			if contextErr == nil && len(contextScreenshot) > 0 {
				previewScreenshot = contextScreenshot
			}
		}
	}

	return viewportScreenshot, previewScreenshot, nil
}

func focusedPreviewPath(path string) string {
	ext := filepath.Ext(path)
	base := strings.TrimSuffix(path, ext)
	if ext == "" {
		return path + "_preview"
	}
	return base + "_preview" + ext
}

func withHighlightOverlay(ctx context.Context, locator captureLocator, capture func() ([]byte, error)) ([]byte, error) {
	if err := clearHighlightOverlay(ctx); err != nil {
		log.Printf("Juicer: warning: failed to clear stale highlight overlay before %q: %v", locator.Selector, err)
	}

	highlighted, err := setHighlightOverlay(ctx, locator, true)
	if err != nil {
		return nil, err
	}
	if highlighted {
		if err := waitForAnimationFrames(ctx); err != nil {
			log.Printf("Juicer: warning: failed to wait for highlight paint on %q: %v", locator.Selector, err)
		}
		defer func() {
			if clearErr := clearHighlightOverlay(ctx); clearErr != nil {
				log.Printf("Juicer: warning: failed to clear highlight overlay on %q: %v", locator.Selector, clearErr)
			}
		}()
	}

	return capture()
}

func setHighlightOverlay(ctx context.Context, locator captureLocator, enabled bool) (bool, error) {
	var highlighted bool

	script := fmt.Sprintf(`(() => {
		const overlayId = "lime-highlight-overlay";
		const removeOverlay = () => {
			const existing = document.getElementById(overlayId);
			if (existing) {
				existing.remove();
			}
		};

		removeOverlay();
		if (!%t) {
			return false;
		}

		const nodes = document.querySelectorAll(%q);
		if (nodes.length === 0) {
			return false;
		}

		const index = Math.min(Math.max(%d, 0), nodes.length - 1);
		const el = nodes[index];
		if (!el) {
			return false;
		}

		const rect = el.getBoundingClientRect();
		if (!rect || rect.width <= 0 || rect.height <= 0) {
			return false;
		}

		const overlay = document.createElement("div");
		overlay.id = overlayId;
		Object.assign(overlay.style, {
			position: "fixed",
			left: rect.x + "px",
			top: rect.y + "px",
			width: rect.width + "px",
			height: rect.height + "px",
			border: "3px solid %s",
			borderRadius: "10px",
			boxShadow: %q,
			zIndex: "2147483646",
			pointerEvents: "none",
			boxSizing: "border-box",
		});
		document.body.appendChild(overlay);
		return true;
	})()`, enabled, locator.Selector, locator.Index, elementHighlightOutline, elementHighlightShadow)

	err := chromedp.Run(ctx, chromedp.Evaluate(script, &highlighted))
	if err != nil {
		return false, err
	}

	return highlighted, nil
}

func clearHighlightOverlay(ctx context.Context) error {
	return chromedp.Run(ctx, chromedp.Evaluate(`(() => {
		const existing = document.getElementById("lime-highlight-overlay");
		if (existing) {
			existing.remove();
		}
		return true;
	})()`, nil))
}

func prepareElementForCapture(ctx context.Context, locator captureLocator) (elementBounds, error) {
	if err := scrollCaptureTargetIntoView(ctx, locator); err != nil {
		return elementBounds{}, err
	}
	if err := waitForAnimationFrames(ctx); err != nil {
		return elementBounds{}, err
	}

	preparation, err := inspectCaptureTarget(ctx, locator)
	if err != nil {
		return elementBounds{}, err
	}
	if !preparation.Found {
		return elementBounds{}, fmt.Errorf("selector %q could not be resolved for capture", locator.Selector)
	}

	if hoverBounds, ok := hoverBoundsForPreparation(preparation); ok {
		if err := scrollVisibleAncestorIntoView(ctx, locator); err != nil {
			return elementBounds{}, err
		}
		if err := waitForAnimationFrames(ctx); err != nil {
			return elementBounds{}, err
		}
		if err := moveMouseToBounds(ctx, hoverBounds); err != nil {
			return elementBounds{}, err
		}
		if err := waitForAnimationFrames(ctx); err != nil {
			return elementBounds{}, err
		}
		preparation, err = inspectCaptureTarget(ctx, locator)
		if err != nil {
			return elementBounds{}, err
		}
	}

	if preparation.Target.Visible {
		if err := moveMouseToBounds(ctx, preparation.Target); err != nil {
			return elementBounds{}, err
		}
		if err := waitForAnimationFrames(ctx); err != nil {
			return elementBounds{}, err
		}
	}

	if preparation.Focusable {
		focused, err := focusCaptureTarget(ctx, locator)
		if err != nil {
			return elementBounds{}, err
		}
		if focused {
			if err := waitForAnimationFrames(ctx); err != nil {
				return elementBounds{}, err
			}
		}
	}

	preparation, err = inspectCaptureTarget(ctx, locator)
	if err != nil {
		return elementBounds{}, err
	}
	if !preparation.Target.Visible {
		return elementBounds{}, nil
	}

	return preparation.Target, nil
}

func inspectCaptureTarget(ctx context.Context, locator captureLocator) (capturePreparation, error) {
	var preparation capturePreparation

	err := chromedp.Run(ctx, chromedp.Evaluate(fmt.Sprintf(`(async () => {
		const nodes = document.querySelectorAll(%q);
		if (nodes.length === 0) {
			return { found: false };
		}

		const index = Math.min(Math.max(%d, 0), nodes.length - 1);
		const el = nodes[index];
		if (!el) {
			return { found: false };
		}

		const measure = (node) => {
			if (!node) {
				return null;
			}

			const style = window.getComputedStyle(node);
			const rect = node.getBoundingClientRect();
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
		};

		const isFocusable =
			typeof el.focus === "function" &&
			(
				el.tabIndex >= 0 ||
				["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY"].includes(el.tagName) ||
				el.hasAttribute("contenteditable")
			);

		let visibleAncestor = null;
		let parent = el.parentElement;
		while (parent) {
			const bounds = measure(parent);
			if (bounds && bounds.visible) {
				visibleAncestor = bounds;
				break;
			}
			parent = parent.parentElement;
		}

		return {
			found: true,
			target: measure(el),
			hoverTarget: visibleAncestor,
			hasHoverTarget: Boolean(visibleAncestor),
			focusable: isFocusable
		};
	})()`, locator.Selector, locator.Index), &preparation, func(ep *runtime.EvaluateParams) *runtime.EvaluateParams {
		return ep.WithAwaitPromise(true)
	}))
	if err != nil {
		return capturePreparation{}, err
	}

	return preparation, nil
}

func scrollCaptureTargetIntoView(ctx context.Context, locator captureLocator) error {
	return runLocatorScript(ctx, locator, `el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); return true;`, nil)
}

func scrollVisibleAncestorIntoView(ctx context.Context, locator captureLocator) error {
	return runLocatorScript(ctx, locator, `
		let parent = el.parentElement;
		while (parent) {
			const style = window.getComputedStyle(parent);
			const rect = parent.getBoundingClientRect();
			if (
				rect.width > 0 &&
				rect.height > 0 &&
				style.display !== "none" &&
				style.visibility !== "hidden" &&
				Number(style.opacity || 1) > 0
			) {
				parent.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
				return true;
			}
			parent = parent.parentElement;
		}
		return false;
	`, nil)
}

func focusCaptureTarget(ctx context.Context, locator captureLocator) (bool, error) {
	var focused bool
	err := runLocatorScript(ctx, locator, `
		if (typeof el.focus !== "function") {
			return false;
		}
		el.focus({ preventScroll: true });
		return document.activeElement === el;
	`, &focused)
	if err != nil {
		return false, err
	}
	return focused, nil
}

func runLocatorScript(ctx context.Context, locator captureLocator, body string, out any) error {
	script := fmt.Sprintf(`(() => {
		const nodes = document.querySelectorAll(%q);
		if (nodes.length === 0) {
			return false;
		}

		const index = Math.min(Math.max(%d, 0), nodes.length - 1);
		const el = nodes[index];
		if (!el) {
			return false;
		}

		%s
	})()`, locator.Selector, locator.Index, body)
	return chromedp.Run(ctx, chromedp.Evaluate(script, out))
}

func moveMouseToBounds(ctx context.Context, bounds elementBounds) error {
	if !hasVisibleBounds(bounds) {
		return nil
	}

	x := bounds.X + (bounds.Width / 2)
	y := bounds.Y + (bounds.Height / 2)

	return chromedp.Run(ctx, chromedp.ActionFunc(func(ctx context.Context) error {
		return cdpinput.DispatchMouseEvent(cdpinput.MouseMoved, x, y).
			WithButton(cdpinput.None).
			Do(ctx)
	}))
}

func hoverBoundsForPreparation(preparation capturePreparation) (elementBounds, bool) {
	if hasVisibleBounds(preparation.Target) {
		return elementBounds{}, false
	}
	if !preparation.HasHoverTarget || !hasVisibleBounds(preparation.HoverTarget) {
		return elementBounds{}, false
	}
	return preparation.HoverTarget, true
}

func hasVisibleBounds(bounds elementBounds) bool {
	return bounds.Visible && bounds.Width > 0 && bounds.Height > 0
}

func buildViewportClip(bounds elementBounds, padding, minWidth, minHeight float64) *cdppage.Viewport {
	width := math.Max(bounds.Width+padding*2, minWidth)
	height := math.Max(bounds.Height+padding*2, minHeight)
	width = math.Min(width, bounds.ViewportWidth)
	height = math.Min(height, bounds.ViewportHeight)

	centerX := bounds.X + bounds.Width/2
	centerY := bounds.Y + bounds.Height/2
	x := centerX - width/2
	y := centerY - height/2

	if x < 0 {
		x = 0
	}
	if y < 0 {
		y = 0
	}
	if x+width > bounds.ViewportWidth {
		x = math.Max(0, bounds.ViewportWidth-width)
	}
	if y+height > bounds.ViewportHeight {
		y = math.Max(0, bounds.ViewportHeight-height)
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

func cropPNG(data []byte, clip *cdppage.Viewport, viewportWidth, viewportHeight float64) ([]byte, error) {
	if clip == nil {
		return nil, fmt.Errorf("missing viewport clip")
	}
	if viewportWidth <= 0 || viewportHeight <= 0 {
		return nil, fmt.Errorf("missing viewport size")
	}

	src, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}

	srcBounds := src.Bounds()
	scaleX := float64(srcBounds.Dx()) / viewportWidth
	scaleY := float64(srcBounds.Dy()) / viewportHeight
	rect := image.Rect(
		int(math.Floor(clip.X*scaleX)),
		int(math.Floor(clip.Y*scaleY)),
		int(math.Ceil((clip.X+clip.Width)*scaleX)),
		int(math.Ceil((clip.Y+clip.Height)*scaleY)),
	).Intersect(srcBounds)
	if rect.Empty() {
		return nil, fmt.Errorf("preview crop was empty")
	}

	dst := image.NewRGBA(image.Rect(0, 0, rect.Dx(), rect.Dy()))
	draw.Draw(dst, dst.Bounds(), src, rect.Min, draw.Src)

	var buf bytes.Buffer
	if err := png.Encode(&buf, dst); err != nil {
		return nil, err
	}

	return buf.Bytes(), nil
}

func captureClip(ctx context.Context, clip *cdppage.Viewport) ([]byte, error) {
	if clip == nil {
		return nil, fmt.Errorf("missing viewport clip")
	}

	var screenshot []byte
	err := chromedp.Run(ctx, chromedp.ActionFunc(func(ctx context.Context) error {
		data, err := cdppage.CaptureScreenshot().
			WithFormat(cdppage.CaptureScreenshotFormatPng).
			WithFromSurface(true).
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

func captureViewport(ctx context.Context) ([]byte, error) {
	var screenshot []byte
	err := chromedp.Run(ctx, chromedp.ActionFunc(func(ctx context.Context) error {
		data, err := cdppage.CaptureScreenshot().
			WithFormat(cdppage.CaptureScreenshotFormatPng).
			WithFromSurface(true).
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

func captureFullPage(ctx context.Context) ([]byte, error) {
	var screenshot []byte
	err := chromedp.Run(ctx, chromedp.ActionFunc(func(ctx context.Context) error {
		data, err := cdppage.CaptureScreenshot().
			WithCaptureBeyondViewport(true).
			WithFromSurface(true).
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
