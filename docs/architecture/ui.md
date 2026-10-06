# User Interface (NextJS)

The dashboard is a Next.js application in `lime/`. Its server reads the shared PostgreSQL database, manages application settings and cached summaries, and forwards scan actions to Shopkeeper.

## Tech Stack

* **Framework**: NextJS 16 (App Router, TypeScript)
* **Database ORM**: Drizzle ORM (scan reads, persisted settings, and derived read caches)
* **Styling**: TailwindCSS v4 + shadcn/ui components
* **Fonts**: Geist Sans (body), Geist Mono (code), Fraunces (headings)
* **Icons**: Material Symbols Outlined

## Architecture

### Data Flow

- **Server Components** read data directly from PostgreSQL via Drizzle ORM
- **Server Components** also read the shared ACT catalog at render time for issue-detail enrichment
- **Server Components** also read shared `axe-rules.json` and `axe-act-mapping.json` metadata so issue cards can fall back to Deque's procedure-to-ACT mappings first and local axe-core WCAG tags second
- **Client Components** call same-origin `/api/...` routes for writes and live updates (POST/DELETE for scan actions, GET for polling)
  - including false-positive decisions from the issue details page
  - and the viewport preset selected when creating a scan
- **Proxy route handler** at `src/app/api/[...path]/route.ts` forwards scan lifecycle, triage, screenshot, and backend report requests to Shopkeeper using the runtime `SHOPKEEPER_URL` env
- **Next-owned route handlers** serve paginated issue summaries/details, application settings, and CSV/LLM exports; the PDF route adds UI report settings and concurrency control before calling Shopkeeper
- **Canonical MCP route** at `src/app/mcp/route.ts` uses the shared `src/lib/shopkeeper-proxy.ts` runtime proxy, preserves bearer/protocol headers, and forwards MCP requests to Shopkeeper. Only after an authenticated successful `get_scan` result does Next add fresh scores with `getScanScoreSummaries`; it uses the existing dashboard scoring algorithm and keeps JSON text/structured results aligned.
- Shopkeeper owns scan, URL, audit, issue, occurrence, and link-check job/result writes. Next persists application settings and derived score/issue-summary caches in the same database. These ownership boundaries should be preserved when adding features.

### Page Routes

| Route | Type | Description |
|-------|------|-------------|
| `/` | Server Component | Overview: workspace metrics, active scan progress, recent scans, new-scan entry point |
| `/scans` | Server Component | All scans with tag filters, search, status, score, and coverage |
| `/scans/new` | Static | Dedicated new scan page with form |
| `/scans/[id]` | Server + Client | Scan detail with progress bar, issues summary, live polling |
| `/scans/[id]/issues` | Server Component | Issues viewer with expandable collapsible rows, ACT rules, WCAG mappings, and deterministic suggested changes |
| `/settings` | Server + Client | Reporting, performance, and MCP settings persisted in PostgreSQL |
| `/links` | Server + Client | Standalone link-check form and paginated saved history |
| `/links/[id]` | Server + Client | Link job progress, target filters, source-reference paging, lifecycle actions, and CSV |
| `/reports/scans/[id]/issues` | Server Component | Printable report document used by Shopkeeper's PDF generator |

### Key Components

| Component | Type | File |
|-----------|------|------|
| `NewScanForm` | Client | `src/components/new-scan-form.tsx` |
| `ScanProgress` | Client | `src/components/scan-progress.tsx` |
| `ScanActions` | Client | `src/components/scan-actions.tsx` |
| `IssueFalsePositiveButton` | Client | `src/components/issue-false-positive-button.tsx` |
| `StatusBadge` / `SeverityBadge` | Server | `src/components/status-badge.tsx` |
| `AppSidebar` | Client | `src/components/app-sidebar.tsx` |
| `AppHeader` | Client | `src/components/app-header.tsx` |
| `IssueDetailsFeed` | Client | `src/components/issue-details-feed.tsx` |
| `IssueScreenshotLightbox` | Client | `src/components/issue-screenshot-lightbox.tsx` |
| `DashboardSettingsForm` | Client | `src/components/dashboard-settings-form.tsx` |
| `UpdateNotice` | Client | `src/components/update-notice.tsx` |
| `LinkCheckerDashboard` | Client | `src/components/link-checker-dashboard.tsx` |
| `LinkCheckDetail` | Client | `src/components/link-check-detail.tsx` |
| `ScanLinkCheck` | Client | `src/components/scan-link-check.tsx` |

