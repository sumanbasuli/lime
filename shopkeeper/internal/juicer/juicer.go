package juicer

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/draw"
	"image/png"
	"math"
	"net"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/chromedp/cdproto/cdp"
	cdpdom "github.com/chromedp/cdproto/dom"
	cdpinput "github.com/chromedp/cdproto/input"
	cdppage "github.com/chromedp/cdproto/page"
	"github.com/chromedp/cdproto/runtime"
	cdptarget "github.com/chromedp/cdproto/target"
	"github.com/chromedp/chromedp"
	"github.com/sumanbasuli/lime/shopkeeper/internal/egressproxy"
	"github.com/sumanbasuli/lime/shopkeeper/internal/rootdns"
	log "github.com/sumanbasuli/lime/shopkeeper/internal/safelog"
	"github.com/sumanbasuli/lime/shopkeeper/internal/screenshots"
	"github.com/sumanbasuli/lime/shopkeeper/internal/viewport"
	"golang.org/x/net/idna"
)

const (
	// MaxConcurrency is the maximum number of pages scanned simultaneously.
	MaxConcurrency = 5

	// PageTimeout is the maximum time allowed for scanning a single page.
	PageTimeout = 30 * time.Second

	// DelayBetweenRequests is the politeness delay between requests.
	DelayBetweenRequests = 500 * time.Millisecond

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
	frameScreenshotWarning       = "<!-- LIME evidence warning: element screenshot omitted because the affected node is inside a frame -->"
)

// PageInput represents a URL to scan with its DB record ID.
type PageInput struct {
	URLID string
	URL   string
}

// ProgressCallback reports the number of scanned pages as workers finish.
type ProgressCallback func(scannedCount int)

// ResultCallback checkpoints a finished page before progress is reported.
type ResultCallback func(RawResult) error

// ErrResultCheckpoint distinguishes a persistence failure from the scan slice
// deadline, even when the callback itself returns context.DeadlineExceeded.
var ErrResultCheckpoint = errors.New("result checkpoint failed")

// synchronizedProgress prevents concurrent worker callbacks from persisting an
// older count after a newer one. Each scan run gets its own tracker so deliberate
// progress resets, such as retrying failed pages, remain possible.
func synchronizedProgress(callback ProgressCallback) ProgressCallback {
	if callback == nil {
		return nil
	}
	var mu sync.Mutex
	latest := 0
	return func(count int) {
		mu.Lock()
		defer mu.Unlock()
		if count <= latest {
			return
		}
		latest = count
		callback(count)
	}
}

func onceBrowserCancel(cancel context.CancelFunc) context.CancelFunc {
	var once sync.Once
	return func() { once.Do(cancel) }
}

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

type frameTopologyTracker struct {
	revision atomic.Uint64
	mu       sync.Mutex
	targets  map[cdptarget.ID]string
}

func (tracker *frameTopologyTracker) watchTarget(ctx context.Context) {
	chromedp.ListenTarget(ctx, func(event any) {
		switch changed := event.(type) {
		case *cdppage.EventFrameAttached, *cdppage.EventFrameDetached:
			tracker.revision.Add(1)
		case *cdppage.EventFrameNavigated:
			if changed.Frame != nil && changed.Frame.ParentID != "" {
				tracker.revision.Add(1)
			}
		}
	})
}

