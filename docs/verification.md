# Testing LIME

Use LIME's test suites to check a change from the browser through the API and saved results. Start with the checks for the area you changed, then run the full product suite when the change affects scanning, reports, settings, or integrations.

## Run the project

From a new checkout, copy `.env.example` to `.env` and run `make start-all`. The dashboard opens at `http://localhost:3000/`. Use `make start-dev` for dashboard hot reload.

For the marketing site and documentation:

```bash
npm --prefix docs-site ci
make docs-dev
```

Open `http://localhost:3001/`. For a preview of the built static site, use `make docs-run`. See [Setup](setup.md) for prerequisites and port configuration.

## Ownership map

| Area | Main source directories |
| --- | --- |
| Scan lifecycle and API | `shopkeeper/internal/handler/`, `router/`, `scanner/` |
| Sitemap discovery | `shopkeeper/internal/profiler/` |
| Browser audits and screenshots | `shopkeeper/internal/juicer/`, `screenshots/` |
| Results and database migrations | `shopkeeper/internal/sweetner/`, `repository/`, `migrations/` |
| Dashboard and reports | `lime/src/app/`, `lime/src/components/`, `lime/src/lib/` |
| MCP | `lime/src/app/mcp/`, `lime/src/lib/mcp-dashboard-tools.ts`, `shopkeeper/internal/mcp/` |
| Link checks | `shopkeeper/internal/linkchecker/`, `repository/link_checks.go`, `handler/link_checks.go` |
| Marketing and documentation | `docs-site/`, `docs/` |

Shopkeeper manages scans, audit results, and screenshot files. The dashboard manages shared settings, score summaries, and report controls. Both services use the same database. See [UI Architecture](architecture/ui.md) and [Shopkeeper Architecture](architecture/shopkeeper.md) for request and data flow.

## Verification commands

Install the dependencies for the app you are testing. Browser checks also need Playwright Chromium:

```bash
npm --prefix docs-site ci
(cd docs-site && npx playwright install chromium)
```

| Change | Checks from the repository root |
| --- | --- |
| Go backend | `(cd shopkeeper && go test ./...)` |
| Dashboard | `npm --prefix lime run lint` and `(cd lime && npx tsc --noEmit)` |
| MCP routes and reports | `npm --prefix lime run test:mcp-transport` and `npm --prefix lime run test:mcp-dashboard-tools` |
| MCP settings | `node --test lime/scripts/verify-mcp-settings-timeouts.mjs` |
| Link-check client and presentation | `npm --prefix lime run test:link-check-api` and `npm --prefix lime run test:link-presentation` |
| Update notices | `npm --prefix lime run test:update-notice` |
| Agent configuration and skills | `npm --prefix agent test` |
| Marketing and docs | `npm --prefix docs-site run lint` and `make docs-verify` |

Run `make verify-app` for changes that affect product workflows. This builds and tests a complete LIME stack, including the dashboard, backend, database, MCP clients, and saved reports.

## Isolated product verification

`make verify-app` creates a separate Docker Compose project named `lime-verification`, with its own database and screenshot storage. Tests use local pages with known results, so the same failures, redirects, and recovery cases can be reproduced.

You need Docker Compose, curl, Bash, installed docs-site dependencies, and Playwright Chromium. The first run may download container images, packages, and the MCP bridge.

| Service | Default port |
| --- | --- |
| Dashboard | `14000` |
| Shopkeeper | `19080` |
| PostgreSQL | `16432` |
| Test pages | `19090` |

Override ports with `LIME_VERIFY_UI_PORT`, `LIME_VERIFY_API_PORT`, `LIME_VERIFY_DB_PORT`, and `LIME_VERIFY_FIXTURE_PORT`. Containers must be able to reach the test page server. Docker Desktop uses `host.docker.internal`; on Linux, set `LIME_VERIFY_FIXTURE_ORIGIN` to a reachable host address and the matching port.

```bash
LIME_VERIFY_UI_PORT=14001 LIME_VERIFY_FIXTURE_PORT=19091 make verify-app
```

The runner removes its test containers and volumes when it finishes, including after a failure. Results, logs, reports, and screenshots are saved in `.artifacts/verification/`. Copy results you want to keep before running the suite again.

## Existing feature matrix

