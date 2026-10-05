# Verification And Handoff

Use this guide when reviewing the redesign, reproducing a regression, or preparing to add a feature. Existing behavior should have a reproducible passing baseline before a new feature is added. Record what was actually exercised; a successful build alone does not prove scan lifecycle, screenshots, settings, or exports work together.

## Start Here

- Running LIME: [Run The Project](#run-the-project), then [Setup](setup.md).
- Changing behavior: [Ownership Map](#ownership-map), [Verification Commands](#verification-commands), and [Workflow For Future Changes](#workflow-for-future-changes).
- Reproducing a regression: [Isolated Product Verification](#isolated-product-verification) and [Debugging A Failed Check](#debugging-a-failed-check).
- Checking a coverage claim: [Existing Feature Matrix](#existing-feature-matrix) and the [dated verification history](#dated-verification-history).

The latest Link Checker MCP run passed 24 full product workflows at `2026-10-05T12:55:12.165Z`, including existing accessibility, reports, settings and MCP flows, loaded responsive link layouts, and real SDK v1/v2 plus stdio-bridge reads of saved link evidence. Additional read-only checks covered the operator's saved link check without changing its results or settings. One earlier React hydration warning remains unreproduced; no cause or hydration fix is claimed. The dated history retains the tested configurations and limits of each check.

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
| External MCP integration | `lime/src/app/mcp/`, `lime/src/lib/shopkeeper-proxy.ts`, `shopkeeper/internal/mcp/` | Canonical dashboard proxy and existing-scorer enrichment; Go authentication, protocol, schemas, read-only tools and pagination |
| Optional release notice | `lime/src/app/%5Flime/update-check/`, `lime/src/components/update-notice.tsx`, `lime/src/lib/update-notice-preference.ts` | Default-enabled release check with server opt-out, browser-local visibility and release-tag dismissal |
| Link checking | `shopkeeper/internal/linkchecker/`, `repository/link_checks.go`, `handler/link_checks.go`, dashboard `/links` | Independent durable HTTP checks, bounded crawling, target/source evidence, companion opt-in and lifecycle |
| Shared metadata | `data/` | Local ACT and axe rule guidance used by both services |
| Website and documentation | `docs-site/`, `docs/` | Static product site, curated docs, reference Markdown, search and committed screenshots |

Shopkeeper owns writes to scan/audit results. Next owns application settings and derived score/issue-summary caches. Both need the same `DATABASE_URL`. Scan mutations and screenshots use the dashboard's same-origin proxy to `SHOPKEEPER_URL`; Next-owned APIs must be called on the dashboard origin. See [UI Architecture](architecture/ui.md) and [Shopkeeper Architecture](architecture/shopkeeper.md).

## Verification Commands

```bash
npm --prefix lime run lint
(cd lime && npx tsc --noEmit)
```

From the repository root:

```bash
(cd shopkeeper && go test ./...)
```

Run the integrated checks from the repository root:

```bash
make verify-app       # accessibility, MCP, link checking and lifecycle in an isolated production stack
make docs-verify      # website/docs build, assets, links, desktop/mobile interactions
```

For changes to the canonical MCP route or shared proxy, also run:

```bash
npm --prefix lime run test:mcp-transport
```

This executes the actual TypeScript route/helper source with controlled dependencies and a local gzip server. It requires the dashboard's installed dependencies and Node 23+ but no running LIME stack, database, MCP key, or settings changes. It does not replace `make verify-app`.

For the release-check default and best-effort route branches, run:

```bash
npm --prefix lime run test:update-notice
```

This executes the actual update route with mocked GitHub responses, without outbound calls or application-setting writes. Browser display preferences/dismissal and the full stack are checked separately by `make verify-app`.

For changes to the link-check API client, also run:

```bash
npm --prefix lime run test:link-check-api
npm --prefix lime run test:link-presentation
```

The API suite checks the actual TypeScript client with mocked requests: default-off/opt-in scan payloads, standalone creation, pagination/filter paths, lifecycle actions, reader-facing errors and abort signals. The presentation suite checks actual hostname parsing, brand/resource icon selection, invalid/hostile URL fallbacks, and safe local SVG markup. Neither runs a worker or proves HTTP reachability. The full `make verify-app` suite uses real controlled HTTP responses and durable database records; see [Link Checker Architecture](architecture/link-checker.md) for network policy and limits.

For an already-enabled instance, a separate read-only MCP SDK smoke check is available:

```bash
export LIME_MCP_URL="http://localhost:3000/mcp"
export LIME_MCP_KEY="<your-generated-key>"
npm --prefix docs-site run verify:mcp
```

It never generates keys or changes settings. Optional `LIME_MCP_SCAN_ID` selects a saved scan and `LIME_MCP_LINK_CHECK_ID` selects a saved link check; otherwise each latest returned record is used. The `checked` output identifies tools actually called, not just discovered: an empty instance can read scan/link history, link statistics and settings, but cannot exercise saved detail/source tools. A scan without an issue group cannot exercise issue detail; a scan without a link companion returns the explicit null-companion state. It defaults to pinned official SDK v1 `1.32.0`; set `LIME_MCP_SDK=v2` for the pinned `@modelcontextprotocol/client@2.3.0` in legacy `2025-11-25` mode. That does not upgrade LIME to modern 2026 discovery/capabilities. The sanitized transport trace excludes authorization headers and response bodies. See [MCP Integration](mcp.md) before connecting an AI client. This smoke check is not proof that an installed desktop/web client or a remote deployment has connected.

The browser checks use Playwright from `docs-site`. Install its dependencies with `npm --prefix docs-site ci` and its browser with `(cd docs-site && npx playwright install chromium)` if the local browser cache is missing. Bash must be on `PATH` for build-time documentation shell-example checks. Docker with the Compose plugin and curl must be available for `make verify-app`. A first build may need network access to pull base images and install locked dependencies. The real stdio-bridge check invokes pinned `mcp-remote@0.14.3` through npx and may also need package-download/cache access; it uses an ephemeral key and private temporary state.

## Isolated Product Verification

`make verify-app` builds a production stack under the Compose project `lime-verification`, reusing the isolated service definition in `docker-compose.docs.yml`. It uses a disposable database and screenshot volumes. It does not discover normal local scans or change the normal instance's settings.

Default verification ports are:

| Service | Port |
|---------|------|
| Dashboard | `14000` |
| Shopkeeper | `19080` |
| PostgreSQL | `16432` |
| Deterministic fixture server | `19090` |

The fixture server supplies pages with known accessibility failures, sitemap inputs, delayed responses, and controlled navigation failures. Link fixtures include healthy/broken destinations, redirect chains/loops, timeouts, HEAD fallback, document/media targets, blocked private destinations, repeated references, base URLs and restart recovery. On Docker Desktop for macOS, containers reach it through `host.docker.internal`. Linux users need a container-reachable fixture origin; set `LIME_VERIFY_FIXTURE_ORIGIN` to the host address reachable from those containers, including the fixture port.

The runner accepts `LIME_VERIFY_UI_PORT`, `LIME_VERIFY_API_PORT`, `LIME_VERIFY_DB_PORT`, and `LIME_VERIFY_FIXTURE_PORT` for port overrides. For example:

```bash
LIME_VERIFY_UI_PORT=14001 LIME_VERIFY_FIXTURE_PORT=19091 make verify-app
```

When overriding the fixture origin as well as its port, keep both values aligned.

The runner cleans up its own Compose project and volumes on completion or failure. Copy evidence you need to retain before another run; generated artifact paths are reused and are not an immutable archive. Verification screenshots, exports, and result evidence live under the ignored `.artifacts/verification/` directory. `results.json` records completed workflows and browser errors; a failed browser check also saves `failure.png`, and the shell runner captures `docker.log` after a stack failure. Keep the normal stack running for local review; do not use `make clean` to reset verification data.

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
| Optional release notice | Default-enabled server branch and explicit opt-out; disabled endpoint returns 200 without outbound calls; mocked newer release renders a card; browser visibility persists immediately; exact-tag dismissal survives reload |
| MCP | Pinned official SDK v1/v2 and real stdio-bridge initialization/tool reads; canonical cold/triaged scores, direct stale-cache behavior, issue and saved link-result/source pagination, companion/null states, screenshot/report/CSV paths, schema/errors, read-only capability, unchanged link evidence/settings, UI copy/settings/key rotation/disable |
| Responsive redesign | Desktop and mobile routes are usable; navigation, forms, dialogs and controls have no unintended horizontal page overflow |
| Marketing and documentation | Static routes/assets/internal links pass; search, mobile navigation, gallery and roadmap render and interact correctly |
| Link checker | Standalone single-page and bounded same-origin crawl create durable jobs; targets classify HTTP outcomes, redirects, errors and blocked destinations; source references, filters, pagination and CSV remain usable after reload; cancellation, recheck, deletion and interrupted-job recovery preserve saved state |
| Optional companion link check | New scans default off; opt-in waits for the original accessibility page inventory, respects pause/cancellation, preserves scoring and screenshots, copies configuration on rescan, and cascades only the original companion when its scan is deleted |

A small deterministic suite cannot establish behavior for every public site, very large report, browser/OS combination, or deployment target. Add a targeted reproduction when a regression depends on those conditions. See [Performance](performance.md) for large-scan concerns and deployment guides for release-specific checks.

## Workflow For Future Changes

1. Locate the owning service and reproduce the current behavior before editing.
2. Make one behavior or design change at a time; preserve the screenshot highlight and preview/lightbox behavior.
3. Run focused lint/type/unit checks for the changed area.
4. Run `make verify-app` for product/API/lifecycle/report/settings changes, or `make docs-verify` for website/docs changes. Use both for a change that spans them.
5. Update user instructions in `docs-site/content/product-docs.ts`, reference docs under `docs/`, and the API manifest if endpoints change.
6. Run `make docs` when product screenshots need refreshing. It uses separate public demo scans; it is a documentation pipeline, not the product feature regression suite.
7. Record evidence and limitations here or in the change handoff. Update `CHANGELOG.md` for release-facing behavior.

Link checking is an independent HTTP/HTML workflow; it does not execute page JavaScript or change accessibility scoring. Completed link checks are historical snapshots, not a guarantee that every link works. Record limits, unread source pages and inconclusive outcomes, and use Recheck for fresh evidence. There is no profile/account management behind the sidebar identity display.

## Debugging A Failed Check

Use `docker compose ps`, `make logs-shopkeeper`, and `make logs-ui` for the normal stack. For a verifier failure, inspect the reported `.artifacts/verification/` files and the failed step before rerunning. A failed report may depend on the UI-to-Shopkeeper proxy and Shopkeeper-to-UI `REPORT_BASE_URL`; a screenshot failure may depend on stored files as well as database paths. A scan status issue should be traced from the browser request to handler/scanner logs and persisted URL states.

Use the rendered heading and expected controls to establish dashboard readiness. Background progress polling can prevent a `networkidle` wait from completing even when the page is usable; correlate a timeout with rendered content and server logs before treating it as a product failure.

If a scan is completed but its progress count is low, compare `scanned_urls` with the scan's terminal URL rows. Audit workers run concurrently; progress callbacks must remain serialized and monotonic so an older update cannot overwrite a newer count. See [Progress Ordering](architecture/shopkeeper.md#progress-ordering).

If pause/resume leaves unexpected failed URLs, compare browser errors with the parent run's cancellation state. Interrupted Chromium startup errors can omit the cancellation cause; those operations must remain pending instead of being stored as genuine failures. A child page timeout on a still-active run remains a failure. See [Cancellation And Resume](architecture/juicer.md#cancellation-and-resume).

If issue refresh or pagination returns a duplicate-key error after triage, inspect `scan_issue_summary_cache` replacement and the parent scan's source timestamp. Concurrent replacements must hold the scan-row lock through their delete/insert transaction. See [Concurrent Cache Replacement](performance.md#concurrent-cache-replacement).

If `/_lime/update-check` returns 404, check the route's escaped `%5Flime` source directory. Next treats `_lime` as a private folder and will not register it. Server-disabled release checks should return HTTP 200 with `enabled: false`; do not suppress this 404 in browser verification. Notice display additionally depends on the browser preference and dismissed release tag described in [Updating LIME](deployment/updates.md).

If a port is occupied, identify its owner and change the configured port instead of stopping unrelated containers. Keep private scans out of documentation screenshots. See [Docs Site](docs-site.md) for the isolated screenshot refresh policy.

## Dated Verification History

These are completed checks of the source/configuration present at their stated times, not a guarantee for later changes. Ignored artifacts can be replaced by later runs or absent from a fresh checkout. Use the commands above to establish your own baseline; retain commands, timestamps, evidence, and limits when adding a new record.

### Completed Redesign Verification Record

Before the MCP extension, the redesign's October 5, 2026 `make verify-app` run completed successfully with all 16 workflows passed, process exit 0, and no browser errors. Its result recorded completion at `2026-10-05T05:09:20.811Z` (10:39:20 IST), every evidence entry passed, and `browserErrors: []`. Subsequent runs replace `.artifacts/verification/results.json`; the extension record below describes the newer check separately.

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

### MCP Integration Extension

The expanded `make verify-app` run passed all 18 workflows with process exit 0 and no browser errors on October 5, 2026, completing at `2026-10-05T06:43:34.650Z` (12:13:34.650 IST) with 18 passed evidence entries and `browserErrors: []`. This is a real SDK/browser/data integration result, separate from the redesign's earlier raw JSON-RPC checks. The disposable Compose project was empty after cleanup. The result artifacts have since been replaced by the refinement run recorded below; this timestamp is retained as historical evidence.

Both pinned official SDK generations read all six tools on the canonical dashboard endpoint. `.artifacts/verification/mcp-client-results.json` records v1 `@modelcontextprotocol/sdk@1.32.0` initialization/tool/notification responses, expected GET 405, and a rejected revoked-key request; the v2 `@modelcontextprotocol/client@2.3.0` result records all six checked tools with `era: "legacy"` and `version: "2025-11-25"`. Their sanitized traces exclude credentials and response bodies. This does not claim modern 2026 discovery/capabilities.

The run passed canonical cold-cache and triaged scoring, direct stale-cache behavior, detail lookup beyond offset 1,000 after inserting 1,005 synthetic groups, 32-occurrence pagination, real HTTP screenshot URLs, usable PDF/CSV/LLM downloads and format gates, localhost CORS, three supported 2025 protocol revisions, schema/tool errors, read-only boundaries, exact raw numeric JSON-RPC ID `9007199254740993` on both endpoints, and the Settings copy/draft/save/rotate/disable flow. The existing scoring algorithm was preserved: an earlier test incorrectly expected `excluded_count` to count false-positive marks; the correct assertions use group flags and filtered failed/scored counts.

Client setup examples are checked against their primary documentation. No user's AI client configuration or account was changed, and the suite does not prove each desktop/web client or a public remote deployment has connected. The large-group and pagination checks use deterministic synthetic data rather than a 1,000-page public website.

The backend handles uppercase failed-issue UUID keys by canonicalizing them. Legacy incomplete audit rows without stored node occurrences retain their summary count but return empty detail with `has_more: false`; the API does not manufacture selectors or screenshot evidence. Isolated SQL checks passed these cases and large-group detail reads. A prior SDK run exposed raw screenshot storage paths that were not HTTP URLs; MCP detail now adds dashboard-relative screenshot URL fields while retaining compatible raw paths, and the final suite fetched the real images successfully.

A candidate run exposed a real pause/resume regression: interrupted Chromium startups returned `chrome failed to start` without wrapping cancellation, so unfinished pages were incorrectly saved as failures and resume skipped them. Juicer now classifies a non-nil operation error as interrupted when the parent scan-run context is canceled. Active-run startup/navigation errors and local page timeouts still fail normally; successful operations remain valid. Eleven targeted cases in `shopkeeper/internal/juicer/cancellation_test.go`, the full uncached Go suite, and Juicer race checks passed. The final end-to-end run confirmed zero failed URLs at the paused boundary and all eight pages completed after resume. Spotlight preview/full images and responsive routes at 1440, 768, 390, and 320 pixels passed again. Screenshot rendering and the existing score algorithm are unchanged.

The normal local stack was rebuilt without removing its volumes. Read-only assertions confirmed the same 2 scans, 6 issues, and 44 pages, and exactly unchanged reporting/performance/integration settings. MCP remained disabled and unconfigured, with no key hint or rotation timestamp. The database and Shopkeeper were healthy; the UI container was running and its HTTP routes worked (the normal Compose UI has no container healthcheck). Proxied health returned `ok`; an unauthenticated MCP POST returned 401 with a Bearer authentication challenge. These normal-instance checks did not generate a key or write settings.

The rebuilt normal Settings page passed read-only checks at widths 1440, 390, and 320: no page overflow, browser errors, framework overlays, or duplicate main landmark. Its client-independent connection card displayed `http://localhost:3000/mcp`, the three copy-action labels, and the correct MCP guide link. Existing fields/formats and disabled/unconfigured MCP state were unchanged, with no freshly generated key. Verification blocked non-read requests and saw none; it did not click controls or access the clipboard. Artifacts are `.artifacts/verification/normal-mcp-settings-{1440,390,320}.png`; the desktop and 320-pixel images were visually reviewed.

Full docs ESLint and TypeScript checks passed for the MCP changes. `make docs-verify` passed the production export with 41 HTML pages and valid internal links/assets, then checked 12 representative desktop routes at 1440×1000 and seven mobile routes at 390×844, including the MCP and handoff guides. Search, mobile navigation, screenshot gallery interactions, and literal client environment/configuration examples passed without browser errors or page overflow. These docs checks do not run scans or configure AI clients.

Neither pinned official MCP client has a finding in the recorded npm audit, but that is not a security-clearance claim for the project. `.artifacts/verification/dependency-audit.json` covers the 711-dependency `docs-site` tree after the v1/v2 additions and records 25 vulnerable dependency entries (3 low, 4 moderate, 17 high, 1 critical), including direct Next, eslint-config-next and shadcn dependencies. These are aggregate package counts, not a count of individual advisories. Broad dependency upgrades are outside this MCP change. Review the critical findings and dependency backlog before a public production deployment; no live deployment or complete production security audit was performed.

### Further MCP Refinement Checks

Additional focused checks found stalled incoming request bodies could outlive the proxy deadline, body-read errors were uncontrolled, malformed backend URLs were not handled, and network errors could expose upstream configuration. The shared proxy now applies cancellation/deadlines while reading the body and fetching, returns controlled errors, and removes stale compression/length headers after Node fetch decodes a response. MCP retains its 1 MiB body limit and 30-second proxy deadline; separate score computation and report generation are not promised within that deadline.

The actual-source `npm --prefix lime run test:mcp-transport` suite passed all 14 checks. Coverage includes body size/cancellation/deadline, upstream fetch deadline, redacted network/configuration errors, a real local gzip response, exact numeric JSON-RPC IDs, authentication/protocol/status/CORS preservation, and consistent structured/text score results. Unauthorized or protocol-error responses do not trigger scoring; score-read failures preserve the ID/CORS while returning an actionable redacted tool error. These are controlled regressions, not a remote deployment or installed-client integration pass.

Go checks now reject exact fractional pagination values even when floating-point conversion would round them to integers, reject nonzero overflow/underflow edge cases, and reject explicit null tool arguments without reading data. Exact integer forms such as `1.0` and `1e2`, zero coefficients with extreme exponents, and omitted/empty optional arguments remain valid. The full Go suite and MCP race checks passed. Real isolated PostgreSQL checks passed deadlines for six blocked read paths (scan, saved score, issue groups, occurrence detail, authentication settings, visible settings), then confirmed pool recovery and subsequent reads; nullable legacy scores remained readable.

The standalone client instructions now use `.mts` for top-level `await`, a pinned runner, and explicit Node/npm/npx/PATH prerequisites. All five guide JSON examples parse and the standalone snippet compiles as ESM.

The subsequent full `make verify-app` run passed all 18 workflows with exit 0 at `2026-10-05T07:32:08.365Z` (13:02:08.365 IST), with 18 passed evidence entries and `browserErrors: []`; the disposable Compose project was empty afterward. Both official SDK generations again read all six tools. Raw requests on both endpoints also checked exact fractions, nonzero underflow/extreme offsets, explicit null arguments, and valid exact integer/zero-exponent values. Its result artifacts were later replaced by the release-default run below; this timestamp remains historical.

The real pinned `mcp-remote@0.14.3` subprocess bridged official SDK v1 `1.32.0` stdio messages to dashboard Streamable HTTP and read all six tools. Its `mcp-client-results.json` recorded the bridge version/tools and `cleanup: { launcherExited: true, callbackPortReleased: true }` alongside the v1/v2 evidence. The host used Node 24.18.0. The helper supplied its bearer value only through the child environment, used a temporary auth/cache directory, checked stderr did not expose the key, and removed its own temporary state. No user's client configuration, key, or normal-instance settings were changed. This is real bridge/protocol/data proof, not proof that each installed AI application or a public remote deployment connected.

The normal stack was then rebuilt from the refined source without removing its volumes. Read-only checks confirmed HTTP 200 on the home page, healthy proxied API status, and MCP HTTP 401 with `WWW-Authenticate: Bearer realm="LIME MCP"`. The same 2 scans, 6 issues, and 44 pages and exactly unchanged reporting/performance/integration settings were preserved; MCP remained disabled/unconfigured with null hint and generation timestamp. Database and backend containers were healthy, and the UI was running with functional HTTP (no normal UI container healthcheck). Full Go tests, focused MCP/repository/Juicer race checks, and dashboard ESLint/TypeScript checks passed.

Full docs ESLint and TypeScript checks, `git diff --check`, and `make docs-check-source` passed. The refinement's `make docs-verify` production export validated 41 HTML pages and internal assets/links, then checked 12 representative desktop and seven mobile routes, search, navigation, and screenshot-gallery interactions without browser errors or horizontal page overflow. Literal client examples also retained the environment placeholders, pinned bridge version, `.mts` filename, and transport-regression command. These documentation checks do not configure an AI client or run scans.

### Release Notice Default Change

The requested update-card change enables server release checks when `LIME_UPDATE_CHECK` is unset and changes normal/source and release Compose defaults to true. Operators can still set `LIME_UPDATE_CHECK=false`; existing false values, browser-off preferences, and exact-release dismissals remain respected. The browser preference already defaulted on. The isolated docs/verification Compose stack explicitly remains false, so deterministic checks do not depend on live GitHub calls. This changes notice defaults only, not automatic update installation or PostgreSQL settings.

The initial actual-source `npm --prefix lime run test:update-notice` suite passed six checks: unset/explicit-true enablement with a newer stable release, explicit-false disablement without outbound calls, best-effort network/status/JSON failures, draft/prerelease suppression, and up-to-date releases. Actual Compose resolution confirmed true defaults and explicit-false overrides in normal/source and release stacks, while docs/verification stayed false. Dashboard lint/TypeScript checks passed.

The new-default `make verify-app` run passed all 18 workflows with exit 0, completing at `2026-10-05T08:52:44.921Z` (14:22:44.921 IST). The current `.artifacts/verification/results.json` records 18 passed evidence entries and `browserErrors: []`; the disposable Compose project was empty after cleanup. Browser checks started with no saved visibility preference, confirmed the Update notice checkbox was on and a mocked newer-release card appeared, then passed off/reload, on, and exact-tag dismissal. GitHub responses were mocked; this does not claim live upstream availability.

The latest run also read all six tools through both official SDK generations and the pinned `mcp-remote@0.14.3` stdio bridge. The current `mcp-client-results.json` contains the bridge evidence with `launcherExited: true` and `callbackPortReleased: true`. All 14 focused MCP transport checks passed again. Normal client keys and PostgreSQL settings were not changed by verification.

The first normal rebuild preserved its database/volumes and the same 2 scans, 6 issues, and 44 pages and unchanged reporting/performance/integration settings; MCP remained disabled/unconfigured. However, its live endpoint returned `current: "0.0.0"`, `latest: "v1.0.5"`, and `outdated: true` because Compose supplied a placeholder version. A fresh read-only browser correctly showed the default-on checkbox, null saved visibility preference, and release card with no errors or non-read requests, but visual review identified that card as a false-positive release comparison. `.artifacts/verification/normal-update-default-on.png` is diagnostic evidence, not final proof of correct installed-version behavior; no controls or settings were changed.

The subsequent version correction uses the packaged dashboard version when `LIME_VERSION` is unset or blank, while preserving nonblank runtime/release-build overrides. The expanded actual-source `test:update-notice` suite passed all eight checks, including unset/empty/whitespace version fallback and an explicit `v1.0.4` override; dashboard lint/TypeScript checks and all 14 MCP transport checks passed. The final Docker UI build exited 0 without the JSON-import warning.

Corrected production HTTP returned 200 with `enabled: true`, `current: "1.0.5"`, `latest: "v1.0.5"`, and `outdated: false`, recording `checkedAt: "2026-10-05T09:02:55.307Z"` (14:32:55.307 IST). A fresh read-only normal Settings browser confirmed the default-on checkbox, null stored visibility preference, correct release version, and absence of the false update card, with no browser errors or non-read requests. The same 2 scans, 6 issues, and 44 pages and exactly unchanged reporting/performance/integration settings were preserved; MCP remained disabled/unconfigured. No controls or settings were changed. `.artifacts/verification/normal-update-version-corrected.png` was visually reviewed; the earlier diagnostic image was preserved.

The 08:52 full 18-workflow run preceded this final fallback correction. Its final verification is the eight actual-source checks and corrected production HTTP/browser check above; no later full-suite rerun is claimed for that last change. This single live release result does not establish future GitHub availability or every deployment target.

After the default/fallback documentation updates, full docs ESLint/TypeScript, `make docs-check-source`, and `git diff --check` passed. `make docs-verify` passed the 41-page production export/internal asset-link checks and 12 representative desktop plus seven mobile routes, including search, navigation, gallery, and literal client examples, without browser errors or page overflow. Current guides/API use default-on/server-opt-out wording and preserve the separate browser control.

The earlier records above describe their respective completed configurations, including disabled endpoint/normal-instance checks before this default changed. Their timestamps remain historical; the current result artifacts now belong to the 08:52 release-default run.

### Documentation Refinement

The October 5, 2026 review covered all 17 curated product/contributor guides, 19 repository reference guides, README, CONTRIBUTING, the API manifest, and public onboarding/roadmap copy. User instructions were checked against the current dashboard controls and API/source behavior. The documentation now separates user, operator, and developer reading paths and adds user troubleshooting/FAQ, operational troubleshooting, and backup/restore guidance. It distinguishes score from coverage, saved evidence from live page state, read-only MCP from ordinary unauthenticated HTTP routes, and the Link Checker design preview from working scan features.

Deployment and architecture guidance was source-reviewed, including Compose resolution, script syntax, migration/storage paths, scan recovery, worker concurrency, report limits, and reserved cache settings. Backup, restore, install, update, and provider deployment procedures were not executed against user data or a live provider. Follow each guide's prerequisites and rehearse recovery separately; a documentation check is not production recovery proof.

Completed documentation evidence:

- Full docs ESLint, TypeScript/build checks, `make docs-check-source`, and `git diff --check` passed.
- Content validation checked 36 guides and 78 JSON/shell examples, complete navigation registration, audience-specific reading order, source-reference paths, and actual Markdown helper regressions. Shell examples were syntax-checked, not executed.
- Static export validation checked 44 HTML pages, internal links and section anchors, headings, assets, and all nine committed product screenshots.
- The root-path browser pass completed at `2026-10-05T10:04:10.295Z`; the subsequent `LIME_DOCS_BASE_PATH=/lime make docs-verify` pass completed at `2026-10-05T10:10:43.342Z`. Each checked all 41 documentation/website routes at 1440×1000 and 390×844: 82 route/viewport checks, no browser errors, and no unintended horizontal page overflow.
- Reader checks exercised search and native keyboard activation/focus return, all nine user guides in sequence, mobile navigation and section links, visible headings below the sticky header, screenshot gallery open/close, and literal MCP environment/configuration examples. The project-path pass additionally checked the current-guide sidebar state, full breadcrumb title, and prefixed mobile link.
- The project-path check exposed a reproducible hydration mismatch: browser helpers lacked the public build-time prefix, while breadcrumb/sidebar matching incorrectly added a prefix to Next's already-unprefixed pathname. The corrected build shares the public prefix and compares route identities without it; no hydration errors were suppressed. This is separate from the earlier unreproduced dashboard warning.
- Visual review sampled the docs home, mobile first-scan guide, backup guide/table, and MCP guide. Evidence files are `.artifacts/verification/docs-{home-desktop,first-scan-mobile,backup-desktop,mcp-desktop}.png`, with readable desktop viewport samples in `docs-backup-viewport.png` and `docs-mcp-viewport.png`. Browser results are in `docs-refinement-results.json`; later runs replace these ignored artifacts.
- Read-only checks confirmed the normal instance still had 2 scans, 6 issues, and 44 pages, with exactly unchanged reporting/performance/integration settings and MCP still disabled/unconfigured.

This refinement changes documentation, docs-site presentation/navigation, and documentation verifiers only. It does not change backend/dashboard behavior, refresh product screenshots, configure an AI client, publish the website, or rerun the full product lifecycle suite. The earlier product verification records remain the applicable baseline for application behavior.

### Link Checker Extension

The stable redesign/documentation branch was committed as `535c433` and fast-forwarded into local `main`. The independent feature work is on `codex/link-checker`, based on that same commit. No remote push, public deployment, or feature release is implied by this local merge.

The first completed feature `make verify-app` run passed all 23 workflows with exit 0 at `2026-10-05T11:17:57.721Z`, with `browserErrors: []`. The suite retains the existing scan lifecycle, issue review, triage/scoring, yellow screenshot preview/full lightbox, PDF/CSV/LLM reports, settings, release-notice preferences, and actual MCP SDK v1/v2 plus stdio-bridge checks. Five new workflows cover standalone checking, crawl/history/source evidence, optional scan companions, cancellation/recovery/failures, and responsive integration. The default-off checkbox is asserted by its exact accessible name, **Include link check**.

Controlled HTTP fixtures establish healthy and broken targets, redirects and loops, request timeout, HEAD fallback, document/media destinations, base URLs, blocked cross-origin private destinations, and limited coverage. The browser creates jobs and reads persisted results, filters, expands source references, downloads CSV, cancels active jobs, rechecks into new IDs, and deletes terminal jobs. Forty-five retained references page through `20/20/5`; exports include all retained references, not only the five-reference result preview.

Companion checks wait for accessibility completion, use its persisted page inventory, remain queued while the parent is paused, and honor explicit cancellation after parent completion. Opt-in and plain scans produce equal accessibility scores and the same rule inventory. Rescan copies the opt-in flag; deleting a parent removes its original companion, not a detached recheck. Deleting a terminal companion leaves accessibility results intact and displays an explicit missing-companion state. An unstarted canceled companion without saved seed pages returns an actionable 409 for Recheck instead of inventing a new crawl. Interrupted standalone checks recover with their original IDs.

Focused verification passed:

- Full `go test ./...`, `go vet ./...`, and `go test -race ./internal/linkchecker ./internal/handler ./internal/repository`.
- Real isolated PostgreSQL checks for migration 13 up/down and preservation of a legacy scan, atomic scan/companion creation, snapshot/source pagination, cancellation and late writes, recovery, failed-only retry, and completed/canceled companion preservation.
- SQL tests retain the bounded 500-page companion inventory plus one overflow marker, including detached rechecks, and exercise concurrent parent retry/companion claim with the shared parent-first lock order. A CSV snapshot contains all seven retained test references while the result preview contains five.
- Dashboard and documentation ESLint/TypeScript checks, six actual-source link API client checks, 14 MCP transport checks, and eight release-notice checks. These focused tests supplement rather than replace the real stack run.

Early responsive screenshots contained loaders. A follow-up at `2026-10-05T11:25:56.739Z` waited for saved target rows, history, companion controls and fonts, then passed 24 loaded states at widths 1440, 768, 390 and 320 with no page overflow or browser errors. Visual review found the expanded source pagination cramped its own padded panel at 320px despite no page-level overflow. Its button group now wraps; the shared verifier additionally requires every source-pagination button to fit within the panel. The earlier page-level pass is not evidence for this final local-panel correction; retain the later full rerun below as its proof.

The extension's final `make verify-app` rerun completed at `2026-10-05T11:36:38.087Z` with exit 0, all 23 workflows passed, and `browserErrors: []`. Its responsive link workflow exercises all 24 loaded states and source-panel button bounds at the four widths. The refreshed 320px expanded-source screenshot was visually reviewed: both controls remain inside the panel on separate rows. The disposable Compose project was empty after cleanup. Later presentation checks replace `results.json` and `link-check-sources-{1440,768,390,320}.png`; the earlier focused `link-loaded-layout-results.json` remains diagnostic evidence predating the wrapping correction.

Candidate form runs exposed an overly broad checkbox accessible name that included icon/help text; the label now names only the control and uses a separate description. One candidate's injected issue-detail retry probe timed out without an established product cause. Read-only settled probes passed; the verifier now confirms its intercepted 503 response before retrying and retains actual probe state on failure. No hydration or issue-rendering fix is claimed for that timeout. Candidate evidence is retained in `link-candidate-checkbox-results.json` and `link-candidate-issue-retry-results.json` under the ignored verification directory.

`make docs` completed using separate public demo scans and a real standalone link check, never the operator's existing private data. All ten screenshot captures were refreshed, including the checkbox, live link history, and saved target/source results. The link images and new-scan form were visually reviewed. The production docs export validates 37 guides, 82 JSON/shell examples, 45 HTML pages, internal links/anchors/assets, and ten product screenshots. The `/lime` project-path `make docs-verify` pass completed at `2026-10-05T11:34:28.418Z`: all 42 website/docs routes at desktop and mobile widths, 84 route/viewport checks, plus search/keyboard focus, reading order, mobile navigation/section links, gallery, and literal MCP examples; no failures. Evidence is `link-docs-project-path-results.json`. These checks do not publish the website or execute deployment examples.

The final root-path `make docs-verify` pass completed at `2026-10-05T11:40:09.485Z`, validating the same 42 routes/84 desktop-mobile combinations and reader interactions without failures. Evidence is `link-docs-root-results.json`. The export was rebuilt once more after adding this evidence timestamp; that last change is documentation-only, not a subsequent product-code change or new full browser run.

Before the normal-instance migration, a validated custom-format `pg_dump` backup was saved locally as `.artifacts/verification/normal-before-link-checker.dump`. The normal stack was rebuilt without removing its PostgreSQL or screenshot volumes. Read-only before/after checks preserved 2 scans, 6 issues and 44 pages and exactly unchanged reporting/performance/integration settings. Both completed scans retained identical scan/issue JSON hashes after excluding only the newly added default-false field. MCP remained disabled/unconfigured. Migration 13 reports `dirty=false`, every existing scan has `include_link_check=false`, and link jobs/results were not added retroactively. Evidence is `normal-link-check-before.json` and `normal-link-check-after.json`; backups and private evidence are ignored local artifacts, not public screenshots or committed data.

After rebuilding the normal UI with the final wrapping change, read-only browser checks completed at `2026-10-05T11:36:08.633Z`. Link history/form, new scan with the default-off checkbox, and an existing completed scan passed nine route/width combinations at 1440, 390 and 320, with one main landmark, no page overflow, no browser errors and no non-read requests. Settings, aggregate counts and zero link jobs were checked again; both saved scans still had no associated check. Evidence is `normal-link-browser-results.json` and `normal-link-new-scan-{1440,390,320}.png`. No job was submitted or preference changed on the operator instance.

This establishes a deterministic local integration baseline, not universal public-site reachability, arbitrary-size crawl completeness, JavaScript-rendered link extraction, load capacity, recovery on every provider, or production security clearance. The checker is bounded, static HTTP/HTML and one-shot; use the canonical root origin and read coverage/inconclusive outcomes. Existing locked dependency audit warnings remain a separate upgrade/security backlog, not resolved by this feature. See [Link Checker Architecture](architecture/link-checker.md) for request budgets, network trust and known limits. No user's AI client, keys, unrelated containers, or normal settings were changed.

### Link Result Presentation Refinement

The saved check reported by the operator exposed a very long query URL, repeated source references, empty captured text and a LinkedIn HTTP 999 response. This refinement changes presentation only: locally bundled MIT-licensed Bootstrap SVG icons, hostname/brand headings, full destination URLs in expanded panels, numbered source cards, outcome filters, run timestamps and elapsed time. Backend classifications, HTTP codes, saved evidence, accessibility scoring and screenshot behavior are unchanged. HTTP 999 remains its recorded Broken outcome and is explicitly described as a non-standard response requiring manual verification, not proof that a profile is missing. Empty captured text is not described as an accessibility finding.

Read-only browser checks of that actual saved check completed at `2026-10-05T12:16:33.615Z` at widths 1440, 768, 390 and 320. Brand icons, outcome filters, expanded full URLs/source fields and narrow layouts passed with no page overflow, browser errors or non-read requests. Before/after job, result and source JSON hashes were identical, as were normal settings and scan statistics. Private evidence is kept only in ignored `link-ui-saved-before.json`, `link-ui-saved-browser-results.json` and `link-ui-after-expanded-*.png`; it is not used in public documentation images.

The final `make verify-app` run completed at `2026-10-05T12:23:12.922Z` with exit 0, all 23 workflows passed and `browserErrors: []`. In addition to the retained lifecycle/report/MCP and 24 loaded layout states, its controlled presentation probe checked all six outcome filters, parsed brand/lookalike URLs, HTTP 999 guidance, full long URLs, repeated/empty/synthetic source evidence, and 45-reference pagination through 20/20/5. An intentionally injected 503 hid stale rows; Retry sources recovered the same offset before reaching the last page. Only that exact expected response was allowed; no unexpected errors were suppressed. `link-check-presentation-results.json` records four additional layout states, requests `[0,20,20,40]`, one injected failure and no unexpected errors. The disposable verification stack and volumes were removed by the runner; normal data was untouched.

Dashboard/docs ESLint, dashboard TypeScript, six actual-source API checks and seven actual-source presentation checks passed. One initial Docker dependency install failed with `esbuild ETXTBSY`; an unchanged retry built and passed. A test-only Playwright context setup error was corrected before the successful presentation checks; no product change is claimed for either launch failure.

The two public Link Checker screenshots were refreshed from an existing completed `fake-university.com` check in the isolated `lime-docs` stack, not from the operator's saved check. They show a saved historical HTTP snapshot, not freshly verified public-site availability. The capture runner now gives expanded result evidence a 1440×1600 viewport and resets other captures to 1440×1000. User instructions and the architecture guide document the icons, source fields, timestamps, outcome meanings and pagination recovery.

Root-path `make docs-verify` passed at `2026-10-05T12:29:21.322Z`: 37 guides, 82 JSON/shell examples, 45 exported HTML pages, ten screenshot assets, and all 42 website/docs routes at desktop/mobile widths (84 combinations), with no browser failures. Search, reading order, section navigation and screenshot interactions passed. Evidence is `docs-refinement-results.json`. Visual review then increased only the public detail screenshot height so its complete first source card fits; the final export was rebuilt after that image and this evidence note. No later full browser rerun or public deployment is implied by that documentation-only rebuild. The temporary docs containers were stopped without removing their retained demo volumes; normal LIME remains running.

### Link Checker MCP Extension

Six saved-link tools were added alongside the original six accessibility/settings tools. They reuse read-only repository methods for history, job metadata/statistics, scan companions, filtered destinations and complete retained source paging. The existing `/mcp` endpoint, bearer key, supported 2025 protocol revisions and client setup remain unchanged. Dashboard and CSV paths resolve on the dashboard origin; these ordinary HTTP routes do not inherit MCP authorization. The canonical proxy leaves link data unchanged and does not invoke the accessibility scorer for it. No link-check create/recheck/cancel/delete or settings/triage mutation tool was introduced.

The final isolated `make verify-app` run completed at `2026-10-05T12:55:12.165Z` with exit 0, all 24 workflows passed and `browserErrors: []`. It retains the existing lifecycle, screenshots, reports, settings and accessibility MCP checks and adds an explicit saved-link SDK/bridge workflow. `link-mcp-client-results.json` completed at `2026-10-05T12:55:09.023Z` and records:

- Real SDK v1 `1.32.0` and split-package v2 `2.3.0` clients, each executing all six new tools through the canonical endpoint in the supported legacy protocol mode.
- History/target/source default, bounded, exhausted and filtered pages matching exact saved REST data. Forty-five repeated references returned as 20/20/5; raw HTTP 999 remained its saved Broken category/code. CSV metadata resolved to an actual saved export.
- Present companions, ordinary no-companion scans and selected-but-deleted companions; missing scans/checks and mismatched result ownership returned tool errors rather than invented evidence.
- Forty-six invalid calls per SDK plus four rejected link mutation tool names, missing/wrong-key rejection, and matching structured/text results. Snapshot comparisons preserved link-check/result rows, scan rows and non-secret settings.
- The real pinned `mcp-remote@0.14.3` stdio bridge reading all twelve tools, unchanged saved rows/settings, exited launcher and released callback port. No user's client config or key was changed; generated credentials belonged only to the disposable stack and were not written into evidence.

An earlier candidate incorrectly expected nine called tools for empty link history, but the preceding pause/resume workflow already supplied a completed companion. The client correctly read all twelve. Only the verifier's assertion was corrected before the successful full rerun; no product fix or empty-history runtime result is claimed for that failure. Empty/absent data handling has focused Go coverage and the smoke command reports only tools actually called.

Full Go tests/vet and MCP race checks passed, as did dashboard/docs ESLint and TypeScript, fifteen actual-source MCP transport checks, six link API checks, seven presentation checks and eight update-notice checks. The new transport case proves saved link fields and numeric JSON-RPC IDs pass through byte-for-byte without score enrichment. A sandbox-only loopback-listen restriction was resolved by running the temporary-server test with its required permission; no error was suppressed or product code changed.

The normal backend/dashboard were rebuilt with existing volumes retained. Read-only checks completed at `2026-10-05T12:53:28.552Z`: Settings and the operator's saved expanded link check passed at 1440, 768, 390 and 320px, with no page overflow, browser errors or non-read requests. Saved check/result/source, scan statistics, link statistics and settings hashes matched their pre-rebuild values. MCP stayed disabled/unconfigured, as before, and unauthenticated `tools/list` returned 401. Evidence is `normal-link-mcp-before.json`, `normal-link-mcp-after.json` and the visually reviewed `normal-link-mcp-settings-320.png`. The normal instance was not temporarily enabled just for testing; authenticated SDK/bridge proof comes from the isolated stack.

User MCP and Link Checker guides, API/architecture references, Settings help, README, marketing copy and changelog now describe the twelve-tool scope, pagination/coverage, CSV paths, companion semantics, prompt recipes and untrusted captured evidence. Root-path `make docs-verify` passed at `2026-10-05T12:47:38.698Z` with 37 guides, 82 JSON/shell examples, 45 exported HTML pages, ten screenshot assets and 84 desktop/mobile checks across 42 routes, with no failures. This evidence note was added afterward and the export rebuilt; no later full docs browser rerun is claimed. The isolated product containers/volumes were cleaned up, and normal LIME remains healthy on port 3000. This is local deterministic integration evidence, not proof that every installed AI client or public deployment has connected, or that historical link outcomes establish current availability.
