# Verification And Handoff

Use this guide when reviewing the redesign, reproducing a regression, or preparing to add a feature. Existing behavior should have a reproducible passing baseline before a new feature is added. Record what was actually exercised; a successful build alone does not prove scan lifecycle, screenshots, settings, or exports work together.

## Run The Project

For a new checkout, copy `.env.example` to `.env`, then run:

```bash
make start-all
```

The product dashboard is at `http://localhost:3000/`; Shopkeeper health is at `http://localhost:8080/api/health`. Use `make start-dev` for dashboard hot reload. `make stop-all` stops this project's services and keeps its data; `make clean` also removes its volumes and build artifacts, so use it only when you intend to discard that data.

To review the whole marketing website and docs:

```bash
npm --prefix docs-site ci
make docs-dev
```

Open `http://localhost:3001/` for the website or `http://localhost:3001/docs/` for the docs. `make docs-run` builds and serves the static export for deployment parity. Local port overrides are documented in [Setup](setup.md).

## Ownership Map

| Area | Source | Ownership |
|------|--------|-----------|
| Scan lifecycle and HTTP API | `shopkeeper/internal/handler/`, `router/`, `scanner/` | Create, pause, resume, retry, rescan, delete, startup recovery |
| URL discovery | `shopkeeper/internal/profiler/` | Sitemap/index traversal, URL eligibility, deduplication |
| Browser audits and captures | `shopkeeper/internal/juicer/`, `screenshots/` | axe-core execution, focused yellow highlight, preview/full images |
| Audit persistence | `shopkeeper/internal/sweetner/`, `repository/`, `migrations/` | URLs, audits, issues, occurrences, triage flags |
| Dashboard pages and chrome | `lime/src/app/`, `lime/src/components/` | Overview, lists, forms, progress, issue review, shared design |
| Next-owned APIs and caches | `lime/src/app/api/`, `lime/src/lib/` | Paginated issue reads, CSV/LLM exports, PDF controls, settings, derived read caches |
| Optional release notice | `lime/src/app/%5Flime/update-check/`, `lime/src/components/update-notice.tsx`, `lime/src/lib/update-notice-preference.ts` | Operator-enabled release check, browser-local visibility and release-tag dismissal |
| Shared metadata | `data/` | Local ACT and axe rule guidance used by both services |
| Website and documentation | `docs-site/`, `docs/` | Static product site, curated docs, reference Markdown, search and committed screenshots |

Shopkeeper owns writes to scan/audit results. Next owns application settings and derived score/issue-summary caches. Both need the same `DATABASE_URL`. Scan mutations and screenshots use the dashboard's same-origin proxy to `SHOPKEEPER_URL`; Next-owned APIs must be called on the dashboard origin. See [UI Architecture](architecture/ui.md) and [Shopkeeper Architecture](architecture/shopkeeper.md).

## Verification Commands

```bash
npm --prefix lime run lint
cd lime && npx tsc --noEmit
```

From the repository root:

```bash
cd shopkeeper && go test ./...
```

Run the integrated checks from the repository root:

```bash
make verify-app       # existing product features in an isolated production stack
make docs-verify      # website/docs build, assets, links, desktop/mobile interactions
```

The browser checks use Playwright from `docs-site`. Install its dependencies with `npm --prefix docs-site ci` and its browser with `cd docs-site && npx playwright install chromium` if the local browser cache is missing. Docker and Compose must be available for `make verify-app`. A first build may need network access to pull base images and install locked dependencies.

## Isolated Product Verification

`make verify-app` builds a production stack under the Compose project `lime-verification`, reusing the isolated service definition in `docker-compose.docs.yml`. It uses a disposable database and screenshot volumes. It does not discover normal local scans or change the normal instance's settings.

Default verification ports are:

| Service | Port |
|---------|------|
| Dashboard | `14000` |
| Shopkeeper | `19080` |
| PostgreSQL | `16432` |
| Deterministic fixture server | `19090` |

The fixture server supplies pages with known accessibility failures, sitemap inputs, delayed responses, and controlled navigation failures. On Docker Desktop for macOS, containers reach it through `host.docker.internal`. Linux users need a container-reachable fixture origin; set `LIME_VERIFY_FIXTURE_ORIGIN` to the host address reachable from those containers, including the fixture port.