func (tracker *frameTopologyTracker) watchBrowser(ctx context.Context) {
	tracker.targets = make(map[cdptarget.ID]string)
	chromedp.ListenBrowser(ctx, func(event any) {
		tracker.mu.Lock()
		defer tracker.mu.Unlock()
		switch changed := event.(type) {
		case *cdptarget.EventTargetCreated:
			if changed.TargetInfo != nil && changed.TargetInfo.Type == "iframe" {
				tracker.targets[changed.TargetInfo.TargetID] = changed.TargetInfo.URL
				tracker.revision.Add(1)
			}
		case *cdptarget.EventTargetInfoChanged:
			if changed.TargetInfo != nil && changed.TargetInfo.Type == "iframe" {
				prior, exists := tracker.targets[changed.TargetInfo.TargetID]
				if !exists || prior != changed.TargetInfo.URL {
					tracker.targets[changed.TargetInfo.TargetID] = changed.TargetInfo.URL
					tracker.revision.Add(1)
				}
			}
		case *cdptarget.EventTargetDestroyed:
			if _, exists := tracker.targets[changed.TargetID]; exists {
				delete(tracker.targets, changed.TargetID)
				tracker.revision.Add(1)
			}
		}
	})
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
	Iframes     bool                       `json:"iframes"`
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
func ScanPages(ctx context.Context, allocCtx context.Context, pages []PageInput, scanID string, scanViewport viewport.Settings, onProgress ProgressCallback, policies ...rootdns.Policy) ([]RawResult, error) {
	return scanPages(ctx, allocCtx, pages, scanID, scanViewport, onProgress, nil, nil, policies...)
}

// ScanPagesWithResults checkpoints each finished page before the next progress
// update. Its callback is serialized across workers and may stop the scan.
func ScanPagesWithResults(ctx context.Context, allocCtx context.Context, pages []PageInput, scanID string, scanViewport viewport.Settings, onProgress ProgressCallback, onResult ResultCallback, axeBudget *AxeResultBudget, policies ...rootdns.Policy) ([]RawResult, error) {
	return scanPages(ctx, allocCtx, pages, scanID, scanViewport, onProgress, onResult, axeBudget, policies...)
}

func scanPages(ctx context.Context, allocCtx context.Context, pages []PageInput, scanID string, scanViewport viewport.Settings, onProgress ProgressCallback, onResult ResultCallback, axeBudget *AxeResultBudget, policies ...rootdns.Policy) ([]RawResult, error) {
	if len(pages) == 0 {
		return []RawResult{}, nil
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	onProgress = synchronizedProgress(onProgress)
	var policy rootdns.Policy
	if len(policies) > 0 {
		policy = policies[0]
	}

	// Create screenshot directory for this scan
	screenshotDir := screenshots.ScanDir(scanID)
	if err := screenshots.EnsureScanDir(scanID); err != nil {
		log.Printf("Juicer: warning: could not create screenshot directory %s: %v", screenshotDir, err)
	}
	evidenceBudget, err := newScanEvidenceBudget(screenshotDir)
	if err != nil {
		log.Printf("Juicer: warning: screenshots unavailable for scan %s: %v", scanID, err)
		evidenceBudget = &scanEvidenceBudget{
			screenshotFiles: maxScanScreenshotFiles,
			screenshotBytes: maxScanScreenshotBytes,
		}
	}
	evidenceBudget.sharedAxe = axeBudget

	// Semaphore channel for limiting concurrency
	sem := make(chan struct{}, MaxConcurrency)
	var mu sync.Mutex
	var checkpointMu sync.Mutex
	var checkpointErr error
	var results []RawResult
	scannedCount := 0

	var wg sync.WaitGroup
scheduleLoop:
	for _, page := range pages {
		select {
		case <-ctx.Done():
			break scheduleLoop
		case sem <- struct{}{}:
		}

		wg.Add(1)
		go func(p PageInput) {
			defer wg.Done()
			defer func() { <-sem }() // Release semaphore

			result := scanSinglePage(ctx, allocCtx, p, scanID, screenshotDir, scanViewport, evidenceBudget, policy)
			if result.Canceled {
				evidenceBudget.releaseUncheckpointedAxeResult(result.axeBytes)
				return
			}
			if onResult != nil {
				checkpointMu.Lock()
				if checkpointErr == nil {
					checkpointErr = onResult(result)
					if checkpointErr != nil {
						cancel()
					}
				}
				failed := checkpointErr != nil
				checkpointMu.Unlock()
				if failed {
					evidenceBudget.releaseUncheckpointedAxeResult(result.axeBytes)
					return
				}
			}

			mu.Lock()
			if onResult != nil {
				// The caller already saved the full evidence. Keep only the fields
				// needed to summarize this slice, so a long run stays bounded.
				results = append(results, RawResult{URLID: result.URLID, URL: result.URL, Error: result.Error})
			} else {
				results = append(results, result)
			}
			scannedCount++
			count := scannedCount
			mu.Unlock()

			if onProgress != nil {
				onProgress(count)
			}

			// Politeness delay
			select {
			case <-ctx.Done():
			case <-time.After(DelayBetweenRequests):
			}
		}(page)
	}

	wg.Wait()

	log.Printf("Juicer: scanned %d pages for scan %s", len(results), scanID)
	if checkpointErr != nil {
		return results, fmt.Errorf("%w: %w", ErrResultCheckpoint, checkpointErr)
	}
	if err := ctx.Err(); err != nil {
		return results, err
	}

	return results, nil
}

func scanSinglePage(ctx context.Context, allocCtx context.Context, page PageInput, scanID, screenshotDir string, scanViewport viewport.Settings, budget *scanEvidenceBudget, policies ...rootdns.Policy) (result RawResult) {
	result = RawResult{
		URLID: page.URLID,
		URL:   page.URL,
	}
	pageCtx, pageCancel := context.WithTimeout(ctx, PageTimeout)
	defer pageCancel()

	// Chrome's proxy must be ready before the browser starts. All redirects and
	// subresources then pass through the same dial-time destination policy.
	var policy rootdns.Policy
	if len(policies) > 0 {
		policy = policies[0]
	}
	proxy, err := egressproxy.StartWithRootPolicy(pageCtx, page.URL, policy.Observe, policy.GuardPrivateDial)
	if err != nil {
		if shouldTreatAsCanceled(ctx, err) {
			result.Canceled = true
			return result
		}
		result.Error = log.Sprintf("failed to set up browser egress for %s: %v", page.URL, err)
		log.Printf("Juicer: %s", result.Error)
		return result
	}
	defer func() {
		_ = proxy.Close()
		if !proxy.BudgetExceeded() {
			return
		}
		// A background request can exceed the budget after navigation or axe.
		// Discard all page evidence on every return path, including late errors.
		result = browserBudgetFailure(page, proxy.PayloadBudgetExceeded(), ctx.Err() != nil)
		if result.Error != "" {
			log.Printf("Juicer: %s", result.Error)
		}
	}()
	pageAllocCtx, pageAllocCancel := egressproxy.NewChromeAllocator(allocCtx, proxy.Address())
	defer pageAllocCancel()

	// Create a new browser tab context with timeout
	browserCtx, cancelBrowserContext := chromedp.NewContext(pageAllocCtx)
	browserCancel := onceBrowserCancel(cancelBrowserContext)
	defer browserCancel()

	go func() {
		select {
		case <-pageCtx.Done():
			browserCancel()
		case <-proxy.Done():
			if proxy.BudgetExceeded() || pageCtx.Err() != nil {
				browserCancel()
			}
		case <-browserCtx.Done():
		}
	}()

	pageDeadline, _ := pageCtx.Deadline()
	tabCtx, timeoutCancel := context.WithDeadline(browserCtx, pageDeadline)
	defer timeoutCancel()
	navigation := &pageNavigationGuard{submitted: page.URL}
	chromedp.ListenTarget(tabCtx, navigation.observe)
	frameTopology := &frameTopologyTracker{}
	frameTopology.watchTarget(tabCtx)
	frameTopology.watchBrowser(tabCtx)

	var screenshot []byte

	// Navigate to the page
	err = chromedp.Run(tabCtx,
		chromedp.EmulateViewport(int64(scanViewport.Width), int64(scanViewport.Height)),
		chromedp.Navigate(page.URL),
		chromedp.WaitReady("body"),
	)
	if err != nil {
		if shouldTreatAsCanceled(ctx, err) {
			result.Canceled = true
			return result
		}

		message := log.Sprintf("failed to navigate to %s: %v", page.URL, err)
		if blocked := proxy.DeniedCount(); blocked > 0 {
			message += fmt.Sprintf("; browser network safety policy blocked %d request(s)", blocked)
		}
		result.Error = log.Text(message)
		log.Printf("Juicer: %s", result.Error)
		return result
	}

	if err := waitForPageSettle(tabCtx); err != nil {
		if shouldTreatAsCanceled(ctx, err) {
			result.Canceled = true
			return result
		}

		log.Printf("Juicer: warning: page settle before axe timed out for %s: %v", page.URL, err)
	}
	if err := verifyPageAuthority(tabCtx, navigation); err != nil {
		if shouldTreatAsCanceled(ctx, err) {
			result.Canceled = true
			return result
		}
		result.Error = log.Sprintf("failed to verify page destination for %s: %v", page.URL, err)
		log.Printf("Juicer: %s", result.Error)
		return result
	}
	frameRevision := frameTopology.revision.Load()
	// The page can define or replace window.axe in its own JavaScript world.
	// Keep the audit engine and its result serializer in a Chrome-isolated world
	// that shares the DOM but not page-owned globals.
	worldEvents := make(chan *runtime.ExecutionContextDescription, 128)
	chromedp.ListenTarget(tabCtx, func(event any) {
		created, ok := event.(*runtime.EventExecutionContextCreated)
		if !ok || created.Context == nil || created.Context.Name != "lime-axe" {
			return
		}
		select {
		case worldEvents <- created.Context:
		default:
		}
	})
	var axeContextID runtime.ExecutionContextID
	err = chromedp.Run(tabCtx, chromedp.ActionFunc(func(actionCtx context.Context) error {
		frameTree, err := cdppage.GetFrameTree().Do(actionCtx)
		if err != nil {
			return err
		}
		if frameTree == nil || frameTree.Frame == nil {
			return errors.New("main frame is unavailable")
		}
		axeContextID, err = cdppage.CreateIsolatedWorld(frameTree.Frame.ID).WithWorldName("lime-axe").Do(actionCtx)
		if err != nil {
			return err
		}
		if axeContextID == 0 {
			return errors.New("isolated axe execution context is unavailable")
		}
		return nil
	}))
	if err != nil {
		if shouldTreatAsCanceled(ctx, err) {
			result.Canceled = true
			return result
		}
		result.Error = log.Sprintf("failed to isolate accessibility audit on %s: %v", page.URL, err)
		log.Printf("Juicer: %s", result.Error)
		return result
	}
	var axeUniqueContextID string
	select {
	case world := <-worldEvents:
		if world.ID != axeContextID || world.UniqueID == "" {
			result.Error = "isolated accessibility audit context changed during setup"
			return result
		}
		axeUniqueContextID = world.UniqueID
	case <-tabCtx.Done():
		if shouldTreatAsCanceled(ctx, tabCtx.Err()) {
			result.Canceled = true
			return result
		}
		result.Error = "timed out waiting for isolated accessibility audit context"
		return result
	}

	// Inject axe-core
	err = chromedp.Run(tabCtx,
		chromedp.Evaluate(axeMinJS, nil, func(ep *runtime.EvaluateParams) *runtime.EvaluateParams {
			return ep.WithUniqueContextID(axeUniqueContextID)
		}),
	)
	if err != nil {
		if shouldTreatAsCanceled(ctx, err) {
			result.Canceled = true
			return result
		}

		result.Error = log.Sprintf("failed to inject axe-core on %s: %v", page.URL, err)
		log.Printf("Juicer: %s", result.Error)
		return result
	}

	axeRunScript, err := lighthouseAxeRunScript()
	if err != nil {
		result.Error = log.Sprintf("failed to prepare accessibility script for %s: %v", page.URL, err)
		log.Printf("Juicer: %s", result.Error)
		return result
	}

	// Run axe-core using Lighthouse-style accessibility configuration and get results as a JSON string.
	var axeResultJSON string
	err = chromedp.Run(tabCtx,
		chromedp.Evaluate(axeRunScript, &axeResultJSON, func(ep *runtime.EvaluateParams) *runtime.EvaluateParams {
			return ep.WithUniqueContextID(axeUniqueContextID).WithAwaitPromise(true)
		}),
	)
	if err != nil {
		if shouldTreatAsCanceled(ctx, err) {
			result.Canceled = true
			return result
		}

		result.Error = log.Sprintf("failed to run axe-core on %s: %v", page.URL, err)
		log.Printf("Juicer: %s", result.Error)
		return result
	}
	// Parse axe results
	var axeRes axeResult
	if err := json.Unmarshal([]byte(axeResultJSON), &axeRes); err != nil {
		result.Error = log.Sprintf("failed to parse axe results for %s: %v", page.URL, err)
		log.Printf("Juicer: %s", result.Error)
		return result
	}
	if axeRes.LimitError != "" {
		result.Error = log.Sprintf("accessibility evidence limit exceeded for %s: %s", page.URL, axeRes.LimitError)
		log.Printf("Juicer: %s", result.Error)
		return result
	}
	if err := auditChildFrames(tabCtx, axeContextID, worldEvents, axeRunScript, len(axeResultJSON), &axeRes, frameTopology); err != nil {
		result.Error = log.Sprintf("failed to audit isolated child frames for %s: %v", page.URL, err)
		return result
	}
	if frameTopology.revision.Load() != frameRevision {
		result.Error = "accessibility frame tree changed during audit"
		return result
	}
	combinedAxeJSON, err := json.Marshal(axeRes)
	ruleCount := len(axeRes.Violations) + len(axeRes.Incomplete) + len(axeRes.Passes) + len(axeRes.NotApplicable)
	nodeCount := 0
	for _, rule := range axeRes.Violations {
		nodeCount += len(rule.Nodes)
	}
	for _, rule := range axeRes.Incomplete {
		nodeCount += len(rule.Nodes)
	}
	if err != nil || ruleCount > maxAxeRules || nodeCount > maxAxeNodes || len(combinedAxeJSON) > maxPageAxeResultBytes || !budget.reserveAxeResult(len(combinedAxeJSON)) {
		result.Error = "accessibility evidence exceeded the page or scan result budget"
		return result
	}
	result.axeBytes = len(combinedAxeJSON)
	result.Violations = axeRes.Violations
	result.Incomplete = axeRes.Incomplete
	result.NotApplicable = axeRes.NotApplicable
	result.Passes = axeRes.Passes
	result.Version = axeRes.Version
	if proxy.BudgetExceeded() {
		return result
	}

	captureNodeScreenshots := true
	if err := assignCaptureIndices(tabCtx, result.Violations); err != nil {
		log.Printf("Juicer: warning: failed to assign exact capture indices for %s: %v", page.URL, err)
		captureNodeScreenshots = !errors.Is(err, errCaptureCandidateBudget)
	}
	if captureNodeScreenshots {
		if err := assignCaptureIndices(tabCtx, result.Incomplete); err != nil {
			log.Printf("Juicer: warning: failed to assign exact capture indices for incomplete results on %s: %v", page.URL, err)
			captureNodeScreenshots = !errors.Is(err, errCaptureCandidateBudget)
		}
	}

	if err := waitForPageSettle(tabCtx); err != nil {
		if shouldTreatAsCanceled(ctx, err) {
			result.Canceled = true
			return result
		}

		log.Printf("Juicer: warning: page settle before screenshots timed out for %s: %v", page.URL, err)
	}
	if err := verifyPageAuthority(tabCtx, navigation); err != nil {
		if shouldTreatAsCanceled(ctx, err) {
			result.Canceled = true
			return result
		}
		result.Error = log.Sprintf("failed to verify page destination for %s: %v", page.URL, err)
		log.Printf("Juicer: %s", result.Error)
		return result
	}

	// Keep this page's files out of the screenshot route until the final
	// browser-frame check. A redirect during capture must not expose another
	// site's image under the submitted URL ID.
	captureDir, captureErr := os.MkdirTemp(screenshotDir, ".pending-")
	if captureErr != nil {
		log.Printf("Juicer: warning: screenshots unavailable for %s: %v", page.URL, captureErr)
	}

	// Take element-level screenshots BEFORE the full-page screenshot
	// (FullScreenshot changes the viewport/device metrics and can break subsequent element screenshots)
	// Use CDP Page.CaptureScreenshot with clip for reliable element capture
	nodeIdx := 0
	pageBudget := &pageScreenshotBudget{}
	committingScreenshots := false
	defer func() {
		if captureErr == nil {
			_ = os.RemoveAll(captureDir)
		}
		if !committingScreenshots {
			budget.releasePageScreenshots(pageBudget)
		}
	}()
	if captureErr != nil {
		pageBudget.exhausted = true
		captureNodeScreenshots = false
	}
	fullPageReservation := fullPageScreenshotReservation{}
	if captureErr == nil {
		fullPageReservation = budget.reserveFullPageScreenshot(pageBudget)
	}
	defer func() {
		if fullPageReservation.active {
			budget.settleFullPageScreenshot(pageBudget, &fullPageReservation, 0)
		}
	}()
	nodeIdx = captureViolationNodeScreenshots(tabCtx, result.Violations, scanID, captureDir, page, nodeIdx, budget, pageBudget, captureNodeScreenshots)
	nodeIdx = captureViolationNodeScreenshots(tabCtx, result.Incomplete, scanID, captureDir, page, nodeIdx, budget, pageBudget, captureNodeScreenshots)

	// Take a full-page screenshot (last, since it alters viewport metrics)
	fullPageBudgetOmitted := false
	if fullPageReservation.active || budget.canCaptureScreenshot(pageBudget) {
		screenshot, err = captureFullPage(tabCtx)
	} else {
		err = fmt.Errorf("screenshot budget reached")
		fullPageBudgetOmitted = true
	}
	if err != nil {
		if shouldTreatAsCanceled(ctx, err) {
			result.Canceled = true
			return result
		}

		log.Printf("Juicer: warning: failed to take screenshot of %s: %v", page.URL, err)
		if fullPageBudgetOmitted || errors.Is(err, errFullPagePixelBudget) {
			markFullPageScreenshotOmitted(&result, fullPageScreenshotBudgetWarning)
		} else if errors.Is(err, errFullPageLayoutChanged) {
			markFullPageScreenshotOmitted(&result, fullPageScreenshotChangedWarning)
		}
	} else if len(screenshot) > 0 {
		filename := page.URLID + ".png"
		screenshotPath := filepath.Join(captureDir, filename)
		admitted := false
		if fullPageReservation.active {
			admitted = budget.settleFullPageScreenshot(pageBudget, &fullPageReservation, len(screenshot))
		} else {
			admitted = budget.reserveScreenshot(pageBudget, len(screenshot))
		}
		if !admitted {
			log.Printf("Juicer: warning: full-page screenshot exceeded evidence budget for %s", page.URL)
			markFullPageScreenshotOmitted(&result, fullPageScreenshotBudgetWarning)
		} else if err := writeReservedScreenshot(screenshotPath, screenshot, budget, pageBudget); err != nil {
			log.Printf("Juicer: warning: failed to save screenshot for %s: %v", page.URL, err)
		} else {
			result.ScreenshotPath = screenshots.StoredPath(scanID, filename)
		}
	}
	if err := verifyPageAuthority(tabCtx, navigation); err != nil {
		if shouldTreatAsCanceled(ctx, err) {
			result.Canceled = true
			return result
		}
		result.Error = log.Sprintf("failed to verify page destination for %s: %v", page.URL, err)
		log.Printf("Juicer: %s", result.Error)
		return result
	}
	// No browser work remains. Closing the proxy waits for every accepted
	// connection, so no late budget hit can arrive after screenshots publish.
	if err := proxy.Close(); err != nil {
		result.Error = log.Sprintf("failed to close browser egress for %s: %v", page.URL, err)
		log.Printf("Juicer: %s", result.Error)
		return result
	}
	if proxy.BudgetExceeded() {
		return result
	}
	if ctx.Err() != nil {
		result.Canceled = true
		return result
	}
	if frameTopology.revision.Load() != frameRevision {
		budget.releaseUncheckpointedAxeResult(result.axeBytes)
		result = RawResult{URLID: page.URLID, URL: page.URL, Error: "accessibility frame tree changed during audit"}
		return result
	}
	if captureErr == nil {
		published, err := publishPageScreenshots(captureDir, screenshotDir, pageBudget.staged)
		budget.reconcilePublishedScreenshots(pageBudget, published)
		committingScreenshots = true
		if err != nil {
			result.Error = log.Sprintf("failed to save screenshots for %s: %v", page.URL, err)
			log.Printf("Juicer: %s", result.Error)
			return result
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

func browserBudgetFailure(page PageInput, payloadExceeded, canceled bool) RawResult {
	result := RawResult{URLID: page.URLID, URL: page.URL, Canceled: canceled}
	if canceled {
		return result
	}
	if payloadExceeded {
		result.Error = log.Sprintf("browser network transfer limit exceeded for %s", page.URL)
	} else {
		result.Error = log.Sprintf("browser connection budget exceeded for %s", page.URL)
	}
	return result
}

// A page can fetch public cross-origin assets, but evidence belongs only to
// the submitted host and effective port. Profiler uses the same authority
// boundary, which permits ordinary same-host HTTP-to-HTTPS redirects.
func samePageAuthority(submitted, final string) bool {
	first, err := url.Parse(submitted)
	if err != nil || (!strings.EqualFold(first.Scheme, "http") && !strings.EqualFold(first.Scheme, "https")) || first.Hostname() == "" {
		return false
	}
	last, err := url.Parse(final)
	if err != nil || (!strings.EqualFold(last.Scheme, "http") && !strings.EqualFold(last.Scheme, "https")) || last.Hostname() == "" {
		return false
	}
	firstAuthority, firstOK := pageAuthority(first)
	lastAuthority, lastOK := pageAuthority(last)
	return firstOK && lastOK && firstAuthority == lastAuthority
}

func pageAuthority(u *url.URL) (string, bool) {
	host := u.Hostname()
	if ip, err := netip.ParseAddr(host); err == nil {
		host = ip.Unmap().String()
	} else {
		ascii, err := idna.Lookup.ToASCII(strings.TrimSuffix(strings.ToLower(host), "."))
		if err != nil || ascii == "" || strings.ContainsAny(ascii, " /\\:@") {
			return "", false
		}
		host = strings.ToLower(ascii)
	}
	defaultPort := uint64(80)
	if strings.EqualFold(u.Scheme, "https") {
		defaultPort = 443
	}
	port := defaultPort
	if u.Port() != "" {
		parsed, err := strconv.ParseUint(u.Port(), 10, 16)
		if err != nil || parsed == 0 {
			return "", false
		}
		port = parsed
	}
	if port == defaultPort {
		return host, true
	}
	return net.JoinHostPort(host, strconv.FormatUint(port, 10)), true
}

type pageNavigationGuard struct {
	submitted   string
	seenAllowed atomic.Bool
	escaped     atomic.Bool
}

func (g *pageNavigationGuard) observe(event any) {
	navigation, ok := event.(*cdppage.EventFrameNavigated)
	if !ok || navigation.Frame == nil || navigation.Frame.ParentID != "" {
		return
	}
	final := navigation.Frame.URL
	if final == "about:blank" && !g.seenAllowed.Load() {
		return
	}
	if samePageAuthority(g.submitted, final) {
		g.seenAllowed.Store(true)
	} else {
		g.escaped.Store(true)
	}
}

func verifyPageAuthority(ctx context.Context, guard *pageNavigationGuard) error {
	if guard.escaped.Load() {
		return errors.New("page navigated outside the submitted host or port")
	}
	var final string
	if err := chromedp.Run(ctx, chromedp.ActionFunc(func(ctx context.Context) error {
		frameTree, err := cdppage.GetFrameTree().Do(ctx)
		if err != nil {
			return err
		}
		if frameTree == nil || frameTree.Frame == nil {
			return errors.New("missing top-level browser frame")
		}
		final = frameTree.Frame.URL
		return nil
	})); err != nil {
		return err
	}
	if guard.escaped.Load() || !samePageAuthority(guard.submitted, final) {
		return errors.New("page navigated outside the submitted host or port")
	}
	return nil
}

type publishedScreenshot struct {
	name            string
	replacedRegular bool
	replacedBytes   int64
}

func writeReservedScreenshot(path string, data []byte, budget *scanEvidenceBudget, page *pageScreenshotBudget) error {
	name := filepath.Base(path)
	if _, exists := page.staged[name]; exists {
		budget.releaseScreenshot(page, len(data))
		return fmt.Errorf("duplicate staged screenshot %q", name)
	}
	if err := screenshots.WriteFile(path, data); err != nil {
		budget.releaseScreenshot(page, len(data))
		_ = os.Remove(path)
		return err
	}
	if page.staged == nil {
		page.staged = make(map[string]int64)
	}
	page.staged[name] = int64(len(data))
	return nil
}

func publishPageScreenshots(captureDir, screenshotDir string, staged map[string]int64) ([]publishedScreenshot, error) {
	files, err := os.ReadDir(captureDir)
	if err != nil {
		return nil, err
	}
	published := make([]publishedScreenshot, 0, len(files))
	for _, file := range files {
		if !file.Type().IsRegular() {
			return published, fmt.Errorf("unexpected screenshot staging entry %q", file.Name())
		}
		if _, admitted := staged[file.Name()]; !admitted {
			return published, fmt.Errorf("unreserved screenshot staging entry %q", file.Name())
		}
		destination := filepath.Join(screenshotDir, file.Name())
		prior, err := os.Lstat(destination)
		if err != nil && !os.IsNotExist(err) {
			return published, err
		}
		if err := os.Rename(filepath.Join(captureDir, file.Name()), destination); err != nil {
			return published, err
		}
		replacement := publishedScreenshot{name: file.Name()}
		if err == nil && prior.Mode().IsRegular() {
			replacement.replacedRegular = true
			replacement.replacedBytes = prior.Size()
		}
		published = append(published, replacement)
	}
	return published, nil
}

func shouldTreatAsCanceled(ctx context.Context, err error) bool {
	// ctx is the parent scan run, not the per-page timeout. Chromium startup
	// errors can lose the cancellation cause when the browser is terminated.
	// Any unfinished operation error after a run cancellation must leave the
	// page pending for resume, while successful results remain valid.
	return err != nil && ctx.Err() != nil
}

func captureViolationNodeScreenshots(ctx context.Context, violations []Violation, scanID, screenshotDir string, page PageInput, startIndex int, budget *scanEvidenceBudget, pageBudget *pageScreenshotBudget, captureAllowed bool) int {
	nodeIdx := startIndex

	for vi := range violations {
		for ni := range violations[vi].Nodes {
			node := &violations[vi].Nodes[ni]
			if len(node.Target) == 0 {
				nodeIdx++
				continue
			}
			if node.CaptureSuppressed && len(node.Target) > 1 {
				// A top-frame screenshot of this selector would mark the iframe,
				// not the affected element inside it.
				if !strings.Contains(node.HTML, frameScreenshotWarning) {
					node.HTML += "\n" + frameScreenshotWarning
				}
				nodeIdx++
				continue
			}
			if !captureAllowed || node.CaptureSuppressed {
				markScreenshotOmitted(node)
				nodeIdx++
				continue
			}
			if !budget.canCaptureScreenshot(pageBudget) {
				markScreenshotOmitted(node)
				nodeIdx++
				continue
			}

			locator := captureLocatorForNode(*node)
			selector := locator.Selector

			bounds, err := prepareElementForCapture(ctx, locator)
			if err != nil || !bounds.Visible || bounds.Width == 0 || bounds.Height == 0 {
				if err != nil {
					log.Printf("Juicer: warning: failed to get bounds for %q: %v", selector, err)
				}
				nodeIdx++
				continue
			}

			elemScreenshot, previewScreenshot, err := captureHighlightedScreenshots(ctx, locator, bounds)
			if err != nil {
				log.Printf("Juicer: warning: failed to screenshot element %q on %s: %v", selector, page.URL, err)
				nodeIdx++
				continue
			}

			if len(elemScreenshot) >= elementScreenshotMinByteSize {
				filename := fmt.Sprintf("%s_focus_%d.png", page.URLID, nodeIdx)
				elemPath := filepath.Join(screenshotDir, filename)
				if !budget.reserveScreenshot(pageBudget, len(elemScreenshot)) {
					markScreenshotOmitted(node)
				} else if err := writeReservedScreenshot(elemPath, elemScreenshot, budget, pageBudget); err != nil {
					log.Printf("Juicer: warning: failed to save element screenshot: %v", err)
				} else {
					node.ElementScreenshotPath = screenshots.StoredPath(scanID, filename)

					if len(previewScreenshot) >= elementScreenshotMinByteSize {
						if !budget.reserveScreenshot(pageBudget, len(previewScreenshot)) {
							markScreenshotOmitted(node)
						} else if err := writeReservedScreenshot(focusedPreviewPath(elemPath), previewScreenshot, budget, pageBudget); err != nil {
							log.Printf("Juicer: warning: failed to save preview screenshot: %v", err)
						}
					}
				}
			}

			nodeIdx++
		}
	}

	return nodeIdx
}

func markScreenshotOmitted(node *Node) {
	if strings.Contains(node.HTML, screenshotBudgetWarning) {
		return
	}
	node.HTML += "\n" + screenshotBudgetWarning
}

func markFullPageScreenshotOmitted(result *RawResult, warning string) {
	for _, group := range [][]Violation{result.Violations, result.Incomplete} {
		for vi := range group {
			if len(group[vi].Nodes) == 0 {
				continue
			}
			node := &group[vi].Nodes[0]
			if !strings.Contains(node.HTML, warning) {
				node.HTML += "\n" + warning
			}
			return
		}
	}
}

// auditChildFrames avoids axe's postMessage frame transport: page-owned axe in a
// child can otherwise answer the isolated top world's audit request.
func auditChildFrames(ctx context.Context, topContextID runtime.ExecutionContextID, worldEvents <-chan *runtime.ExecutionContextDescription, runScript string, initialRawBytes int, combined *axeResult, tracker *frameTopologyTracker) error {
	usedRawBytes := initialRawBytes
	if usedRawBytes > maxPageAxeResultBytes {
		return errors.New("accessibility result exceeds the page budget")
	}
	if err := auditSameProcessFrames(ctx, topContextID, worldEvents, runScript, &usedRawBytes, nil, combined); err != nil {
		return err
	}
	return auditOOPIFFrames(ctx, topContextID, runScript, &usedRawBytes, combined, tracker)
}

func auditSameProcessFrames(ctx context.Context, topContextID runtime.ExecutionContextID, worldEvents <-chan *runtime.ExecutionContextDescription, runScript string, usedRawBytes *int, rootPrefix []string, combined *axeResult) error {
	var tree *cdppage.FrameTree
	if err := chromedp.Run(ctx, chromedp.ActionFunc(func(actionCtx context.Context) error {
		var err error
		tree, err = cdppage.GetFrameTree().Do(actionCtx)
		return err
	})); err != nil {
		return err
	}
	if tree == nil || tree.Frame == nil {
		return errors.New("main frame is unavailable")
	}
	type pendingFrame struct {
		frame  *cdppage.FrameTree
		prefix []string
	}
	contexts := map[cdp.FrameID]runtime.ExecutionContextID{tree.Frame.ID: topContextID}
	queue := make([]pendingFrame, 0, len(tree.ChildFrames))
	for _, child := range tree.ChildFrames {
		queue = append(queue, pendingFrame{frame: child, prefix: rootPrefix})
	}
	if len(queue) > 64 {
		return errors.New("too many accessibility frames")
	}
	processed := 0
	for len(queue) > 0 {
		processed++
		if processed > 64 {
			return errors.New("too many accessibility frames")
		}
		item := queue[0]
		queue = queue[1:]
		if item.frame == nil || item.frame.Frame == nil {
			return errors.New("child frame is unavailable")
		}
		frame := item.frame.Frame
		parentContextID, ok := contexts[frame.ParentID]
		if !ok {
			return errors.New("child frame parent is unavailable")
		}
		var selector string
		var contextID runtime.ExecutionContextID
		if err := chromedp.Run(ctx, chromedp.ActionFunc(func(actionCtx context.Context) error {
			backendID, _, err := cdpdom.GetFrameOwner(frame.ID).Do(actionCtx)
			if err != nil {
				return err
			}
			owner, err := cdpdom.ResolveNode().WithBackendNodeID(backendID).WithExecutionContextID(parentContextID).Do(actionCtx)
			if err != nil || owner == nil || owner.ObjectID == "" {
				return fmt.Errorf("resolve child frame owner: %v", err)
			}
			value, exception, err := runtime.CallFunctionOn(`function () {
				const doc = this.ownerDocument;
				const parts = [];
				for (let element = this; element && element.nodeType === 1; element = element.parentElement) {
					if (element.id) {
						const byId = '#' + CSS.escape(element.id);
						if (doc.querySelectorAll(byId).length === 1) {
							parts.unshift(byId);
							return parts.join(' > ');
						}
					}
					const tag = element.localName;
					const siblings = element.parentElement ? Array.from(element.parentElement.children).filter(child => child.localName === tag) : [];
					parts.unshift(siblings.length > 1 ? tag + ':nth-of-type(' + (siblings.indexOf(element) + 1) + ')' : tag);
					const candidate = parts.join(' > ');
					if (doc.querySelectorAll(candidate).length === 1) return candidate;
				}
				return parts.join(' > ');
			}`).WithObjectID(owner.ObjectID).WithReturnByValue(true).Do(actionCtx)
			if err != nil || exception != nil || value == nil {
				return fmt.Errorf("select child frame owner: %v, exception: %+v", err, exception)
			}
			if err := json.Unmarshal(value.Value, &selector); err != nil || selector == "" {
				return fmt.Errorf("decode child frame selector: %v", err)
			}
			if len(selector) > maxAxeSelectorChars {
				return errors.New("child frame selector exceeds accessibility evidence limit")
			}
			contextID, err = cdppage.CreateIsolatedWorld(frame.ID).WithWorldName("lime-axe").Do(actionCtx)
			return err
		})); err != nil {
			return err
		}
		if contextID == 0 {
			return errors.New("isolated child axe context is unavailable")
		}
		var uniqueID string
		for uniqueID == "" {
			select {
			case world := <-worldEvents:
				if world != nil && world.ID == contextID {
					uniqueID = world.UniqueID
				}
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		contexts[frame.ID] = contextID
		if err := chromedp.Run(ctx,
			chromedp.Evaluate(axeMinJS, nil, func(p *runtime.EvaluateParams) *runtime.EvaluateParams { return p.WithUniqueContextID(uniqueID) }),
		); err != nil {
			return err
		}
		var raw string
		if err := chromedp.Run(ctx,
			chromedp.Evaluate(runScript, &raw, func(p *runtime.EvaluateParams) *runtime.EvaluateParams {
				return p.WithUniqueContextID(uniqueID).WithAwaitPromise(true)
			}),
		); err != nil {
			return err
		}
		if len(raw) > maxPageAxeResultBytes-*usedRawBytes {
			return errors.New("child accessibility result exceeds the page budget")
		}
		*usedRawBytes += len(raw)
		var childResult axeResult
		if err := json.Unmarshal([]byte(raw), &childResult); err != nil {
			return err
		}
		if childResult.LimitError != "" {
			return fmt.Errorf("child accessibility evidence limit exceeded: %s", childResult.LimitError)
		}
		_, combinedNodes := axeEvidenceCounts(*combined)
		_, childNodes := axeEvidenceCounts(childResult)
		if mergedAxeRuleCount(*combined, childResult) > maxAxeRules || combinedNodes+childNodes > maxAxeNodes {
			return errors.New("child accessibility rules or nodes exceed the page budget")
		}
		prefix := append(append([]string(nil), item.prefix...), selector)
		if len(prefix) >= maxAxeTargetParts {
			return errors.New("child frame depth exceeds accessibility target limit")
		}
		prefixAxeTargets(&childResult, prefix)
		if !validAxeTargets(childResult) {
			return errors.New("child accessibility target exceeds the evidence limit")
		}
		mergeAxeResults(combined, childResult)
		if len(queue)+len(item.frame.ChildFrames) > 64 {
			return errors.New("too many accessibility frames")
		}
		for _, child := range item.frame.ChildFrames {
			queue = append(queue, pendingFrame{frame: child, prefix: prefix})
		}
	}
	return nil
}

func auditOOPIFFrames(ctx context.Context, topContextID runtime.ExecutionContextID, runScript string, usedRawBytes *int, combined *axeResult, tracker *frameTopologyTracker) error {
	var infos []*cdptarget.Info
	if err := chromedp.Run(ctx, chromedp.ActionFunc(func(actionCtx context.Context) error {
		var err error
		infos, err = cdptarget.GetTargets().Do(cdp.WithExecutor(actionCtx, chromedp.FromContext(actionCtx).Browser))
		return err
	})); err != nil {
		return err
	}
	return auditOOPIFTargets(ctx, topContextID, runScript, usedRawBytes, combined, infos, tracker)
}

func auditOOPIFTargets(ctx context.Context, topContextID runtime.ExecutionContextID, runScript string, usedRawBytes *int, combined *axeResult, infos []*cdptarget.Info, tracker *frameTopologyTracker) error {
	type frameAuditParent struct {
		ctx       context.Context
		contextID runtime.ExecutionContextID
		prefix    []string
	}
	parents := []frameAuditParent{{ctx: ctx, contextID: topContextID}}
	pending := make([]*cdptarget.Info, 0, len(infos))
	for _, info := range infos {
		if info != nil && info.Type == "iframe" {
			pending = append(pending, info)
		}
	}
	if len(pending) > 64 {
		return errors.New("too many out-of-process accessibility frames")
	}
	for len(pending) > 0 {
		unresolved := make([]*cdptarget.Info, 0)
		progress := false
		for _, info := range pending {
			var selector string
			var parentPrefix []string
			var ownerErr error
			for i := len(parents) - 1; i >= 0; i-- {
				parent := parents[i]
				lookupCtx, cancelLookup := context.WithTimeout(parent.ctx, 2*time.Second)
				ownerErr = chromedp.Run(lookupCtx, chromedp.ActionFunc(func(actionCtx context.Context) error {
					backendID, _, err := cdpdom.GetFrameOwner(cdp.FrameID(info.TargetID)).Do(actionCtx)
					if err != nil {
						return err
					}
					owner, err := cdpdom.ResolveNode().WithBackendNodeID(backendID).WithExecutionContextID(parent.contextID).Do(actionCtx)
					if err != nil || owner == nil || owner.ObjectID == "" {
						return fmt.Errorf("resolve out-of-process frame owner: %v", err)
					}
					value, exception, err := runtime.CallFunctionOn(`function () {
				const doc = this.ownerDocument;
				const parts = [];
				for (let element = this; element && element.nodeType === 1; element = element.parentElement) {
					if (element.id) {
						const byId = '#' + CSS.escape(element.id);
						if (doc.querySelectorAll(byId).length === 1) { parts.unshift(byId); return parts.join(' > '); }
					}
					const tag = element.localName;
					const siblings = element.parentElement ? Array.from(element.parentElement.children).filter(child => child.localName === tag) : [];
					parts.unshift(siblings.length > 1 ? tag + ':nth-of-type(' + (siblings.indexOf(element) + 1) + ')' : tag);
					const candidate = parts.join(' > ');
					if (doc.querySelectorAll(candidate).length === 1) return candidate;
				}
				return parts.join(' > ');
			}`).WithObjectID(owner.ObjectID).WithReturnByValue(true).Do(actionCtx)
					if err != nil || exception != nil || value == nil {
						return fmt.Errorf("select out-of-process frame owner: %v, exception: %+v", err, exception)
					}
					if err := json.Unmarshal(value.Value, &selector); err != nil || selector == "" {
						return fmt.Errorf("decode out-of-process frame selector: %v", err)
					}
					if len(selector) > maxAxeSelectorChars {
						return errors.New("out-of-process frame selector exceeds accessibility evidence limit")
					}
					return nil
				}))
				cancelLookup()
				if ownerErr == nil {
					parentPrefix = parent.prefix
					break
				}
			}
			if ownerErr != nil {
				unresolved = append(unresolved, info)
				continue
			}
			prefix := append(append([]string(nil), parentPrefix...), selector)
			if len(prefix) >= maxAxeTargetParts {
				return errors.New("out-of-process frame depth exceeds accessibility target limit")
			}
			frameCtx, cancel := chromedp.NewContext(ctx, chromedp.WithTargetID(info.TargetID))
			// Keep this target attached until the page context closes. Detaching
			// it mid-scan can emit frame removal events unrelated to page DOM.
			if tracker != nil {
				tracker.watchTarget(frameCtx)
			}
			frameEvents := make(chan *runtime.ExecutionContextDescription, 8)
			chromedp.ListenTarget(frameCtx, func(event any) {
				created, ok := event.(*runtime.EventExecutionContextCreated)
				if ok && created.Context != nil && created.Context.Name == "lime-axe" {
					select {
					case frameEvents <- created.Context:
					default:
					}
				}
			})
			var contextID runtime.ExecutionContextID
			err := chromedp.Run(frameCtx, chromedp.ActionFunc(func(actionCtx context.Context) error {
				tree, err := cdppage.GetFrameTree().Do(actionCtx)
				if err != nil || tree == nil || tree.Frame == nil {
					return fmt.Errorf("out-of-process frame tree: %v", err)
				}
				contextID, err = cdppage.CreateIsolatedWorld(tree.Frame.ID).WithWorldName("lime-axe").Do(actionCtx)
				return err
			}))
			if err != nil {
				cancel()
				return err
			}
			var uniqueID string
			for uniqueID == "" {
				select {
				case world := <-frameEvents:
					if world != nil && world.ID == contextID {
						uniqueID = world.UniqueID
					}
				case <-ctx.Done():
					cancel()
					return ctx.Err()
				}
			}
			var raw string
			err = chromedp.Run(frameCtx,
				chromedp.Evaluate(axeMinJS, nil, func(p *runtime.EvaluateParams) *runtime.EvaluateParams { return p.WithUniqueContextID(uniqueID) }),
				chromedp.Evaluate(runScript, &raw, func(p *runtime.EvaluateParams) *runtime.EvaluateParams {
					return p.WithUniqueContextID(uniqueID).WithAwaitPromise(true)
				}),
			)
			if err != nil {
				return err
			}
			if len(raw) > maxPageAxeResultBytes-*usedRawBytes {
				return errors.New("out-of-process accessibility result exceeds the page budget")
			}
			*usedRawBytes += len(raw)
			var childResult axeResult
			if err := json.Unmarshal([]byte(raw), &childResult); err != nil {
				return err
			}
			if childResult.LimitError != "" {
				return fmt.Errorf("out-of-process accessibility evidence limit exceeded: %s", childResult.LimitError)
			}
			_, combinedNodes := axeEvidenceCounts(*combined)
			_, childNodes := axeEvidenceCounts(childResult)
			if mergedAxeRuleCount(*combined, childResult) > maxAxeRules || combinedNodes+childNodes > maxAxeNodes {
				return errors.New("out-of-process accessibility rules or nodes exceed the page budget")
			}
			prefixAxeTargets(&childResult, prefix)
			if !validAxeTargets(childResult) {
				return errors.New("out-of-process accessibility target exceeds the evidence limit")
			}
			mergeAxeResults(combined, childResult)
			if err := auditSameProcessFrames(frameCtx, contextID, frameEvents, runScript, usedRawBytes, prefix, combined); err != nil {
				return err
			}
			parents = append(parents, frameAuditParent{ctx: frameCtx, contextID: contextID, prefix: prefix})
			progress = true
		}
		if !progress {
			return errors.New("out-of-process frame parent could not be resolved")
		}
		pending = unresolved
	}
	return nil
}

func prefixAxeTargets(result *axeResult, prefix []string) {
	for _, rules := range [][]Violation{result.Violations, result.Incomplete} {
		for ri := range rules {
			for ni := range rules[ri].Nodes {
				node := &rules[ri].Nodes[ni]
				node.Target = append(append([]string(nil), prefix...), node.Target...)
				node.CaptureSuppressed = true
				for related := range node.RelatedNodes {
					node.RelatedNodes[related].Target = append(append([]string(nil), prefix...), node.RelatedNodes[related].Target...)
				}
			}
		}
	}
}

func validAxeTargets(result axeResult) bool {
	for _, rules := range [][]Violation{result.Violations, result.Incomplete} {
		for _, rule := range rules {
			for _, node := range rule.Nodes {
				if len(node.Target) > maxAxeTargetParts {
					return false
				}
				for _, related := range node.RelatedNodes {
					if len(related.Target) > maxAxeTargetParts {
						return false
					}
				}
			}
		}
	}
	return true
}

func axeEvidenceCounts(result axeResult) (rules, nodes int) {
	rules = len(result.Violations) + len(result.Incomplete) + len(result.Passes) + len(result.NotApplicable)
	for _, rule := range result.Violations {
		nodes += len(rule.Nodes)
	}
	for _, rule := range result.Incomplete {
		nodes += len(rule.Nodes)
	}
	return rules, nodes
}

func mergedAxeRuleCount(a, b axeResult) int {
	seen := make(map[string]struct{})
	for _, result := range []axeResult{a, b} {
		for _, rule := range result.Violations {
			seen["violations:"+rule.ID] = struct{}{}
		}
		for _, rule := range result.Incomplete {
			seen["incomplete:"+rule.ID] = struct{}{}
		}
		for _, rule := range result.Passes {
			seen["passes:"+rule.ID] = struct{}{}
		}
		for _, rule := range result.NotApplicable {
			seen["notApplicable:"+rule.ID] = struct{}{}
		}
	}
	return len(seen)
}

func mergeAxeResults(dst *axeResult, src axeResult) {
	mergeRules := func(dstRules *[]Violation, srcRules []Violation) {
		for _, rule := range srcRules {
			found := false
			for i := range *dstRules {
				if (*dstRules)[i].ID == rule.ID {
					(*dstRules)[i].Nodes = append((*dstRules)[i].Nodes, rule.Nodes...)
					found = true
					break
				}
			}
			if !found {
				*dstRules = append(*dstRules, rule)
			}
		}
	}
	mergeRules(&dst.Violations, src.Violations)
	mergeRules(&dst.Incomplete, src.Incomplete)
	addIDs := func(dstIDs *[]RuleID, srcIDs []RuleID) {
		for _, id := range srcIDs {
			found := false
			for _, existing := range *dstIDs {
				if existing.ID == id.ID {
					found = true
					break
				}
			}
			if !found {
				*dstIDs = append(*dstIDs, id)
			}
		}
	}
	addIDs(&dst.Passes, src.Passes)
	addIDs(&dst.NotApplicable, src.NotApplicable)
	active := make(map[string]bool)
	for _, rule := range dst.Violations {
		active[rule.ID] = true
	}
	for _, rule := range dst.Incomplete {
		active[rule.ID] = true
	}
	for _, id := range dst.Passes {
		active[id.ID] = true
	}
	passes := dst.Passes[:0]
	for _, id := range dst.Passes {
		violated := false
		for _, rule := range dst.Violations {
			violated = violated || rule.ID == id.ID
		}
		for _, rule := range dst.Incomplete {
			violated = violated || rule.ID == id.ID
		}
		if !violated {
			passes = append(passes, id)
		}
	}
	dst.Passes = passes
	remaining := dst.NotApplicable[:0]
	for _, id := range dst.NotApplicable {
		if !active[id.ID] {
			remaining = append(remaining, id)
		}
	}
	dst.NotApplicable = remaining
}

func lighthouseAxeRunOptions() axeRunOptions {
	return axeRunOptions{
		ElementRef: true,
		Iframes:    false,
		RunOnly: axeRunOnly{
			Type:   "tag",
			Values: []string{"wcag2a", "wcag2aa"},
		},
		ResultTypes: []string{"violations", "passes", "incomplete", "inapplicable"},
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
		const maxNodes = %d;
		const maxRules = %d;
		const maxHTMLChars = %d;
		const maxSummaryChars = %d;
		const maxSelectorChars = %d;
		const maxTargetParts = %d;
		const maxResultBytes = %d;
		const truncatedMarker = "\n<!-- LIME evidence warning: HTML snippet truncated -->";
		const outerHTMLBudgetWarning = %q;
		%s
		const encoder = new TextEncoder();
		let targetLimitExceeded = false;
		let resultTooLarge = false;
		let serializedNodeBytes = 0;
		const boundedText = (value, limit, marker = "... [truncated]") => {
			const text = typeof value === "string" ? value : "";
			return text.length > limit ? text.slice(0, limit) + marker : text;
		};
		const boundedTarget = (target) => {
			if (!Array.isArray(target)) return [];
			if (target.length > maxTargetParts || target.some((part) => typeof part !== "string" || part.length > maxSelectorChars)) {
				targetLimitExceeded = true;
				return [];
			}
			return target;
		};
		const impactToNumber = (impact) => [null, "minor", "moderate", "serious", "critical"].indexOf(impact);
		const describeElement = (element, fallbackTarget) => {
			let html = "";
			try {
				if (element && !canSerializeOuterHTML(element)) {
					html = outerHTMLBudgetWarning;
				} else {
					html = element ? element.outerHTML || "" : "";
				}
			} catch (_) {}

			return {
				html: boundedText(html, maxHTMLChars, truncatedMarker),
				target: boundedTarget(fallbackTarget),
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
					if (resultTooLarge) return null;
					const element = node.element || null;
					const details = describeElement(element, node.target);
					const serializedNode = {
						html: details.html,
						target: details.target,
						failureSummary: boundedText(node.failureSummary, maxSummaryChars),
						relatedNodes: collectRelatedNodes(node, element),
					};
					serializedNodeBytes += encoder.encode(JSON.stringify(serializedNode)).length;
					if (serializedNodeBytes > maxResultBytes) {
						resultTooLarge = true;
						return null;
					}
					return serializedNode;
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
			const violations = axeResults.violations || [];
			const incomplete = axeResults.incomplete || [];
			const notApplicable = axeResults.inapplicable || [];
			const passes = axeResults.passes || [];
			const ruleCount = violations.length + incomplete.length + notApplicable.length + passes.length;
			const nodeCount = [...violations, ...incomplete].reduce((count, rule) => count + (rule.nodes || []).length, 0);
			if (ruleCount > maxRules || nodeCount > maxNodes) {
				return JSON.stringify({limitError: "too many accessibility rules or affected nodes"});
			}

			const resultObject = {
				violations: violations.map(serializeRuleResult),
				incomplete: incomplete.map(serializeRuleResult),
				notApplicable: notApplicable.map((result) => ({id: result.id})),
				passes: passes.map((result) => ({id: result.id})),
				version: axeResults.testEngine && axeResults.testEngine.version ? axeResults.testEngine.version : "",
			};
			if (targetLimitExceeded || resultTooLarge) {
				return JSON.stringify({limitError: "serialized accessibility evidence is too large"});
			}
			const serialized = JSON.stringify(resultObject);
			if (encoder.encode(serialized).length > maxResultBytes) {
				return JSON.stringify({limitError: "serialized accessibility evidence is too large"});
			}
			return serialized;
		} finally {
			window.scrollTo(originalScrollPosition.x, originalScrollPosition.y);
		}
	})()`, maxAxeNodes, maxAxeRules, maxAxeHTMLChars, maxAxeSummaryChars, maxAxeSelectorChars, maxAxeTargetParts, maxPageAxeResultBytes, outerHTMLBudgetWarning, outerHTMLPreflightScript(), configJSON), nil
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
	assignCaptureIndicesFromCandidates(violations, candidates)
	return nil
}

func assignCaptureIndicesFromCandidates(violations []Violation, candidates map[string][]captureCandidate) {
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
			if node.CaptureSuppressed {
				continue
			}

			selector := strings.TrimSpace(node.Target[0])
			matches, exists := candidates[selector]
			if exists && matches == nil {
				node.CaptureSuppressed = true
				continue
			}
			index, ok := selectCaptureIndex(selector, node.HTML, matches, &state)
			if !ok {
				continue
			}

			node.CaptureIndex = index
			node.HasCaptureIndex = true
		}
	}
}

func uniqueCaptureSelectors(violations []Violation) []string {
	seen := make(map[string]struct{})
	selectors := make([]string, 0)

	for _, violation := range violations {
		for _, node := range violation.Nodes {
			if len(node.Target) == 0 {
				continue
			}
			if node.CaptureSuppressed {
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

	var resultJSON string
	if err := chromedp.Run(ctx, chromedp.Evaluate(captureCandidateScript(payload), &resultJSON)); err != nil {
		return nil, err
	}
	return decodeCaptureCandidates(resultJSON)
}

func captureCandidateScript(payload []byte) string {
	return fmt.Sprintf(`(() => {
		const selectors = %s;
		const maxCandidates = %d;
		const maxHTMLChars = %d;
		const maxResultBytes = %d;
		%s
		const encoder = new TextEncoder();
		const candidates = Object.create(null);
		let estimatedBytes = 0;
		let exhausted = false;
		const limitError = () => JSON.stringify({limitError: "element screenshot matching exceeds the evidence budget"});
		for (const selector of selectors) {
			if (exhausted) {
				candidates[selector] = null;
				continue;
			}
			let nodes;
			try {
				nodes = document.querySelectorAll(selector);
			} catch (_) {
				candidates[selector] = [];
				continue;
			}
			if (nodes.length > maxCandidates) {
				candidates[selector] = null;
				continue;
			}
			const matches = [];
			let selectorBytes = 0;
			let suppressed = false;
			for (let index = 0; index < nodes.length; index++) {
				if (!canSerializeOuterHTML(nodes[index])) {
					suppressed = true;
					break;
				}
				const html = nodes[index].outerHTML || "";
				if (html.length > maxHTMLChars) {
					suppressed = true;
					break;
				}
				selectorBytes += encoder.encode(JSON.stringify({selector, index, html})).length;
				if (estimatedBytes + selectorBytes > maxResultBytes) {
					exhausted = true;
					suppressed = true;
					break;
				}
				matches.push({index, html});
			}
			if (suppressed) {
				candidates[selector] = null;
				continue;
			}
			estimatedBytes += selectorBytes;
			candidates[selector] = matches;
		}
		const result = JSON.stringify({candidates});
		return encoder.encode(result).length > maxResultBytes ? limitError() : result;
	})()`, payload, maxCaptureCandidates, maxCaptureCandidateSize, maxCaptureResultBytes, outerHTMLPreflightScript())
}

func decodeCaptureCandidates(resultJSON string) (map[string][]captureCandidate, error) {
	if len(resultJSON) > maxCaptureResultBytes {
		return nil, errCaptureCandidateBudget
	}
	var result struct {
		Candidates map[string][]captureCandidate `json:"candidates"`
		LimitError string                        `json:"limitError"`
	}
	if err := json.Unmarshal([]byte(resultJSON), &result); err != nil {
		return nil, err
	}
	if result.LimitError != "" {
		return nil, errCaptureCandidateBudget
	}
	return result.Candidates, nil
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

type fullPageDimensions struct {
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

func measureFullPage(ctx context.Context) (fullPageDimensions, error) {
	var dimensions fullPageDimensions
	if err := chromedp.Run(ctx, chromedp.Evaluate(`(() => {
		const root = document.documentElement;
		const body = document.body;
		return {
			width: Math.max(window.innerWidth, root.scrollWidth, body ? body.scrollWidth : 0),
			height: Math.max(window.innerHeight, root.scrollHeight, body ? body.scrollHeight : 0)
		};
	})()`, &dimensions)); err != nil {
		return fullPageDimensions{}, err
	}
	return dimensions, nil
}

func captureFullPage(ctx context.Context) ([]byte, error) {
	dimensions, err := measureFullPage(ctx)
	if err != nil {
		return nil, err
	}
	if !withinFullPagePixelBudget(dimensions.Width, dimensions.Height) {
		return nil, errFullPagePixelBudget
	}
	var screenshot []byte
	err = chromedp.Run(ctx, chromedp.ActionFunc(func(ctx context.Context) error {
		data, err := cdppage.CaptureScreenshot().
			WithCaptureBeyondViewport(true).
			WithFromSurface(true).
			WithFormat(cdppage.CaptureScreenshotFormatPng).
			WithClip(&cdppage.Viewport{X: 0, Y: 0, Width: dimensions.Width, Height: dimensions.Height, Scale: 1}).
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
	current, err := measureFullPage(ctx)
	if err != nil {
		return nil, err
	}
	if current.Width > dimensions.Width || current.Height > dimensions.Height {
		return nil, errFullPageLayoutChanged
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
