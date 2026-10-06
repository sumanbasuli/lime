# Juicer (The Axe-Core Scanner)

**Juicer** runs LIME's accessibility checks. It controls headless Chromium through **chromedp**, evaluates pages with **axe-core**, and captures screenshots of the findings.

## Implementation

**Files**:
- `shopkeeper/internal/juicer/juicer.go` — Worker pool, page scanning logic
- `shopkeeper/internal/juicer/types.go` — RawResult, Violation, Node structs
- `shopkeeper/internal/juicer/axecore.go` — Embedded axe-core JS
- `shopkeeper/internal/juicer/axe.min.js` — axe-core 4.10.2 minified

### Entry Point

```go
func ScanPages(ctx, allocCtx context.Context, pages []PageInput, scanID string, scanViewport viewport.Settings, onProgress ProgressCallback) ([]RawResult, error)
```

## Responsibilities

* **Axe-Core Execution**: Injects axe-core 4.10.2 into each page via `chromedp.Evaluate()` and runs a Lighthouse-aligned accessibility configuration: `elementRef: true`, `runOnly` on `wcag2a`/`wcag2aa`, `resultTypes` including `violations` and `inapplicable`, curated rule overrides, and `noHtml: true` with custom node serialization.
* **Screenshot Capturing**: Takes full-page PNG screenshots and per-element screenshots saved under the Shopkeeper screenshot directory. Docker/Fly use `/app/screenshots/{scanID}/`; native installs set `SHOPKEEPER_SCREENSHOT_DIR` while stored DB paths remain `/app/screenshots/...` for stable UI/report URLs.
* **Concurrency Management**: Worker pool using a buffered channel semaphore of size 5 per scan run; simultaneous scans can each start their own workers.
* **Politeness**: 500ms delay between requests, interruptible when the parent scan run is canceled.
* **Progress Reporting**: Reports processed page attempts, including genuine failures, through `onProgress(scannedCount)`. A per-run synchronized callback prevents a lower count from overwriting a newer count; callbacks that arrive behind an already reported count are skipped. Resume/retry adds the existing processed-page count separately.
* **Viewport Control**: Applies the scan's persisted viewport width/height before navigation so layout, screenshots, and rule evaluation all use the same deterministic rendering width.
* **Page Loading**: Waits for the page to settle before checking rules and taking screenshots. A late-loading asset does not automatically fail an otherwise usable page.
* **Focused Issue Screenshots**: Saves a highlighted screenshot for expanded viewing and a smaller preview cropped from the same image for issue cards.
* **Exact Node Resolution**: Before screenshots, Juicer resolves a deterministic internal `capture_index` for each failing selector so duplicate selectors do not always collapse to the first DOM match.
* **Preparing Elements For Capture**: Scrolls the matched node into view, hovers a visible ancestor if needed, and focuses controls where possible.
* **Lighthouse-Style Node Details**: Juicer serializes failure summaries and a small set of related nodes from axe output. Sweetner persists audit outcomes as well as failed issue groups and occurrence evidence.

## System Constraints

* **Maximum Concurrency**: 5 pages per scan at a time (semaphore channel of size 5), not a server-wide limit.
* **Page Timeout**: 30 seconds per page.
* **Delay**: 500ms between requests.
* **Docker Allocation**: Compose allocates `shm_size: 2gb`; total CPU/RAM needs still depend on simultaneous scans, page complexity, and PDF generation.
* **Chrome Flags**: `--no-sandbox`, `--disable-gpu`, `--disable-dev-shm-usage` for Docker compatibility.
* **Viewport Presets**: Shopkeeper currently resolves four presets before Juicer runs: Desktop `1440x900`, Laptop `1280x800`, Tablet `768x1024`, and Mobile `390x844`.

### Cancellation And Resume

Juicer distinguishes the parent scan-run context from each page's timeout. An unfinished browser operation that returns an error after the parent is canceled is treated as interrupted work, even if Chromium startup loses the original cancellation cause and reports only `chrome failed to start`. Canceled page results are not persisted as failures; they remain pending for resume. Successful results remain valid. Startup/navigation errors and local page timeouts while the parent is still active remain genuine failures.

`shopkeeper/internal/juicer/cancellation_test.go` covers these boundaries, including startup errors with blank/DBUS messages, parent cancellation/deadline, active-run errors, local page timeouts, and nil successful operations. This classification does not change screenshot rendering or the scoring algorithm.

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
- `Incomplete` / `NotApplicable` / `Passes` — Rule outcomes persisted by Sweetner in `url_audits`; incomplete node evidence is persisted in `url_audit_occurrences` for manual review
- `Version` — The embedded axe-core engine version reported at runtime
- `ScreenshotPath` — Path to the saved full-page screenshot
- `Error` — Error message if the page failed to scan

An interrupted page is excluded from returned results rather than turned into a failed URL. The scanner saves URL status and successful results after the batch ends; the live progress counter can therefore advance before those page rows/evidence are persisted. Closing the browser UI does not cancel this work.

### Screenshot Reliability Notes

- Juicer sets the saved viewport before `Navigate(...)` and waits for the page to settle before taking screenshots.
- If that wait times out but the document is usable, Juicer logs a warning and continues with the accessibility checks.
- The axe configuration follows Lighthouse's accessibility gatherer, including rule selection and node-level failure details.
- The compact preview and expanded view come from the same highlighted image.
- A dedicated overlay draws the highlight without modifying the target element's styles or leaving highlights behind for later captures.
- When the failing selector matches multiple DOM nodes, Juicer resolves a best-effort exact match using the node HTML and selector order before it attempts screenshots.
- When the failing node is initially hidden but a visible ancestor can expose it, Juicer tries a bounded `focus + hover` preparation pass before deciding that no focused screenshot is available.
- Juicer does not click controls to open widgets. Some pseudo-elements, menus, and canvas controls may therefore have no focused screenshot.

## Operational Boundaries

Chromium must be discoverable by the native process and the physical screenshot root must be writable. `screenshots.BaseDir()` accepts `SHOPKEEPER_SCREENSHOT_DIR` (or the legacy `LIME_SCREENSHOT_DIR`) and defaults to `/app/screenshots`; `StoredPath()` deliberately keeps `/app/screenshots/{scanId}/…` in database payloads even for native installs. Clients should use `/api/screenshots/{scanId}/{filename}`, not those storage paths as browser URLs.

The axe engine and ACT metadata are local, but scanned pages still require network access and may load third-party assets. Authentication-required pages, consent dialogs, delayed widgets, and blocked resources can affect the rendered page and findings. Automated output is evidence for review, not a complete accessibility conformance certification.

See [Operational Troubleshooting](../deployment/troubleshooting.md) for browser startup, memory, screenshot, and PDF checks. Capture changes require both Juicer unit tests and the isolated browser/scan/screenshot flow, since a valid PNG alone does not prove the preview and expanded spotlight show the same node.
