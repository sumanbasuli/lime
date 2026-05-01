# Juicer (The Axe-Core Scanner)

**Juicer** is the heavy-lifting execution module of the Shopkeeper system. It uses **chromedp** (Go bindings for Chrome DevTools Protocol) to run headless Chromium and evaluate web pages using the **axe-core** accessibility library.

## Implementation

**Files**:
- `shopkeeper/internal/juicer/juicer.go` — Worker pool, page scanning logic
- `shopkeeper/internal/juicer/types.go` — RawResult, Violation, Node structs
- `shopkeeper/internal/juicer/axecore.go` — Embedded axe-core JS
- `shopkeeper/internal/juicer/axe.min.js` — axe-core 4.10.2 minified

### Entry Point

```go
func ScanPages(ctx, allocCtx context.Context, pages []PageInput, scanID string, onProgress ProgressCallback) ([]RawResult, error)
```

## Responsibilities

* **Axe-Core Execution**: Injects axe-core 4.10.2 into each page via `chromedp.Evaluate()` and runs a Lighthouse-aligned accessibility configuration: `elementRef: true`, `runOnly` on `wcag2a`/`wcag2aa`, `resultTypes` including `violations` and `inapplicable`, curated rule overrides, and `noHtml: true` with custom node serialization.
* **Screenshot Capturing**: Takes full-page PNG screenshots and per-element screenshots saved under the Shopkeeper screenshot directory. Docker/Fly use `/app/screenshots/{scanID}/`; native installs set `SHOPKEEPER_SCREENSHOT_DIR` while stored DB paths remain `/app/screenshots/...` for stable UI/report URLs.
* **Concurrency Management**: Worker pool using a buffered channel semaphore of size 5.
* **Politeness**: 500ms delay between requests via `time.Sleep`.
* **Progress Reporting**: Calls `onProgress(scannedCount)` after each page, enabling real-time scan progress in the UI.
* **Viewport Control**: Applies the scan's persisted viewport width/height before navigation so layout, screenshots, and rule evaluation all use the same deterministic rendering width.
* **Visual Stabilization**: Uses a fuller settle wait before screenshots and as a best-effort step before rule execution, without treating every late-loading asset as a hard scan failure.
* **Focused Issue Screenshots**: Juicer now saves two focused screenshot assets per capturable occurrence: a visible-viewport spotlight image for expanded viewing and a smaller preview cropped from that exact focused screenshot for inline issue cards.
* **Exact Node Resolution**: Before screenshots, Juicer resolves a deterministic internal `capture_index` for each failing selector so duplicate selectors do not always collapse to the first DOM match.
* **Interaction-Aware Capture**: Before capture, Juicer now scrolls the exact node into view, hovers the nearest visible ancestor when the target is initially hidden, moves the mouse to the target when possible, and applies focus for focusable controls.
* **Lighthouse-Style Node Details**: Juicer now serializes failure summaries and a small set of related nodes from axe output so scan results stay closer to Lighthouse’s accessibility artifact shape even though only violations are persisted today.

## System Constraints

* **Maximum Concurrency**: 5 pages at a time (semaphore channel of size 5).
* **Page Timeout**: 30 seconds per page.
* **Delay**: 500ms between requests.
* **Docker Requirement**: `shm_size: 2gb` in docker-compose for Chromium stability.
* **Chrome Flags**: `--no-sandbox`, `--disable-gpu`, `--disable-dev-shm-usage` for Docker compatibility.
* **Viewport Presets**: Shopkeeper currently resolves four presets before Juicer runs: Desktop `1440x900`, Laptop `1280x800`, Tablet `768x1024`, and Mobile `390x844`.

### Chromedp Allocator

Set up in `cmd/shopkeeper/main.go`:
```go
chromedp.NewExecAllocator(ctx,
    chromedp.NoSandbox,
    chromedp.DisableGPU,
    chromedp.Flag("disable-dev-shm-usage", true),
    // ... other flags
)
```

### axe-core Integration

The minified axe-core library (v4.10.2, ~553KB) is embedded at compile time using Go's `//go:embed` directive. This eliminates network dependency at runtime.

## Output

Returns `[]RawResult`, each containing:
- `URLID` / `URL` — The page identifier and URL
- `Violations` — Array of Lighthouse-shaped axe violations, each with ID, description, help, impact, tags, failure summaries, related nodes, and affected DOM nodes
- `Incomplete` / `NotApplicable` / `Passes` — Captured in-memory for parity with Lighthouse-style execution, though only violations are persisted in this phase
- `Version` — The embedded axe-core engine version reported at runtime
- `ScreenshotPath` — Path to the saved full-page screenshot
- `Error` — Error message if the page failed to scan

### Screenshot Reliability Notes

- Juicer no longer captures screenshots immediately after `body` becomes available.
- Juicer sets an explicit viewport before `Navigate(...)`, so scans no longer depend on Chromium's implicit startup viewport.
- If the extra page-settle wait times out after the document is already usable, Juicer now logs a warning and still runs the accessibility rules instead of silently returning zero issues for that page.
- Juicer’s accessibility run now follows Lighthouse’s accessibility gatherer more closely than the broad default axe run, which reduces mismatches caused by best-practice-only rules and preserves node-level failure context.
- Issue screenshots now include a clean visible-viewport spotlight image plus a smaller preview cropped from that same focused image so the inline issue card matches the expanded lightbox view.
- Juicer now renders the spotlight with a dedicated fixed overlay instead of mutating the target element’s inline styles, which keeps the highlight more consistent across selectors and avoids stale highlights leaking into later captures.
- When the failing selector matches multiple DOM nodes, Juicer resolves a best-effort exact match using the node HTML and selector order before it attempts screenshots.
- When the failing node is initially hidden but a visible ancestor can expose it, Juicer tries a bounded `focus + hover` preparation pass before deciding that no focused screenshot is available.
- Juicer still does not click/open interactive widgets during capture, so pseudo-elements, click-open menus, canvas-only controls, and similar cases can still end up with no focused screenshot.
