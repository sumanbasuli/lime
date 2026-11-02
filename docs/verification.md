# Testing LIME

Use LIME's test suites to check a change from the browser through the API and saved results. Start with the checks for the area you changed, then run the full product suite when the change affects scanning, reports, settings, or integrations.

## Run the project

From a new checkout, start Docker, then run `make init-env` and `make start-all`. The initializer creates a private database password and refuses existing `.env` files and database volumes. The dashboard opens at `http://localhost:3000/`. Use `make start-dev` for dashboard hot reload.

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
| Sitemap discovery | `shopkeeper/internal/profiler/`, `scanner/discovery.go`, `repository/discovery.go`, migration `000020` |
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
| MCP report preparation | `npm --prefix lime run test:mcp-report-read` (no database); `npm --prefix lime run test:mcp-report-preparation` requires the disposable private-socket PostgreSQL fixture described in the internal verification guide and otherwise explicitly skips SQL cases |
| HTML/PDF report size | `npm --prefix lime run test:html-report-read` for the page/data boundary; `npm --prefix lime run test:html-report-sql-fixture` is an opt-in real PostgreSQL check and skips its SQL case without `LIME_TEST_DATABASE_URL` |
| Browser write boundary | `npm --prefix lime run test:ordinary-api-origin` and `(cd shopkeeper && go test ./internal/router)` |
| Host admission and backend memory defaults | `npm --prefix lime run test:allowed-hosts`, `(cd shopkeeper && go test ./internal/router)`, and `node scripts/verify-backend-memory.mjs` (all three Compose files, release archive, native unit; Docker Compose CLI needed, but the daemon stays stopped) |
| Native nginx example | `LIME_TEST_NGINX=/absolute/path/to/nginx npm --prefix lime run test:nginx-proxy` (private HTTP/HTTPS/HTTP2 fixtures; needs OpenSSL and never uses an installed service; skips explicitly when the binary is not selected) |
| Runtime version consistency | `npm --prefix lime run test:runtime-versions` (Go/Node image and CI pins, both Next lockfiles, prerequisites, and bundled PostgreSQL) |
| Native production dependency installation | `node --test scripts/verify-native-build.mjs` (actual Makefile with fake npm; install/build failure and stale-dependency controls) and `bash scripts/verify-debian-cutover.sh` |
| Release bundle path safety | `node --test scripts/verify-release-bundle.mjs` (disposable checkout fixture; rejects unsafe versions and keeps ordinary Makefile/direct-script builds working) |
| Release image publishing | `bash scripts/verify-release-image-tags.sh` (disposable local Git remote and fake Docker; tag claims, clean build context, both builds before the first push, and failure handling) |
| Fresh source credentials | `node scripts/verify-init-env.mjs` (private random `.env`, no overwrite, symlink and malformed-template guards; no Docker daemon) |
| Isolated verification credentials | `node --test scripts/verify-docs-db-credential.mjs` (random and explicit secrets, retained-project refusal, daemon-free Compose interpolation) |
| Scan browser network and evidence limits | `(cd shopkeeper && go test ./internal/egressproxy ./internal/juicer ./internal/profiler ./internal/scanner)`; for opt-in local Chrome fixtures, set `LIME_TEST_CHROME` to the browser binary and run those packages with `-run 'TestChrome|TestPageScanProtects|TestFullPageClipGeometry'` |
| Scan checkpoints and screenshot access | `(cd shopkeeper && go test ./internal/scanner ./internal/juicer ./internal/screenshots ./internal/handler)`; repository recovery and screenshot-visibility SQL tests run with `LIME_TEST_DATABASE_URL` pointed only at a disposable PostgreSQL database and otherwise skip |
| Checkpointed sitemap discovery | `(cd shopkeeper && go test ./internal/profiler ./internal/scanner ./internal/repository)`; set `LIME_TEST_DATABASE_URL` to a disposable PostgreSQL database for SQL checkpoint, publication, migration, and restart cases. Cover ten-minute requeue, pause/resume, retained request/XML counters, nested failures, legacy saved scans, and all-or-nothing URL publication. No host Docker service is required for the focused tests. |
| External database backup argument safety | `bash scripts/verify-backup-argv.sh` |
| Installer hot-reload ports | `node --test scripts/verify-start-dev.mjs` (Compose config check runs when the CLI is available; no daemon is used) |
| MCP settings | `node --test lime/scripts/verify-mcp-settings-timeouts.mjs` |
| Link-check client and presentation | `npm --prefix lime run test:link-check-api` and `npm --prefix lime run test:link-presentation` |
| Link-check source storage | `(cd shopkeeper && go test ./internal/repository -run 'TestLinkSource|TestStreamLinkExport|TestLinkCheckSource')` with `LIME_TEST_DATABASE_URL` pointed only at a disposable PostgreSQL database; covers legacy/row storage, migration down/up, paging, MCP admission, replay, and CSV snapshots |
| Update notices | `npm --prefix lime run test:update-notice` |
| Agent configuration and skills | `npm --prefix agent test` |
| Marketing and docs | `npm --prefix docs-site run lint` and `make docs-verify` |

Run `make verify-app` for changes that affect product workflows. This builds and tests a complete LIME stack, including the dashboard, backend, database, MCP clients, and saved reports.

## Isolated product verification

`make verify-app` creates a separate Docker Compose project named `lime-verification`, with its own database and screenshot storage. Tests use local pages with known results, so the same failures, redirects, and recovery cases can be reproduced.

The runner generates a fresh database password for a new test stack and refuses to take over an existing `lime-verification` project or volume. Inspect any leftover project before removing its test data. A password supplied to a previously initialized PostgreSQL volume cannot be changed just by editing the Compose environment; use that volume's original password or deliberately replace only the disposable test volume.

You need Docker Compose, curl, Bash, installed docs-site dependencies, and Playwright Chromium. The first run may download container images, packages, and the MCP bridge.
On Linux, the runner adds the repository's verification-only `host-gateway` override so the container can reach the controlled fixture on the host. Docker Desktop supplies that hostname directly on macOS.

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

For issue CSV spreadsheet safety without starting the full stack, run `npm --prefix lime run test:issues-report-csv`. It exercises the small and streaming formats with formula-like scan evidence.

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
export LIME_DOCS_DB_PASSWORD="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')"
LIME_DOCS_DB_PORT=16432 LIME_DOCS_API_PORT=19080 LIME_DOCS_UI_PORT=14000 \
  docker compose -p lime-verification -f docker-compose.docs.yml up -d --build --wait
npm --prefix docs-site run verify:mcp-full -- --restart-backend
```

Keep `LIME_DOCS_DB_PASSWORD` exported for the focused tests, including the database-lock check. The focused runner changes test keys, permissions, settings, and records. It connects only to the disposable stack and leaves that stack running for debugging. `--restart-backend` restarts its backend to check recovery and saved request replay.
The demo database, API, and dashboard ports bind to localhost by default. For intentional access from another machine, set `LIME_DOCS_API_BIND_HOST=0.0.0.0` or `LIME_DOCS_UI_BIND_HOST=0.0.0.0` and protect these unauthenticated test services with a firewall or access proxy. The verification commands still connect through localhost, so binding to only a specific LAN address would make their local checks fail.

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
unset LIME_DOCS_DB_PASSWORD
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
