# Juicer (The Axe-Core Scanner)

**Juicer** runs LIME's accessibility checks. It controls headless Chromium through **chromedp**, evaluates pages with **axe-core**, and captures screenshots of the findings.

## Implementation

**Files**:
- `shopkeeper/internal/juicer/juicer.go` — Worker pool, page scanning logic
- `shopkeeper/internal/juicer/types.go` — RawResult, Violation, Node structs
- `shopkeeper/internal/juicer/axecore.go` — Embedded axe-core JS
- `shopkeeper/internal/juicer/axe.min.js` — axe-core 4.10.2 minified
- `shopkeeper/internal/egressproxy/` — Per-page Chromium TCP egress guard

### Entry Point

```go
func ScanPages(ctx, allocCtx context.Context, pages []PageInput, scanID string, scanViewport viewport.Settings, onProgress ProgressCallback, observers ...rootdns.Observer) ([]RawResult, error)
```

## Responsibilities

* **Axe-Core Execution**: Injects axe-core 4.10.2 into each page via `chromedp.Evaluate()` and runs a Lighthouse-aligned accessibility configuration: `elementRef: true`, `runOnly` on `wcag2a`/`wcag2aa`, `resultTypes` including `violations` and `inapplicable`, curated rule overrides, and `noHtml: true` with custom node serialization.
* **Screenshot Capturing**: Takes full-page PNG screenshots and per-element screenshots saved under the Shopkeeper screenshot directory. Docker uses `/app/screenshots/{scanID}/`; native installs set `SHOPKEEPER_SCREENSHOT_DIR` while stored DB paths remain `/app/screenshots/...` for stable UI/report URLs.
* **Browser Network Guard**: Starts a loopback SOCKS5 proxy before each page browser. It pins that page root's DNS answer set and dials approved IPs directly. Before Chrome starts, the scanner commits the answer's classification to the scan and any companion in PostgreSQL. The proxy also leases the shared policy through each private-root TCP dial, so a different page cannot commit a public observation between approval and connection or keep using an older private pin afterward. Newly submitted roots that remain private-only are supported. Private destinations are allowed for the entered host on its port. When the entered URL uses a standard HTTP or HTTPS port, the same host's paired standard port is also allowed for redirects and page resources; the proxy cannot distinguish them by request purpose. Other private or mixed-DNS destinations are blocked before connection. Ordinary public assets remain available.
* **Concurrency Management**: Juicer uses a five-page worker pool within each scan. The scanner admits at most two scans at a time per Shopkeeper process; additional persisted pending scans wait in the database and are picked up when a slot opens.
* **Politeness**: 500ms delay between requests, interruptible when the parent scan run is canceled.
* **Progress Reporting**: Reports processed page attempts, including genuine failures, through `onProgress(scannedCount)`. A per-run synchronized callback prevents a lower count from overwriting a newer count; callbacks that arrive behind an already reported count are skipped. Resume/retry adds the existing processed-page count separately.
* **Viewport Control**: Applies the scan's persisted viewport width/height before navigation so layout, screenshots, and rule evaluation all use the same deterministic rendering width.
* **Page Loading**: Waits for the page to settle before checking rules and taking screenshots. A late-loading asset does not automatically fail an otherwise usable page. The browser's top-level frame must stay on the submitted host and effective port at audit and screenshot checkpoints; same-host HTTP-to-HTTPS redirects on standard ports remain eligible. A page that lands off-authority fails rather than attributing another site's axe or screenshot evidence to the submitted URL.
* **Focused Issue Screenshots**: Saves a highlighted screenshot for expanded viewing and a smaller preview cropped from the same image for issue cards.
* **Exact Node Resolution**: Before screenshots, Juicer resolves a deterministic internal `capture_index` for each failing selector so duplicate selectors do not always collapse to the first DOM match.
* **Preparing Elements For Capture**: Scrolls the matched node into view, hovers a visible ancestor if needed, and focuses controls where possible.
* **Lighthouse-Style Node Details**: Juicer serializes failure summaries and a small set of related nodes from axe output. Sweetner persists audit outcomes as well as failed issue groups and occurrence evidence.