The runner accepts `LIME_VERIFY_UI_PORT`, `LIME_VERIFY_API_PORT`, `LIME_VERIFY_DB_PORT`, and `LIME_VERIFY_FIXTURE_PORT` for port overrides. For example:

```bash
LIME_VERIFY_UI_PORT=14001 LIME_VERIFY_FIXTURE_PORT=19091 make verify-app
```

When overriding the fixture origin as well as its port, keep both values aligned.

The runner cleans up its own Compose project and volumes on completion or failure. Verification screenshots, exports, and result evidence live under the ignored `.artifacts/verification/` directory. `results.json` records completed workflows and browser errors; a failed browser check also saves `failure.png`, and the shell runner captures `docker.log` after a stack failure. Keep the normal stack running for local review; do not use `make clean` to reset verification data.

## Existing Feature Matrix

The required evidence below describes the product baseline. Runtime results must come from a completed run or a recorded manual check; source inspection establishes intended behavior only.

| Feature | Evidence to verify |
|---------|--------------------|
| Startup and runtime API | Production services become healthy; dashboard proxy returns health/version; pages render without browser errors |
| Single-page scans | Form creates a scan; target, tag, type and viewport persist; audit completes with saved URLs/issues |
| Viewport presets | Desktop/mobile representative scans persist the expected dimensions; form exposes all four presets |
| Sitemap and sitemap-index discovery | Eligible URLs are deduplicated and scanned; nested inputs and off-host filtering match Profiler rules |
| Scan navigation and progress | Leaving/reopening a scan preserves backend work; Overview/detail/list reflect persisted status and coverage |
| Tag filtering and search | Target/tag/type/status search and tag filters return the correct scans |
| Pause and resume | Pause reaches `paused` cooperatively; resume uses the same scan ID and preserves completed pages |
| Startup recovery | Interrupted active scans restart with the same ID; paused scans remain paused |
| Partial coverage and retry | A controlled failure is shown as partial coverage; retry repairs failed URLs in the same scan without replacing completed rows |
| Rescan and deletion | Rescan creates a new ID with original configuration; confirmed deletion removes only test scan rows/assets |
| Issue groups and pagination | Failed and review-only groups load; overlapping incomplete/failed rules are not duplicated; expansion fetches bounded occurrence details and metadata |
| False-positive triage | Mark/unmark persists; score/open counts and derived caches update; matching future scans inherit the latest decision without later changes altering saved child state |
| Screenshot evidence | Saved small preview loads; expanded lightbox uses the full highlighted capture; close/Escape works |
| Reports | Scan-level and issue-scoped PDF, small/full CSV, and LLM exports contain the expected scan/rule data |
| Settings | Reporting/performance/integration values persist after reload; disabled formats reject exports; values can be restored |
| Optional release notice | Disabled server endpoint returns 200; mocked newer release renders a card; browser visibility persists immediately; exact-tag dismissal survives reload |
| MCP | Disabled/unauthorized requests reject access; a generated key authenticates; tools read saved data and expose no mutation capability |
| Responsive redesign | Desktop and mobile routes are usable; navigation, forms, dialogs and controls have no unintended horizontal page overflow |
| Marketing and documentation | Static routes/assets/internal links pass; search, mobile navigation, gallery and roadmap render and interact correctly |
| Link checker preview | Navigation and target-entry design render; run action remains disabled; no check/result storage is claimed |

A small deterministic suite cannot establish behavior for every public site, very large report, browser/OS combination, or deployment target. Add a targeted reproduction when a regression depends on those conditions. See [Performance](performance.md) for large-scan concerns and deployment guides for release-specific checks.

## Current Verification Record

On October 5, 2026, the final `make verify-app` run completed successfully with all 16 workflows passed, process exit 0, and no browser errors. `.artifacts/verification/results.json` records completion at `2026-10-05T05:09:20.811Z` (10:39:20 IST), every evidence entry passed, and `browserErrors: []`.

