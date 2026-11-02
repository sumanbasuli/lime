# v2 main-project verification — November 2, 2026

This record covers the application source prepared for the v2 commit and its local production-container checks.

## Retained installation

The existing database, screenshots, and private configuration were backed up under ignored `.artifacts/pre-v2-local-20261102-155641/` before startup. PostgreSQL upgraded from migration 13 to 20. All three completed scans, 69 saved pages, and nine issue groups remained present. Saved screenshot previews and expanded yellow highlights remained readable.

The rebuilt backend passed its Chromium sandbox/catalog preflight and became healthy with a 2 GiB memory ceiling and zero additional swap. Twenty checks passed across the direct API and dashboard proxy: health, saved scans/results, issue paging, screenshot bytes, invalid submissions, cross-origin write rejection, and untrusted Host rejection. A retained scan produced a full CSV with 215 evidence rows and a 57-page PDF. The PDF cover and saved screenshot lightbox were visually checked.

The main services remain available at `http://localhost:3000/` and `http://localhost:8081/api/health`; the API port comes from this checkout's existing configuration. User docs are available at `http://localhost:3001/docs/user/`.

## Corrections found during use

- Early clicks on the scan form could be lost before JavaScript handlers were ready. Holding the real application chunks reproduced the failure. The form now disables its controls until hydration completes. A durable browser regression holds those chunks, checks disabled controls, releases them, and verifies retained scan type, viewport, URL, tag, and link-check selection without saving a scan.
- The sidebar used a demo name and an old version. It now shows a neutral workspace label and the bundled application version.
- Link Checker treated connection hints as HTTP resources and could report false 404s for origin-only hint URLs. It now skips `link` elements whose nonempty relation set consists only of `preconnect` and `dns-prefetch`. Functional and mixed relations remain checked. Extraction and local HTTP tests verify that hint URLs receive no request while actual resources do. Saved historical results change only when users run a recheck.

## Completed checks

- Final host Docker application suite: **25/25 workflows passed**, exit 0, no browser errors. It includes scans, viewport/tag/search, pause/resume/restart, nested sitemaps, retries, screenshot preview/expansion, pagination, false positives, full/scoped reports, settings, Link Checker/companions/cancellation/history/exports, full MCP SDK v1/v2 reads and actions/replay/permissions, and responsive UI.
- Fresh disposable PostgreSQL 17.11: **425 top-level Go tests passed, 897 including subtests**, zero failures, 19 passing test packages, no SQL skips. Seventeen opt-in host-Chrome fixtures were not selected in this run; the Docker browser suite exercised the actual bundled Chromium workflows.
- Full Go suite and `go vet` passed after the final checker correction; focused Link Checker race tests passed.
- Dashboard lint and TypeScript passed. Dashboard fixtures passed 218 tests with three explicit optional-fixture skips in the initial database-free pass. Agent configuration tests passed nine tests.
- Guarded Unix-socket report SQL fixtures subsequently passed HTML report checks **2/2** and MCP report preparation **27/27**, with no SQL skips. These include the real cancellation and SQL cleanup deadlines. The MCP fixture's stale exact migration-count assertion was replaced with a minimum base-schema requirement and a contiguous sequence check so it applies all current migrations.
- Installer, Docker/native update, release-bundle, and Chromium policy checks passed.
- Public documentation coverage was checked against the current MCP, Link Checker, screenshots, checkpoint/recovery, and report features. No missing user guidance was found. The connection-hint behavior is documented. Docs lint/build/content/export passed with 38 guides, 83 checked examples, and 46 exported pages.

The final suite log is `.artifacts/verification/v2-local-final-full-run.log`; its `results.json` contains 25 passed entries and an empty `browserErrors` array. The database run is recorded in `v2-sql-integration-go.jsonl` and `v2-sql-integration-summary.json`; report SQL results are in `v2-report-sql-summary.json`. Hydration evidence is in `new-scan-hydration-results.json` and its before/after screenshots. The final mobile screenshot dialog and 320-pixel Link Checker views were visually reviewed.

The disposable application and SQL test projects, volumes, and credentials were removed after their runs. Their operations did not change the retained installation's scan/page/issue counts. No Git push or production deployment is part of this record.