## System Constraints

* **Maximum Concurrency**: 2 active scans per Shopkeeper process, each with at most 5 page workers (up to 10 simultaneous page audits). This is a process-local cap, not coordination between multiple Shopkeeper instances. Pending create, retry, resume, and rescan jobs remain saved while waiting; startup recovery also uses these slots.
* **Page Timeout**: 30 seconds per page.
* **Delay**: 500ms between requests.
* **Axe Evidence Budget**: A page can return at most 512 rule records, 2,000 affected nodes, and 16 MiB of serialized axe evidence. Each HTML snippet retains at most 4,096 characters plus a visible truncation marker; failure summaries retain at most 2,048 characters. Targets may have at most 8 selector parts of 1,024 characters each. If the rule, node, target, or result-size limit is exceeded, that page fails instead of saving a partial axe result. The 128 MiB aggregate axe budget applies to one `ScanPages` invocation and starts fresh after pause/resume.
* **Browser Transfer Budget**: The page-local proxy counts relayed TCP payload in both directions after SOCKS connection. It allows up to 256 MiB per page and 1 GiB across currently active page proxies in one Shopkeeper process. Exceeding either limit stops that page browser and marks the page failed without publishing axe or screenshot evidence; closing a page releases its contribution to the process total. This budget does not cover Profiler, Link Checker, PDF rendering, TCP overhead, or Chromium's own memory use.
* **Screenshot Budget**: Each page may save at most 64 screenshot files and 32 MiB; each file is capped at 20 MiB. A scan may save at most 50,000 screenshot files and 2 GiB, counting existing files when it resumes. Full-page capture is clipped to the measured page at no more than 24 million CSS pixels; a page that grows beyond that clip during capture has its screenshot omitted. Focused screenshot matching reads at most 64 DOM matches per selector and 4 MiB of candidate evidence overall, with a 4,096-node/64 KiB preflight before reading a subtree's `outerHTML`. Budget-omitted element captures add a warning to the affected node's saved HTML evidence; a budget- or growth-omitted full-page capture adds a warning to a saved issue node when one exists.
* **Docker Allocation**: Compose allocates `shm_size: 2gb`; total CPU/RAM needs still depend on simultaneous scans, page complexity, and PDF generation.
* **Chrome Flags**: The page allocator retains `--no-sandbox`, `--disable-gpu`, and `--disable-dev-shm-usage` for Docker compatibility. It adds a single SOCKS5 proxy with no direct fallback, removes Chromium's implicit loopback bypass, disables QUIC, and sets both Chrome WebRTC IP-handling switches to `disable_non_proxied_udp`. The normal Chrome switch is needed for the tested unified-headless browser; the force switch remains for older headless-shell behavior. The separate PDF renderer keeps its existing allocator and internal UI access.
* **Viewport Presets**: Shopkeeper currently resolves four presets before Juicer runs: Desktop `1440x900`, Laptop `1280x800`, Tablet `768x1024`, and Mobile `390x844`.

### Cancellation And Resume

Juicer distinguishes the parent scan-run context from each page's timeout. An unfinished browser operation that returns an error after the parent is canceled is treated as interrupted work, even if Chromium startup loses the original cancellation cause and reports only `chrome failed to start`. Canceled page results are not persisted as failures; they remain pending for resume. Successful results remain valid. Startup/navigation errors and local page timeouts while the parent is still active remain genuine failures.

`shopkeeper/internal/juicer/cancellation_test.go` covers these boundaries, including startup errors with blank/DBUS messages, parent cancellation/deadline, active-run errors, local page timeouts, and nil successful operations. This classification does not change screenshot rendering or the scoring algorithm.

### Chromedp Allocator

`cmd/shopkeeper/main.go` creates the parent Chromium allocator used by Shopkeeper and the PDF reporter. Before each page audit, `internal/egressproxy/proxy.go` starts a page-local proxy; `internal/egressproxy/chrome.go` creates a child allocator with that proxy and the page-specific network flags. Juicer starts no page browser if proxy setup fails. Keep the parent and page allocator's Chrome binary selection and shared compatibility flags aligned when changing them.

