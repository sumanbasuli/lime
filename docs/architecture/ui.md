# User Interface (NextJS)

The frontend for the accessibility scanner is a strictly decoupled **NextJS** application residing in the root `lime` folder.

## Tech Stack

* **Framework**: NextJS 16 (App Router, TypeScript)
* **Database ORM**: Drizzle ORM (read-only access to PostgreSQL)
* **Styling**: TailwindCSS v4 + shadcn/ui components
* **Fonts**: Geist Sans (body), Geist Mono (code), Fraunces (headings)

## Architecture

### Data Flow

- **Server Components** read data directly from PostgreSQL via Drizzle ORM
- **Server Components** also read the shared ACT catalog at render time for issue-detail enrichment
- **Server Components** also read shared `axe-rules.json` and `axe-act-mapping.json` metadata so issue cards can fall back to Deque's procedure-to-ACT mappings first and local axe-core WCAG tags second
- **Client Components** call same-origin `/api/...` routes for writes and live updates (POST/DELETE for scan actions, GET for polling)
  - this now includes issue-level false-positive mark/unmark actions from the issue details page
  - and scan creation now includes a viewport preset so users can choose the screen size used for rendering
- **Route Handlers** under `src/app/api/[...path]/route.ts` proxy those requests to Shopkeeper using the runtime `SHOPKEEPER_URL` env
- Shopkeeper owns all DB writes; the NextJS app only reads

### Page Routes

| Route | Type | Description |
|-------|------|-------------|
| `/` | Server Component | Dashboard: stats cards, recent scans table, new scan form |
| `/scans` | Server Component | All scans list with status badges and progress |
| `/scans/new` | Static | Dedicated new scan page with form |
| `/scans/[id]` | Server + Client | Scan detail with progress bar, issues summary, live polling |
| `/scans/[id]/issues` | Server Component | Issues viewer with expandable collapsible rows, ACT rules, WCAG mappings, and deterministic suggested changes |

### Key Components

| Component | Type | File |
|-----------|------|------|
| `NewScanForm` | Client | `src/components/new-scan-form.tsx` |
| `ScanProgress` | Client | `src/components/scan-progress.tsx` |
| `ScanActions` | Client | `src/components/scan-actions.tsx` |
| `IssueFalsePositiveButton` | Client | `src/components/issue-false-positive-button.tsx` |
| `StatusBadge` / `SeverityBadge` | Server | `src/components/status-badge.tsx` |
| `AppSidebar` | Client | `src/components/app-sidebar.tsx` |

### Live Progress

The `ScanProgress` client component polls `GET /api/scans/{id}` every 3 seconds. When the scan status or progress changes, it calls `router.refresh()` to trigger a Server Component re-render with fresh DB data. Polling auto-stops when status is `completed` or `failed`.

Important behavior:
- Navigating away from the scan detail page stops UI polling because the client component unmounts.
- The scan itself does not depend on the page staying open; Shopkeeper continues processing in the backend.
- If Shopkeeper restarts, the UI may temporarily stop seeing progress until the backend recovery path re-queues any non-terminal scan.

### Sidebar Navigation

Uses shadcn/ui sidebar-08 layout with:
- Dashboard → `/`
- Scans → `/scans` (sub-items: All Scans, New Scan)
- Settings → `/settings`
- API Health / Docs (secondary nav)

## API Client

**File**: `src/lib/api.ts`

Typed fetch wrapper using same-origin `/api/...` paths:
- `createScan(sitemapUrl)` — POST /api/scans
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

### Scan Management

Completed and failed scans expose client-side actions to:
- launch a fresh rescan using the same target URL, scan type, and tag
- delete the old scan record and its screenshot assets

Completed partial scans also expose a scan-detail recovery bento that can:
- reopen the same scan record
- retry only the failed pages
- keep completed pages and their existing issue/report data intact while new successful pages merge into the same scan

Active scans do not expose these actions, which prevents conflicts with the running Go scan pipeline.

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
- The issue details page now shows only the focused preview inline and opens the highlighted visible-view screenshot on click so users can inspect the current scrolled view without leaving the issue flow.
- The generic saved page capture is no longer shown inline as the default fallback. If a focused screenshot is unavailable, the page capture is only exposed as an on-demand secondary view.
- Focused screenshots now come from an interaction-aware backend capture path that tries the exact matched DOM node first, applies bounded hover/focus preparation, and renders the spotlight through a dedicated overlay. The inline preview is cropped from that same focused screenshot so the preview and lightbox stay visually consistent.
- Screenshot URLs are also same-origin `/api/screenshots/...` paths, so expanded screenshots and API writes share the same runtime proxy behavior.
- HTML snippets in the issue details view are now formatted into multiple lines and highlighted with Prism so long one-line fragments are readable without manual copying.
- Each expanded issue can show:
  - W3C ACT rule links and status badges (`W3C Recommendation` / `Proposed`)
  - mapped accessibility requirements / WCAG references
  - deterministic suggested changes aggregated from the mapped ACT rules
- Rules first try the checked-in ACT catalog, then a secondary Deque `act-reports-axe` procedure mapping, and finally the local axe-core standards tags.
- The same `Accessibility requirements` card style is now used across ACT-backed and fallback rules. ACT cards merge their ACT-derived references with normalized axe standards references, while fallback cards show only the normalized standards references or one single `No direct standards reference` card.
- WCAG level tags are normalized into readable cards and expanded forward when appropriate, for example `wcag2a` can surface as `WCAG 2.0 A`, `WCAG 2.1 A`, and `WCAG 2.2 A`.
- Non-ACT issues only show a green `Suggested changes` card when there is an explicit checked-in axe guidance entry for that rule. The UI does not synthesize its own remediation sentence from WCAG tags.
- The ACT guidance is rule-level and local. It is not generated on the fly and it is not DOM-specific in this phase.

### Visual Conventions

- Primary pages (`/`, `/scans`, `/scans/new`, `/scans/[id]`, `/scans/[id]/issues`) use a flattened header pattern: direct page titles with minimal supporting copy rather than decorative intro cards.
- Geist Sans is used for narrative body copy, while Geist Mono is reserved for rule IDs, selectors, and code-like snippets.
- Spacing across scan pages follows a tighter 4pt rhythm with reduced label tracking so metadata, forms, tables, and issue cards read as one consistent system instead of separate visual styles.
- Scan overview pages keep summary information first: page intro, key metrics or filters, then the primary table or detail content.
- The issues viewer uses an explicit rotating expander affordance tied to the trigger's open/closed state so users can tell at a glance which issue is expanded.