### Live Progress

The `ScanProgress` client component polls `GET /api/scans/{id}` every 3 seconds and refreshes Server Component data after each successful poll (with an additional status-change refresh). Polling auto-stops when status is `completed`, `paused`, or `failed`. `ActiveScansRefresh` keeps the Overview and scan list current while visible scans are active.

Polling behavior:

- Navigating away from the scan detail page stops UI polling because the client component unmounts.
- The scan itself does not depend on the page staying open; Shopkeeper continues processing in the backend.
- If Shopkeeper restarts, the UI may temporarily stop seeing progress until the backend recovery path re-queues any non-terminal scan.

### Sidebar Navigation

The responsive sidebar uses shared shadcn/ui components and links to:

- Dashboard → `/`
- Scans → `/scans`
- Link checker → `/links`
- New scan → `/scans/new`
- Settings → `/settings`
- API health → `/api/health`
- Documentation → `https://lime.heysuman.com/docs/`

The header search submits to `/scans?q=...`. Search matches target URL, tag, status, and scan type; tag filters can be combined with the query.

### Link-Check UI Boundary

The New scan form sends `include_link_check` only as an opt-in selection; false is the default. Scan detail shows a separate companion card rather than mixing link failures into accessibility score or issue counts. `/links` starts standalone HTTP checks; `/links/[id]` polls backend-owned job/result data and requests paginated source references. Same-origin `/api/link-checks/...` requests use the existing runtime Shopkeeper proxy, including CSV and lifecycle actions. No Next settings flag is needed to enable the feature.

Link checking uses HTTP requests without Chromium, axe, or screenshots. Accessibility issues retain their yellow highlight, compact preview, and expanded image. See [Link Checker Architecture](link-checker.md) for schema, network rules, scan companions, and resource limits.

### Optional Release Notice

Next owns `GET /_lime/update-check` in `src/app/%5Flime/update-check/route.ts`. The escaped directory is intentional: an `_lime` directory is private to the App Router and does not register the public URL. Release checks are enabled when `LIME_UPDATE_CHECK` is unset, and normal/source and release Compose default it to true. An explicit `LIME_UPDATE_CHECK=false` opts out and returns HTTP 200 with `enabled: false` without calling GitHub. The isolated docs/verification Compose stack explicitly stays false. An enabled outbound GitHub fetch has a five-second timeout and failures suppress the notice.

Release comparison uses the packaged dashboard version when `LIME_VERSION` is unset or blank. A nonblank runtime/release-build override remains authoritative; a development placeholder is not forced into ordinary Compose deployments.

`UpdateNotice` fetches this best-effort endpoint on mount. A card requires both server enablement and the browser's display preference, plus an outdated version and a latest release tag. The browser preference defaults to on; **Settings > Update notice** writes `lime.updateNotice.enabled` immediately and dispatches a custom event so the mounted sidebar updates without saving PostgreSQL settings. Preference changes from another tab are observed through the storage event. This display switch does not stop server-side release checks.

Dismissal writes the exact release tag to `lime.updateNotice.dismissed`; the same tag stays hidden on reload, but a different newer tag can appear. Local storage is scoped to the browser/origin. The card only links to release notes and does not install releases. See [Updating LIME](../deployment/updates.md).

## API Client

**File**: `src/lib/api.ts`