An earlier 15-workflow candidate had incorrectly ignored a 404 from the optional release-notice endpoint. The endpoint lived under the App Router's private `_lime` folder, so it was not registered. Its source is now under `%5Flime`, preserving `/_lime/update-check`, and the outbound fetch has a five-second timeout. The final verifier does not ignore this error: it asserts the disabled endpoint returns 200 and checks a mocked notice's release link, immediate off/on browser preference, persistence, and exact-tag dismissal after reload. Different-tag redisplay is documented from the source contract, not claimed as a browser-tested scenario.

A controlled source experiment in `.artifacts/verification/update-check-branches.mjs` passed the disabled branch without an outbound fetch, newer/older/equal stable versions, draft/prerelease handling, upstream non-200 and thrown-abort fallbacks, and the configured 5,000 ms timeout and 1,800-second fetch cache policy. It uses mocked upstream responses and does not prove live GitHub availability.

The final production-stack run exercised scan creation and validation, tag/search, all four viewport presets, pause/resume and backend restart recovery, nested sitemap discovery/deduplication/off-host filtering, same-scan failed-page retry, issue/occurrence pagination, detail retry recovery, false-positive score/report state and inheritance, full/scoped exports, persisted settings/report gates, MCP authentication/read-only tools/key rotation, and rescan/deletion including saved assets. Seven dashboard routes passed layout/main-landmark checks at widths 1440, 768, 390, and 320; narrow-screen navigation, search, and the screenshot lightbox also passed. The distinct small preview and full capture retained yellow spotlight pixels and expanded context. The Link checker run action remained disabled as a design preview.

The checks found and verified corrections for out-of-order progress callbacks, omitted pagination defaults, issue-group reordering after triage, concurrent cache replacement, and narrow-header overflow. Scan progress now remains monotonic, and triage refresh/pagination returns complete unique groups. Issue-summary cache replacement holds the parent scan-row lock and skips obsolete or deleted snapshots; the final suite includes concurrent post-triage reads.

An additional isolated PostgreSQL experiment reproduced the previous duplicate-key error (`23505`), then passed 96 replacements over 16 connections with the corrected source. Stale snapshots preserved newer cache rows and a deleted scan did not regain cache data. The experiment is saved in `.artifacts/verification/cache-concurrency-check.mjs`; its temporary database was removed without touching the normal instance.

Full dashboard ESLint/TypeScript checks, the complete Go test suite, and Juicer race checks passed. The final run's isolated Compose project was empty after cleanup. The normal local stack was rebuilt with all three services healthy, preserving its aggregate counts of 2 scans, 6 issues, and 44 pages before and after; its restored release endpoint returned HTTP 200 with `enabled: false`. Fifteen read-only route/viewport combinations on the normal port-3000 instance passed at widths 1440, 390, and 320 before the final route-only rebuild; both existing scans remained completed. Its saved screenshot preview, expanded mobile lightbox, and Escape dismissal were also manually checked; the stable artifact is `.artifacts/verification/normal-screenshot-mobile-stable.png`.

An earlier 16-workflow attempt saw one unlocated React hydration warning (error 418) and correctly failed the strict browser-error gate despite its functional actions passing. The instrumented full rerun passed without it, as did 10 notice cycles, 28 responsive route checks, and 1,152 read-only rapid navigations across seven normal-instance routes at widths 1440, 768, 390, and 320. The 54.526-second stress check used DOMContentLoaded/main-heading readiness without waiting for fonts or animation frames, and recorded no page or console errors. The warning remains unreproduced: its cause was not established and no hydration fix is claimed. Keep strict error reporting and workflow context so a recurrence can be located instead of ignored.

Report verification produced a 37-page scan PDF. The latest final-run PDF's extracted text confirmed the fixture URL and failed-label finding and excluded `Skip to content`; skip navigation is hidden in print. Manual visual review sampled the cover, failed-label summary/evidence pages 9–10, and needs-review summary/evidence pages 36–37 from an equivalent fixture run, then confirmed the latest final run's refreshed cover. The selected pages had readable typography, guidance, URLs, and preserved yellow screenshot highlights. Artifacts are `.artifacts/verification/report-final-{cover,label,label-evidence,review,review-evidence}.png`. This is a five-page visual sample, not a review of every PDF page.

