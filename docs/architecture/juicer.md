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

* **Axe-Core Execution**: Injects axe-core 4.10.2 into each page via `chromedp.Evaluate()` and runs `axe.run(document, {resultTypes: ['violations']})`.
* **Screenshot Capturing**: Takes full-page PNG screenshots and per-element screenshots saved under `/app/screenshots/{scanID}/`.
* **Concurrency Management**: Worker pool using a buffered channel semaphore of size 5.
* **Politeness**: 500ms delay between requests via `time.Sleep`.
* **Progress Reporting**: Calls `onProgress(scannedCount)` after each page, enabling real-time scan progress in the UI.
* **Viewport Control**: Applies the scan's persisted viewport width/height before navigation so layout, screenshots, and rule evaluation all use the same deterministic rendering width.
* **Visual Stabilization**: Uses a fuller settle wait before screenshots and as a best-effort step before rule execution, without treating every late-loading asset as a hard scan failure.
* **Context Fallback**: Tiny or visually blank element crops are retried with a wider contextual clip, then a visible-viewport context screenshot around the scrolled-to element, and only then can the UI fall back to the saved page screenshot.

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
- `Violations` — Array of axe-core violations, each with ID, description, help, impact, and affected DOM nodes
- `ScreenshotPath` — Path to the saved full-page screenshot
- `Error` — Error message if the page failed to scan

### Screenshot Reliability Notes

- Juicer no longer captures screenshots immediately after `body` becomes available.
- Juicer sets an explicit viewport before `Navigate(...)`, so scans no longer depend on Chromium's implicit startup viewport.
- If the extra page-settle wait times out after the document is already usable, Juicer now logs a warning and still runs the accessibility rules instead of silently returning zero issues for that page.
- Element clips are padded and minimum-sized so very small targets do not collapse into unreadable dots.
- If the element crop still looks unreliable after capture, Juicer prefers a wider context crop and then a desktop-width visible-viewport screenshot around the element before the UI falls back to the full page.