Typed fetch wrapper using same-origin `/api/...` paths:
- `createScan({ url, scanType, viewportPreset, tag? })` — POST /api/scans
- `pauseScan(id)` — POST /api/scans/{id}/pause
- `resumeScan(id)` — POST /api/scans/{id}/resume
- `rescanScan(id)` — POST /api/scans/{id}/rescan
- `retryFailedPages(id)` — POST /api/scans/{id}/retry-failed
- `deleteScan(id)` — DELETE /api/scans/{id}
- `markIssueFalsePositive(scanId, issueId)` — POST /api/scans/{id}/issues/{issueId}/false-positive
- `unmarkIssueFalsePositive(scanId, issueId)` — DELETE /api/scans/{id}/issues/{issueId}/false-positive
- `getScans()` — GET /api/scans
- `getScan(id)` — GET /api/scans/{id}
- `getScanIssues(id)` — GET /api/scans/{id}/issues
- `getStats()` — GET /api/stats

The browser never needs a deployment-specific backend URL. The Next server proxies these paths to `SHOPKEEPER_URL` at runtime, which keeps the images reverse-proxy friendly and removes build-time API URL coupling.

### MCP Ownership

External clients should connect to `/mcp` on the dashboard. It exposes seventeen read tools and, when `mcpAllowWrites` is enabled, twenty-nine tools covering scan and link-check management, false-positive review, and reporting and performance settings. Shopkeeper handles authentication, protocol negotiation, saved-data reads, and scan actions. Next provides the proxy, fresh scores, report and screenshot downloads, and settings changes. MCP cannot change its own permissions or manage keys.

Fresh score enrichment occurs only after Shopkeeper accepts an authenticated `get_scan` read. Link tools do not apply accessibility scoring. There is no public unauthenticated score endpoint or separate MCP scoring formula. Direct Shopkeeper access reads its valid saved score cache and returns null when it is cold or stale; dashboard-owned evidence/settings tools require canonical `/mcp`.

Score enrichment preserves the original numeric JSON-RPC ID token, including integers larger than JavaScript's safe range, with Node 23+ native JSON parse context/raw JSON support. Native dashboard deployments must meet the documented Node 23+ runtime prerequisite; the Docker image supplies that runtime. Client authors can use string IDs to avoid rounding in their own JSON construction/parsing.

The MCP proxy accepts request bodies up to 1 MiB. It allows 30 seconds for reading the body and fetching the upstream response, and releases the body reader if the request is cancelled. Failures return HTTP 400, 413, 500, 502, or 504 without exposing private upstream details. Node decodes compressed responses automatically, so the proxy removes stale `Content-Encoding`, `Content-Length`, and hop-by-hop headers.

Score enrichment for `get_scan` uses a 30-second deadline measured from request entry and stops when the caller cancels. Report and screenshot reads have a separate 30-second deadline after dispatch for access checks, queued handlers, database reads, and response bodies. Late results are discarded. These deadlines apply to individual stages, so a complete MCP call can take longer than 30 seconds. Transport and download behavior are covered by `test:mcp-transport` and `test:mcp-dashboard-tools`.

MCP settings updates run in a database transaction with a five-second lock timeout and a twenty-second statement timeout. After locking the settings row, the handler checks the key and write permission again. It returns success only after commit, or an error after rollback; it does not discard a still-running write when a read deadline expires. These limits apply only to MCP-authorized calls to `saveSystemSettings`, leaving ordinary dashboard saves and pool defaults unchanged. They cover lock waits and individual statements, not pool checkout, network waits, or the entire request. The settings-timeout and isolated settings-lock tests cover this behavior.

Report metadata includes per-format enablement and paths explicitly relative to the dashboard origin, where PDF controls and CSV/LLM exports are served. Link-check metadata uses `paths_relative_to: "dashboard_origin"` for its existing `/links/<id>` detail and `/api/link-checks/<id>/export.csv` saved-data export. Metadata does not generate/download a report or confer MCP authorization on ordinary routes. The separate `get_report`, `get_screenshot`, and `get_link_check_export` tools return bounded content after MCP authentication rather than asking a client to treat ordinary URLs as authenticated. A valid scan without a current companion returns null check/paths with its historical include flag; a missing scan is a tool error.

