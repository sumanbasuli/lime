# LIME Dashboard

This directory contains LIME's Next.js App Router dashboard. The Go backend in `../shopkeeper/` owns scan lifecycle and audit results; both services share PostgreSQL. The separate marketing website and documentation app lives in `../docs-site/`.

## Run Locally

From the repository root:

```bash
make init-env             # start Docker first; new checkout/database only
make start-all            # production Docker stack at http://localhost:3000
make start-dev            # Docker stack with dashboard hot reload
```

For native dashboard development, install dependencies once with `npm --prefix lime ci`, start the database and Shopkeeper with `make start-db` and `make start-shopkeeper`, then run `make dev-ui`. Root Make targets load `.env`; running `npm run dev` directly here requires a `DATABASE_URL` and `SHOPKEEPER_URL` in `lime/.env.local` or the process environment. Avoid running the native and Docker UI on the same port.

## Ownership And Main Routes

- Server-rendered dashboard and scan pages read PostgreSQL through Drizzle.
- Scan creation, pause/resume, retry, rescan, deletion, and false-positive actions use the same-origin API proxy to Shopkeeper.
- Next route handlers own paginated issue reads, CSV/LLM exports, report controls, and persisted application settings. The UI also maintains derived score and issue-summary caches.
- Screenshot URLs use `/api/screenshots/...`; preview and expanded image behavior share the existing backend capture path.
- `/` is the Overview; `/scans` supports tags and search; `/scans/new` starts a scan; `/scans/[id]` shows coverage and actions; `/scans/[id]/issues` supports triage and exports; `/settings` controls reporting, performance, and MCP.
- `/links` is the Link checker design preview. It does not crawl links or store results.

The design uses Fraunces headings, Geist body/code fonts, Material Symbols, warm paper surfaces, black controls, and LIME yellow accents. Shared visual rules live in `src/app/globals.css`; shared page chrome lives in `src/components/app-sidebar.tsx` and `app-header.tsx`.

## Verification

```bash
npm --prefix lime run lint
cd lime && npx tsc --noEmit
```

From the repository root, `make verify-app` exercises existing dashboard features in a disposable production stack. `make docs-verify` separately checks the marketing website and documentation. See [Verification And Handoff](../docs/verification.md) for coverage, artifacts, prerequisites, and the latest recorded evidence. See [UI Architecture](../docs/architecture/ui.md) for data flow and component ownership.