Both allocators require Chromium's sandbox. Startup verifies a separate browser before normal migrations or HTTP, while each page retains its SOCKS proxy, loopback bypass restriction, and QUIC/WebRTC settings. A browser that cannot start fails the operation; there is no fallback to `--no-sandbox`. Docker installations need the current Compose seccomp policy and non-root entrypoint; native installations need Chromium's sandbox available to the service account.

### axe-core Integration

The minified axe-core library (v4.10.2, ~553KB) is embedded at compile time using Go's `//go:embed` directive. This eliminates network dependency at runtime.

Juicer creates a Chrome-isolated JavaScript world in the top frame and in each discovered child frame, including out-of-process frames. It runs the embedded engine and result serializer in each world with axe frame messaging disabled, then merges the bounded results with frame selectors in each affected node's target. A scanned page's own `window.axe` object or same-origin frame message cannot replace the engine or forge another frame's result. Child frames are collected in parent order even if Chrome lists their targets in another order. Frame attach, detach, and navigation events during the audit make the page fail before evidence is published, so a newly inserted frame is not silently reported as checked. Like any live-page audit, this samples a changing document; important embedded content still needs human review.

Focused element screenshots are suppressed for child-frame findings because top-frame capture cannot highlight the affected element inside the frame accurately. The node evidence records that omission; the full-page screenshot remains available when capture succeeds. Top-frame focus and expanded screenshots retain their existing behavior.

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
- On unusually large or changing pages, screenshot evidence can be omitted even when axe findings are saved. An oversized DOM subtree gets an HTML omission marker before Juicer reads its `outerHTML`; focused screenshots for a selector that exceeds the matching budget are skipped without suppressing unrelated selectors.
- Juicer does not click controls to open widgets. Some pseudo-elements, menus, and canvas controls may therefore have no focused screenshot.

## Operational Boundaries

Chromium must be discoverable by the native process and the physical screenshot root must be writable. `screenshots.BaseDir()` accepts `SHOPKEEPER_SCREENSHOT_DIR` (or the legacy `LIME_SCREENSHOT_DIR`) and defaults to `/app/screenshots`; `StoredPath()` deliberately keeps `/app/screenshots/{scanId}/…` in database payloads even for native installs. Clients should use `/api/screenshots/{scanId}/{filename}`, not those storage paths as browser URLs.

The axe engine and ACT metadata are local, but scanned pages still require network access and may load public third-party assets. Authentication-required pages, consent dialogs, delayed widgets, and blocked private resources can affect the rendered page and findings. The browser proxy uses direct DNS/dialing, not an ambient enterprise HTTP proxy. Automated output is evidence for review, not a complete accessibility conformance certification.

The browser guard does not turn an operator-submitted URL into an authorization system. A new scan whose root first resolves only to private addresses may use that root; a scan already observed as public cannot later dial a private root, including across Profiler and browser pages. Juicer pins exact addresses only for each page, while the public-only classification persists for the scan and its companion. The SOCKS5 guard covers TCP URL traffic. A real-Chrome positive-control test confirmed that the corrected WebRTC setting prevented the tested top-frame localhost STUN packet, but it does not prove that every UDP path is contained or override a managed Chrome policy. Restrict Shopkeeper's network access to sensitive metadata and management services even when this guard is enabled.

Evidence budgets bound what Juicer serializes and saves, not all memory used by Chromium while building the page or by `axe.run` before serialization. A clean page with no saved issue occurrence also has no occurrence HTML in which to record a screenshot-omission warning; a missing image alone is not evidence of a pass.

See [Operational Troubleshooting](../deployment/troubleshooting.md) for browser startup, memory, screenshot, and PDF checks. Capture changes require both Juicer unit tests and the isolated browser/scan/screenshot flow, since a valid PNG alone does not prove the preview and expanded spotlight show the same node.
