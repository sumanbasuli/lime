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
* **Screenshot Capturing**: Takes full-page screenshots (80% quality JPEG) saved to `/app/screenshots/{scanID}/{urlID}.png`.
* **Concurrency Management**: Worker pool using a buffered channel semaphore of size 5.
* **Politeness**: 500ms delay between requests via `time.Sleep`.
* **Progress Reporting**: Calls `onProgress(scannedCount)` after each page, enabling real-time scan progress in the UI.

## System Constraints

* **Maximum Concurrency**: 5 pages at a time (semaphore channel of size 5).
* **Page Timeout**: 30 seconds per page.
* **Delay**: 500ms between requests.
* **Docker Requirement**: `shm_size: 2gb` in docker-compose for Chromium stability.
* **Chrome Flags**: `--no-sandbox`, `--disable-gpu`, `--disable-dev-shm-usage` for Docker compatibility.

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
