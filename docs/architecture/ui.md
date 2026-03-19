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
- **Client Components** call the Shopkeeper API for writes and live updates (POST/DELETE for scan actions, GET for polling)
- Shopkeeper owns all DB writes; the NextJS app only reads

### Page Routes

| Route | Type | Description |
|-------|------|-------------|
| `/` | Server Component | Dashboard: stats cards, recent scans table, new scan form |
| `/scans` | Server Component | All scans list with status badges and progress |
| `/scans/new` | Static | Dedicated new scan page with form |
| `/scans/[id]` | Server + Client | Scan detail with progress bar, issues summary, live polling |
| `/scans/[id]/issues` | Server Component | Issues viewer with expandable collapsible rows |

### Key Components

| Component | Type | File |
|-----------|------|------|
| `NewScanForm` | Client | `src/components/new-scan-form.tsx` |
| `ScanProgress` | Client | `src/components/scan-progress.tsx` |
| `ScanActions` | Client | `src/components/scan-actions.tsx` |
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
- Settings → `#` (placeholder)
- API Health / Docs (secondary nav)

## API Client

**File**: `src/lib/api.ts`

Typed fetch wrapper using `process.env.NEXT_PUBLIC_API_URL`:
- `createScan(sitemapUrl)` — POST /api/scans
- `rescanScan(id)` — POST /api/scans/{id}/rescan
- `deleteScan(id)` — DELETE /api/scans/{id}
- `getScans()` — GET /api/scans
- `getScan(id)` — GET /api/scans/{id}
- `getScanIssues(id)` — GET /api/scans/{id}/issues
- `getStats()` — GET /api/stats

### Scan Management

Completed and failed scans expose client-side actions to:
- launch a fresh rescan using the same target URL, scan type, and tag
- delete the old scan record and its screenshot assets

Active scans do not expose these actions, which prevents conflicts with the running Go scan pipeline.