| Area | What the suite checks |
| --- | --- |
| Scans | Single-page and sitemap scans, screen sizes, saved settings, discovery, and progress |
| Recovery | Pause/resume, failed-page retry, startup recovery, rescan, and deletion |
| Review | Grouped findings, pagination, false-positive decisions, scoring, and inherited decisions |
| Screenshots | Small previews, expanded images, yellow highlights, and keyboard dismissal |
| Reports | Scan-wide and issue-specific PDF, small/full CSV, LLM text, and disabled formats |
| Settings | Saved values, report limits, MCP access, and update preferences |
| Link checks | Crawling, result categories, source references, CSV, cancellation, rechecks, and scan companions |
| MCP | Read-only access, all action tools, report content, request replay, validation, and permission changes |
| Interface | Desktop/mobile layouts, navigation, forms, and dialogs |

Add a focused test when a bug depends on a particular site, large dataset, or deployment environment. See [Performance](performance.md) for guidance on measuring larger scans.

## MCP and AI client checks

For a read-only check against an already enabled instance:

```bash
export LIME_MCP_URL="http://localhost:3000/mcp"
export LIME_MCP_KEY="<your-generated-key>"
npm --prefix docs-site run verify:mcp
```

Set `LIME_MCP_SCAN_ID` or `LIME_MCP_LINK_CHECK_ID` to select particular saved results. The output lists which tools were called; an empty instance has no scan or link details to check. See [MCP Integration](mcp.md) for client setup.

To repeat full MCP tests during development, first start the disposable stack:

```bash
LIME_DOCS_DB_PORT=16432 LIME_DOCS_API_PORT=19080 LIME_DOCS_UI_PORT=14000 \
  docker compose -p lime-verification -f docker-compose.docs.yml up -d --build --wait
npm --prefix docs-site run verify:mcp-full -- --restart-backend
```

The focused runner changes test keys, permissions, settings, and records. It connects only to the disposable stack and leaves that stack running for debugging. `--restart-backend` restarts its backend to check recovery and saved request replay.

Optional commands against the same stack:

```bash
# Check installed Codex and OpenCode clients using an existing login
npm --prefix docs-site run verify:mcp-full -- --installed-only
# Check settings writes while a database row is locked
npm --prefix docs-site run verify:mcp-full -- --settings-lock-only
# Check the installed OpenClaw agent
npm --prefix agent run verify:openclaw -- --model "openai/<your-model>"
```

Replace `<your-model>` with a model available to your account. For OpenCode, `LIME_VERIFY_OPENCODE_MODEL` selects a model for that run and `LIME_VERIFY_OPENCODE_PURE=1` disables external plugins. Client tests use temporary configuration and may consume model usage. Run them one at a time because they share the test instance's MCP key and settings.

After the focused tests, remove the disposable stack:

```bash
LIME_DOCS_DB_PORT=16432 LIME_DOCS_API_PORT=19080 LIME_DOCS_UI_PORT=14000 \
  docker compose -p lime-verification -f docker-compose.docs.yml down --volumes
```

## Debugging a failed check

Start with the failed step and saved artifacts in `.artifacts/verification/`. Browser failures include a screenshot; stack failures include container logs.

- **Scan progress:** compare the scan's status and page counts with scanner logs and saved URL states.
- **Pause or resume:** check whether unfinished browser work was left pending rather than marked as a page failure.
- **Reports:** check the dashboard-to-backend connection and `REPORT_BASE_URL`.
- **Screenshots:** check both the saved database path and the screenshot volume.
- **Issue refresh:** inspect summary-cache replacement if requests fail after changing a false-positive decision.
- **Browser timeouts:** use page headings and controls to confirm readiness; progress polling can keep network activity open.
- **Port conflicts:** choose a free verification port without stopping unrelated services.

See [Operational Troubleshooting](deployment/troubleshooting.md) for service diagnostics.

## Workflow for future changes

1. Reproduce the behavior and identify the owning service.
2. Make the change and run the relevant source checks.
3. Run the product suite, docs suite, or both as needed.
4. Update the user guide, API reference, and changelog for behavior changes.
5. Include the commands, results, and any remaining limitations in the pull request.

Keep dated run logs and local environment notes in `docs/internal/`. That directory is for contributor handoff records and is excluded from the published website and search.