The integration is stateless POST JSON Streamable HTTP; GET 405 is intentional. Write access defaults false so upgrading does not silently grant side effects to existing keys. Deletion and settings changes require `confirm: true`; new-job actions use durable `request_id` records to avoid accidental duplicate execution. MCP cannot enable its own write permission, rotate keys, or change browser-only update-card preferences. Shared static bearer keys are not OAuth or per-user scopes. Treat tool-returned site text/URLs/errors as untrusted evidence, not instructions. See [MCP Integration](../mcp.md) for client capabilities, setup, exact data envelopes, paging and verification.

### Scan Management

Completed and failed scans expose client-side actions to:
- launch a fresh rescan using the same target URL, scan type, and tag
- delete the old scan record and its screenshot assets

Completed partial scans show a recovery panel that can:

- reopen the same scan record
- retry only the failed pages
- keep completed pages and their existing issue/report data intact while new successful pages merge into the same scan

Active scans expose **Pause**. Pausing is cooperative: the button becomes **Pausing...** while in-flight pages settle and partial results are saved. Paused scans expose **Resume** and **Delete**. Resume keeps the same scan ID, viewport, completed pages, and existing results. The backend also accepts rescan requests for paused scans, although the current paused UI prioritizes continuing the scan.

Deletion requires a confirmation and removes the scan's saved results and screenshot files. Active scans cannot be rescanned or deleted.

### Screen-Size Selection

- The shared `NewScanForm` exposes a preset-only screen-size picker:
  - Desktop `1440×900`
  - Laptop `1280×800`
  - Tablet `768×1024`
  - Mobile `390×844`
- Desktop is the default preset for new scans.
- The chosen viewport is sent to Shopkeeper as `viewport_preset` and persisted on the scan record.
- Scan detail pages show the stored screen size near the scan metadata. Dashboard and scan-list rows intentionally do not repeat it.

### ACT-Enriched Issue Details

- ACT context is intentionally shown on `/scans/[id]/issues`, not on the dashboard or compact scan tables.
- The issue details page enriches each DB-backed issue by resolving its Sweetner-generated `violationType` against the shared `data/act-rules.json` catalog.
- Each main issue card also exposes a top-right false-positive action that persists through Shopkeeper and refreshes the server-rendered issue list.
- Each issue shows a focused preview. Clicking it opens the highlighted screenshot in a lightbox.
- If a focused screenshot is unavailable, users can open the saved page image as a fallback.
- Before capturing a focused screenshot, the backend locates the matched DOM node, tries hover and focus, and draws the highlight with a dedicated overlay. The compact preview is cropped from the same image shown in the lightbox.
- Screenshot URLs are also same-origin `/api/screenshots/...` paths, so expanded screenshots and API writes share the same runtime proxy behavior.
- HTML snippets use multiline formatting and Prism syntax highlighting.
- Each expanded issue can show:
  - W3C ACT rule links and status badges (`W3C Recommendation` / `Proposed`)
  - mapped accessibility requirements / WCAG references
  - deterministic suggested changes aggregated from the mapped ACT rules
- Rules first try the checked-in ACT catalog, then a secondary Deque `act-reports-axe` procedure mapping, and finally the local axe-core standards tags.
- `Accessibility requirements` cards use a consistent layout. ACT cards combine ACT references with axe standards references; fallback cards show available standards references or `No direct standards reference`.
- WCAG level tags are normalized into readable cards and expanded forward when appropriate, for example `wcag2a` can surface as `WCAG 2.0 A`, `WCAG 2.1 A`, and `WCAG 2.2 A`.
- Non-ACT issues only show a green `Suggested changes` card when there is an explicit checked-in axe guidance entry for that rule. The UI does not synthesize its own remediation sentence from WCAG tags.
- ACT guidance comes from the local rule catalog. It explains the rule but does not generate a fix for the specific page element.