Completed documentation checks:

- Targeted docs ESLint and `npx tsc --noEmit` passed after the handoff and API updates.
- `make docs-verify` passed, including the production build and browser checks. Its static-export validator checked 41 HTML pages, internal links/assets, and committed product screenshots.
- Representative docs/website routes were checked at 1440×1000 and 390×844, including the new handoff guide and mobile roadmap. Documentation search, mobile navigation, and the screenshot gallery interaction passed without browser errors or unintended page overflow.
- The local static website and docs returned HTTP 200 on port 3001. The product dashboard returned HTTP 200 on port 3000, its proxied health route was healthy, and its Documentation link points to `https://lime.heysuman.com/docs/`.
- Visual review artifacts are `.artifacts/verification/docs-handoff-desktop.png`, `docs-api-desktop.png`, `docs-roadmap-desktop.png`, and `docs-roadmap-mobile.png`.

This record establishes the completed local deterministic baseline and records the earlier unreproduced warning. It does not claim every public website, every PDF page, large-site performance, every browser/OS, or each production deployment target was checked. Live GitHub calls and deployment/update scripts were not exercised by the deterministic suite; release-notice browser checks use mocked release metadata. When recording future passes, retain the commands, artifacts, tested viewports, corrected failures, and coverage limits; do not substitute screenshot generation or source inspection for lifecycle/report/settings assertions.

## Workflow For Future Changes

1. Locate the owning service and reproduce the current behavior before editing.
2. Make one behavior or design change at a time; preserve the screenshot highlight and preview/lightbox behavior.
3. Run focused lint/type/unit checks for the changed area.
4. Run `make verify-app` for product/API/lifecycle/report/settings changes, or `make docs-verify` for website/docs changes. Use both for a change that spans them.
5. Update user instructions in `docs-site/content/product-docs.ts`, reference docs under `docs/`, and the API manifest if endpoints change.
6. Run `make docs` when product screenshots need refreshing. It uses separate public demo scans; it is a documentation pipeline, not the product feature regression suite.
7. Record evidence and limitations here or in the change handoff. Update `CHANGELOG.md` for release-facing behavior.

The Link checker currently remains a design preview. Complete and verify existing features before adding its backend workflow. There is no profile/account management behind the sidebar identity display.

## Debugging A Failed Check

Use `docker compose ps`, `make logs-shopkeeper`, and `make logs-ui` for the normal stack. For a verifier failure, inspect the reported `.artifacts/verification/` files and the failed step before rerunning. A failed report may depend on the UI-to-Shopkeeper proxy and Shopkeeper-to-UI `REPORT_BASE_URL`; a screenshot failure may depend on stored files as well as database paths. A scan status issue should be traced from the browser request to handler/scanner logs and persisted URL states.

Use the rendered heading and expected controls to establish dashboard readiness. Background progress polling can prevent a `networkidle` wait from completing even when the page is usable; correlate a timeout with rendered content and server logs before treating it as a product failure.

If a scan is completed but its progress count is low, compare `scanned_urls` with the scan's terminal URL rows. Audit workers run concurrently; progress callbacks must remain serialized and monotonic so an older update cannot overwrite a newer count. See [Progress Ordering](architecture/shopkeeper.md#progress-ordering).

If issue refresh or pagination returns a duplicate-key error after triage, inspect `scan_issue_summary_cache` replacement and the parent scan's source timestamp. Concurrent replacements must hold the scan-row lock through their delete/insert transaction. See [Concurrent Cache Replacement](performance.md#concurrent-cache-replacement).

If `/_lime/update-check` returns 404, check the route's escaped `%5Flime` source directory. Next treats `_lime` as a private folder and will not register it. Server-disabled release checks should return HTTP 200 with `enabled: false`; do not suppress this 404 in browser verification. Notice display additionally depends on the browser preference and dismissed release tag described in [Updating LIME](deployment/updates.md).

If a port is occupied, identify its owner and change the configured port instead of stopping unrelated containers. Keep private scans out of documentation screenshots. See [Docs Site](docs-site.md) for the isolated screenshot refresh policy.