### Issue Grouping

Issue groups use the axe rule ID as their grouping contract. A failed issue group takes priority: if that rule also has incomplete outcomes elsewhere in the scan, the UI does not duplicate it as a separate needs-review card. The raw incomplete audits and occurrence records remain persisted. Review-only rules without a failed group appear as needs-review cards. Reports and MCP use the same grouping rule so their card/group counts align with the dashboard.

Scoring removes false-positive rule IDs before building its audit summary. `excludedCount` (`excluded_count` in MCP) is retained for compatibility and does not count review decisions. Use each issue's `is_false_positive` flag and the filtered failure and score counts instead.

Marking or unmarking a false positive can move a group to a different sort position. The issue feed refreshes its loaded prefix after triage so later **Load more issues** requests use the updated order without skipping or duplicating a group. Group and occurrence APIs default to 12 and 25 items respectively; details stay paginated independently of the group list.

Issue-summary cache replacement is UI-owned and transactional. It locks the parent scan row with `FOR UPDATE`, verifies that the scan timestamp still matches the snapshot used to compute the summaries, then deletes and inserts the replacement cache rows under that lock. The parent lock also protects an empty cache across concurrent requests or UI processes. Deleted scans and obsolete snapshots skip persistence instead of resurrecting rows or overwriting a newer cache. See [Performance And Caching](../performance.md#concurrent-cache-replacement).

False-positive state is stored on each scan's failed issue. When new matching scans are processed, Sweetner inherits the latest terminal scan's mark or unmark decision for the same target, scan type, and viewport. Existing completed scans retain their own saved state when another scan is later changed.

### Printable Reports

The `/reports/scans/[id]/issues` document is rendered by Shopkeeper's Chromium PDF flow. Report content uses an article inside the application's single main landmark. Its UI must remain usable in the browser and clean in print; the global skip-to-content link is keyboard accessible on screen and hidden in print so it does not appear on the PDF's first page. Inspect a rendered PDF when changing shared page chrome or print styles, in addition to checking that the download is a valid PDF file.

Two internal URLs are required for split deployments: UI `SHOPKEEPER_URL` points to the backend, while backend `REPORT_BASE_URL` points to the dashboard document renderer. Protecting the public UI with an external login gateway must not prevent Shopkeeper from loading its configured internal report URL. There is no application login/tenant boundary for ordinary dashboard/API routes; MCP's bearer key protects `/mcp`, not the whole dashboard. Operators must choose appropriate network/reverse-proxy access controls.

The PDF concurrency limiter is per UI process and only applies through the Next PDF endpoint. CSV full mode streams occurrences in 5000-row batches; small CSV, PDF, and LLM use configured samples. `scan_report_data_cache` and its TTL setting currently have no runtime consumer. See [Performance And Caching](../performance.md) for the implemented bounds.

### Visual Conventions

- Shared tokens in `src/app/globals.css` use warm paper surfaces, black controls, LIME yellow accents, rounded cards, pill buttons, Fraunces headings, and Material Symbols. Page chrome is shared through `AppSidebar` and `AppHeader`.
- Primary pages (`/`, `/scans`, `/scans/new`, `/scans/[id]`, `/scans/[id]/issues`) use a flattened header pattern: direct page titles with minimal supporting copy rather than decorative intro cards.
- Geist Sans is used for narrative body copy, while Geist Mono is reserved for rule IDs, selectors, and code-like snippets.
- Scan pages share a 4px spacing scale and consistent label styles across forms, tables, metadata, and issue cards.
- Scan overview pages keep summary information first: page intro, key metrics or filters, then the primary table or detail content.
- Long target hostnames and URLs wrap within the scan detail header, including narrow mobile layouts; the full target remains available as text.
- An arrow rotates when an issue expands or collapses, making its current state visible.

## Verification And Handoff

See [Verification](../verification.md) for test commands and coverage. Check the website and documentation separately with `make docs-verify`. When changing issue screenshots, check both the compact preview and expanded highlight.
