# Verification And Handoff

Use this guide when reviewing the redesign, reproducing a regression, or preparing to add a feature. Existing behavior should have a reproducible passing baseline before a new feature is added. Record what was actually exercised; a successful build alone does not prove scan lifecycle, screenshots, settings, or exports work together.

## Start Here

- Running LIME: [Run The Project](#run-the-project), then [Setup](../setup.md).
- Changing behavior: [Ownership Map](#ownership-map), [Verification Commands](#verification-commands), and [Workflow For Future Changes](#workflow-for-future-changes).
- Reproducing a regression: [Isolated Product Verification](#isolated-product-verification) and [Debugging A Failed Check](#debugging-a-failed-check).
- Checking a coverage claim: [Existing Feature Matrix](#existing-feature-matrix) and the [dated verification history](#dated-verification-history).
- Checking the packaged assistant: [LIME agent and OpenClaw](agent-verification.md#verified-local-baseline-on-october-6-2026), including the exact isolated profile, real-model boundaries, and retained evidence.
- Checking the required browser sandbox and later security baseline: [October 26 sandbox verification](chromium-sandbox-2026-10-26.md), including the fresh 25-workflow run and retained legacy screenshot-volume check.

The October 6 LIME 2.0 baseline passed a clean isolated production-stack `make verify-app` run at `2026-10-06T06:13:35.133Z`: all 25 workflows passed with `browserErrors: []`, including twenty operational MCP SDK/UI phases. Canonical MCP exposes 17 read tools or 29 with explicit operator-enabled writes; existing keys remain read-only by default. The [October 6 operational MCP record](#full-operational-mcp-2-0-october-6-2026) separates that product baseline, earlier failed candidates, and real installed-client evidence. Codex completed its actual workflow. Installed OpenCode authenticated and discovered all 29 tools, but its existing configured provider and authorized free-model retries rejected model execution before tools; its model workflow remains incomplete. The runner removed its disposable stack/volumes afterward; the normal instance was not rebuilt or reconfigured by those checks. One earlier React hydration warning remains unreproduced; no cause or hydration fix is claimed. Later security patches need their own verification record.

## Run The Project

For a new checkout, run `make init-env`, then run:

```bash
make start-all
```

The product dashboard is at `http://localhost:3000/`; Shopkeeper health is at `http://localhost:8080/api/health`. Use `make start-dev` for dashboard hot reload. `make stop-all` stops this project's services and keeps its data; `make clean` also removes its volumes and build artifacts, so use it only when you intend to discard that data.

To review the whole marketing website and docs:

```bash
npm --prefix docs-site ci
make docs-dev
```

Open `http://localhost:3001/` for the website or `http://localhost:3001/docs/` for the docs. `make docs-run` builds and serves the static export for deployment parity. Local port overrides are documented in [Setup](../setup.md).

## Ownership Map

| Area | Source | Ownership |
|------|--------|-----------|
| Scan lifecycle and HTTP API | `shopkeeper/internal/handler/`, `router/`, `scanner/` | Create, pause, resume, retry, rescan, delete, startup recovery |
| URL discovery | `shopkeeper/internal/profiler/` | Sitemap/index traversal, URL eligibility, deduplication |
| Browser audits and captures | `shopkeeper/internal/juicer/`, `screenshots/` | axe-core execution, focused yellow highlight, preview/full images |
| Audit persistence | `shopkeeper/internal/sweetner/`, `repository/`, `migrations/` | URLs, audits, issues, occurrences, triage flags |
| Dashboard pages and chrome | `lime/src/app/`, `lime/src/components/` | Overview, lists, forms, progress, issue review, shared design |
| Next-owned APIs and caches | `lime/src/app/api/`, `lime/src/lib/` | Paginated issue reads, CSV/LLM exports, PDF controls, settings, derived read caches |
| External MCP integration | `lime/src/app/mcp/`, `lime/src/lib/mcp-dashboard-tools.ts`, `shopkeeper/internal/mcp/` | Authenticated canonical score/evidence/settings results; Go protocol, read/write schemas, live permission checks and existing-handler actions; durable request ledger |
| Optional release notice | `lime/src/app/%5Flime/update-check/`, `lime/src/components/update-notice.tsx`, `lime/src/lib/update-notice-preference.ts` | Default-enabled release check with server opt-out, browser-local visibility and release-tag dismissal |
| Link checking | `shopkeeper/internal/linkchecker/`, `repository/link_checks.go`, `handler/link_checks.go`, dashboard `/links` | Independent durable HTTP checks, bounded crawling, target/source evidence, companion opt-in and lifecycle |
| Shared metadata | `data/` | Local ACT and axe rule guidance used by both services |
| Website and documentation | `docs-site/`, `docs/` | Static product site, curated docs, reference Markdown, search and committed screenshots |

Shopkeeper owns writes to scan/audit results. Next owns application settings and derived score/issue-summary caches. Both need the same `DATABASE_URL`. Scan mutations and screenshots use the dashboard's same-origin proxy to `SHOPKEEPER_URL`; Next-owned APIs must be called on the dashboard origin. See [UI Architecture](../architecture/ui.md) and [Shopkeeper Architecture](../architecture/shopkeeper.md).

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
npm --prefix lime run test:mcp-dashboard-tools
npm --prefix lime run test:mcp-report-read
node --test lime/scripts/verify-mcp-settings-timeouts.mjs
```

These execute the actual TypeScript route/helper source with controlled service boundaries and a local gzip server. They cover canonical marker dispatch, revoked access, scoped reports, content types, byte/hash metadata, artifact limits, cancellation and handler/body deadlines. Authenticated `get_scan` score/database enrichment shares the canonical operation's 30-second deadline and request-abort handling; blocked or late reads produce a controlled tool error rather than a late success. They require the dashboard's installed dependencies and Node 24.22.1+ on the 24.x LTS line, or a newer maintained release with current security patches, but no running LIME stack, database, MCP key, or settings changes. They do not replace `make verify-app`.

The four settings-source tests check that MCP-only transaction-local PostgreSQL lock/statement limits precede insert/row locking, failed writes roll back without update/commit, live authorization is rechecked under the lock, and ordinary dashboard saves introduce no such limits or pool changes. These are controlled transaction boundaries, not proof of live PostgreSQL timeout behavior.

### MCP report preparation SQL fixture

`npm --prefix lime run test:mcp-report-read` checks the database-read budget and connection lifecycle without a server. `npm --prefix lime run test:mcp-report-preparation` exercises the actual CSV/LLM routes, loaders, scoring, SQL preflight, snapshots, and output limits against PostgreSQL. Without `LIME_TEST_DATABASE_URL` it explicitly skips the SQL suite; do not count that run as database verification.

The SQL suite accepts only a dedicated `lime_report` database on a private temporary Unix socket, verifies the server's data directory and lack of TCP access, creates a random schema, applies all migrations inside it, and drops only that schema afterward. Never point it at an existing LIME database. With PostgreSQL 17 binaries already on `PATH`, a maintainer can create a disposable fixture from the repository root:

```bash
lime_report_fixture=$(mktemp -d /tmp/lime-pg-report-XXXXXXXX)
mkdir -p "$lime_report_fixture/pg/socket"
initdb -D "$lime_report_fixture/pg/data" --auth=trust --no-locale --encoding=UTF8
pg_ctl -D "$lime_report_fixture/pg/data" -l "$lime_report_fixture/pg/server.log" \
  -o "-c listen_addresses='' -k $lime_report_fixture/pg/socket -p55439" -w start
env -u PGHOSTADDR -u PGSERVICE -u PGSERVICEFILE -u PGUSER \
  createdb -h "$lime_report_fixture/pg/socket" -p55439 lime_report
env -u PGHOSTADDR -u PGSERVICE -u PGSERVICEFILE -u PGUSER \
  LIME_TEST_DATABASE_URL="postgresql://localhost/lime_report?host=$lime_report_fixture/pg/socket&port=55439&sslmode=disable" \
  npm --prefix lime run test:mcp-report-preparation
pg_ctl -D "$lime_report_fixture/pg/data" -m fast -w stop
```

The test includes a real cancelled SQL statement and may take about 30 seconds while its admission lease is retained. Stop the temporary server even after a failed test, then remove only the exact temporary folder you created when finished inspecting it. No Docker service or ordinary dashboard instance is needed. This recipe requires PostgreSQL tools; it does not install or alter a system database service.

The isolated product runner also verifies the complete 17-read/29-full MCP contract through pinned SDK v1/v2 clients, including real jobs, lifecycle, triage, settings, report contents, saved screenshot bytes, request replay across backend restarts and live write revocation. Existing keys remain read-only unless the instance owner saves **Allow MCP write actions** in Settings.

For a focused MCP rerun while debugging an **already-running disposable `lime-verification` stack**:

```bash
npm --prefix docs-site run verify:mcp-full -- --restart-backend
# Optional installed-client/provider checks against that same disposable stack:
LIME_VERIFY_INSTALLED_CLIENTS=1 npm --prefix docs-site run verify:mcp-full -- --restart-backend
```

This attaches to existing healthy verification services; it does **not** automatically start, stop, or clean up a Compose stack/database/volume. It starts and closes its own deterministic fixture server and browser, and exercises actual write/key/settings actions on the disposable instance. Never point it at normal/private instance ports or run it while another runner owns its fixture port. Defaults are dashboard `14000`, backend `19080`, and fixture `19090`; `--base-url`/`--api-url` may select guarded non-normal loopback ports, and the fixture environment overrides described below remain available. `--restart-backend` explicitly opts into restarting only `lime-verification`'s Shopkeeper for durable replay/recovery assertions. Evidence goes to `.artifacts/verification/full-mcp-focused/` by default, with `--output-dir` restricted to the verification artifact directory. Retain results and handle the disposable stack's cleanup yourself after debugging. Use `make verify-app` for the normal complete build/start/product-baseline/MCP/cleanup workflow.

To rerun only the installed clients against that already-running disposable stack, without repeating the SDK flows:

```bash
npm --prefix docs-site run verify:mcp-full -- --installed-only --output-dir "$PWD/.artifacts/verification/installed-mcp-final"
```

Run this command from the repository root so the output path resolves under its verification artifacts. This generates a disposable instance key, temporarily enables MCP/write access, and restores the previous enabled/write flags afterward. It starts its own fixture server/browser and does not start or remove the Compose stack. The run exits nonzero if either real client workflow, verified fixture-job cleanup, or unchanged user configuration is missing; handshake-only discovery cannot substitute for executed tools. Keep earlier results separately before reusing an output directory.

If OpenCode's default model is unavailable, choose an already-configured provider/model from its installed catalog for this invocation only:

```bash
LIME_VERIFY_OPENCODE_MODEL="<configured-provider/model>" npm --prefix docs-site run verify:mcp-full -- --installed-only --output-dir "$PWD/.artifacts/verification/installed-mcp-explicit-model"
```

This passes a runtime `--model` override, not a global provider/configuration or authentication change. An advertised catalog entry does not guarantee that the existing account can run it; provider failures remain incomplete workflows, even when MCP discovery succeeds. Use a working existing client launch/configuration rather than adding or changing credentials just to make a check pass.

To additionally disable external OpenCode plugins for that one invocation:

```bash
LIME_VERIFY_OPENCODE_PURE=1 LIME_VERIFY_OPENCODE_MODEL="<configured-provider/model>" npm --prefix docs-site run verify:mcp-full -- --installed-only --output-dir "$PWD/.artifacts/verification/installed-mcp-pure"
```

This uses installed OpenCode's native `--pure` option; its result records whether external plugins were disabled. The temporary test configuration allows only `lime_*` without prompting, leaves other permissions at native `ask`, and supplies no dangerous skip-permissions flag or shell grant. In this non-interactive run, unrelated permission requests are rejected rather than approved. Built-in tool schemas remain available to the native client/provider, but neither their presence nor free-model discovery counts as permission to execute them or proves provider availability.

For actual PostgreSQL settings contention on the already-running disposable stack:

```bash
npm --prefix docs-site run verify:mcp-full -- --settings-lock-only
```

This mode requires the exact disposable dashboard/backend ports `14000`/`19080`, PostgreSQL port `16432`, and database `lime_docs_db`. It generates a disposable key and temporarily enables MCP/write access; never run it concurrently with another client test using that key. It holds a verifier-owned settings-row lock, observes the real MCP save waiting, proves rollback before controlled failure and no late commit after releasing the lock, then retries/restores its owned setting and previous reporting/performance/permission flags. It uses no fixture server or browser and does not start, stop, or clean the Compose stack. Its dedicated test connections do not change application pool configuration. Results default to `.artifacts/verification/settings-lock-focused/`. These five-second lock and twenty-second per-statement guards do not bound pool checkout, network waits or the whole RPC.

For the full-MCP verifier's secret/error and installed-workflow success guards:

```bash
npm --prefix docs-site run test:mcp-errors
```

These seven unit tests check that truthful unsupported-field names such as `mcp_key_hash` are not falsely classified as leaked values, while actual dummy key/hash values and SQL/panic/credential-URL details remain rejected without echoing secrets. The installed-workflow guards require both clients to execute their actual workflows, unchanged user configuration, and verified cleanup of every traced owned job; discovery-only, nested failures, and missing cleanup cannot pass. They test the verifier, not a product endpoint or a complete runtime workflow.

To additionally exercise installed client binaries with the operator's existing login/provider, opt in explicitly:

```bash
LIME_VERIFY_INSTALLED_CLIENTS=1 make verify-app
```

This uses temporary runtime MCP configuration and a loopback trace proxy against the disposable stack. It does not edit global Codex/OpenCode configuration or perform a new login/reconfiguration; normal CLI execution may refresh its existing authentication/session caches. Only configuration files are fingerprinted for the unchanged-configuration assertion. `installed-mcp-client-results.json` distinguishes successful tool workflows from handshake-only or provider failures; a passing SDK test does not imply either CLI's model provider was available. CLI traces redact the disposable key, and only fixture jobs are eligible for cleanup.

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

The API suite checks the actual TypeScript client with mocked requests: default-off/opt-in scan payloads, standalone creation, pagination/filter paths, lifecycle actions, reader-facing errors and abort signals. The presentation suite checks actual hostname parsing, brand/resource icon selection, invalid/hostile URL fallbacks, and safe local SVG markup. Neither runs a worker or proves HTTP reachability. The full `make verify-app` suite uses real controlled HTTP responses and durable database records; see [Link Checker Architecture](../architecture/link-checker.md) for network policy and limits.

For an already-enabled instance, a separate read-only MCP SDK smoke check is available:

```bash
export LIME_MCP_URL="http://localhost:3000/mcp"
export LIME_MCP_KEY="<your-generated-key>"
npm --prefix docs-site run verify:mcp
```

It never generates keys or changes settings. Optional `LIME_MCP_SCAN_ID` selects a saved scan and `LIME_MCP_LINK_CHECK_ID` selects a saved link check; otherwise each latest returned record is used. The `checked` output identifies tools actually called, not just discovered: an empty instance can read scan/link history, link statistics and settings, but cannot exercise saved detail/source tools. A scan without an issue group cannot exercise issue detail; a scan without a link companion returns the explicit null-companion state. It defaults to pinned official SDK v1 `1.32.0`; set `LIME_MCP_SDK=v2` for the pinned `@modelcontextprotocol/client@2.3.0` in legacy `2025-11-25` mode. That does not upgrade LIME to modern 2026 discovery/capabilities. The sanitized transport trace excludes authorization headers and response bodies. See [MCP Integration](../mcp.md) before connecting an AI client. This smoke check is not proof that an installed desktop/web client or a remote deployment has connected.

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
| MCP evidence and read-only mode | Permission-aware discovery of 17 canonical read tools; pinned SDK v1/v2 and stdio-bridge reads; fresh canonical scores/direct stale-cache boundary; issue/link paging and companion states; actual report/screenshot/link-CSV content, byte counts/hashes and 4 MiB rejection; schema/errors and unchanged saved data for reads |
| MCP operational mode | Operator-confirmed persisted write opt-in, 29-tool discovery and all twelve action tools actually called; real scan/link lifecycle, companion/scoring isolation, reversible triage, report/performance persistence/gates, no integration/key escalation; human-confirmation arguments, durable replay/conflicts/interruption/restart behavior and live revocation |
| Installed MCP clients | Real installed-client handshake and tools, plus recorded tool calls through its actual model/provider when available; temporary configuration, sanitized trace and fixture-only changes; do not equate tool discovery, SDK success or provider failure with a complete installed-client workflow |
| Responsive redesign | Desktop and mobile routes are usable; navigation, forms, dialogs and controls have no unintended horizontal page overflow |
| Marketing and documentation | Static routes/assets/internal links pass; search, mobile navigation, gallery and roadmap render and interact correctly |
| Link checker | Standalone single-page and bounded same-origin crawl create durable jobs; targets classify HTTP outcomes, redirects, errors and blocked destinations; source references, filters, pagination and CSV remain usable after reload; cancellation, recheck, deletion and interrupted-job recovery preserve saved state |
| Optional companion link check | New scans default off; opt-in waits for the original accessibility page inventory, respects pause/cancellation, preserves scoring and screenshots, copies configuration on rescan, and cascades only the original companion when its scan is deleted |

A small deterministic suite cannot establish behavior for every public site, very large report, browser/OS combination, or deployment target. Add a targeted reproduction when a regression depends on those conditions. See [Performance](../performance.md) for large-scan concerns and deployment guides for release-specific checks.

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

If a scan is completed but its progress count is low, compare `scanned_urls` with the scan's terminal URL rows. Audit workers run concurrently; progress callbacks must remain serialized and monotonic so an older update cannot overwrite a newer count. See [Progress Ordering](../architecture/shopkeeper.md#progress-ordering).

If pause/resume leaves unexpected failed URLs, compare browser errors with the parent run's cancellation state. Interrupted Chromium startup errors can omit the cancellation cause; those operations must remain pending instead of being stored as genuine failures. A child page timeout on a still-active run remains a failure. See [Cancellation And Resume](../architecture/juicer.md#cancellation-and-resume).

If issue refresh or pagination returns a duplicate-key error after triage, inspect `scan_issue_summary_cache` replacement and the parent scan's source timestamp. Concurrent replacements must hold the scan-row lock through their delete/insert transaction. See [Concurrent Cache Replacement](../performance.md#concurrent-cache-replacement).

If `/_lime/update-check` returns 404, check the route's escaped `%5Flime` source directory. Next treats `_lime` as a private folder and will not register it. Server-disabled release checks should return HTTP 200 with `enabled: false`; do not suppress this 404 in browser verification. Notice display additionally depends on the browser preference and dismissed release tag described in [Updating LIME](../deployment/updates.md).

If a port is occupied, identify its owner and change the configured port instead of stopping unrelated containers. Keep private scans out of documentation screenshots. See [Docs Site](../docs-site.md) for the isolated screenshot refresh policy.

## Dated Verification History

These are completed checks of the source/configuration present at their stated times, not a guarantee for later changes. Ignored artifacts can be replaced by later runs or absent from a fresh checkout. Use the commands above to establish your own baseline; retain commands, timestamps, evidence, and limits when adding a new record.

### November 2 checkpointed-discovery final verification

Migration `000020` adds durable sitemap and probe checkpoints, ten-minute discovery admissions, cumulative request/XML budgets without a cumulative 30-minute terminal cap, epoch fencing, and atomic publication of the complete eligible URL list. Focused PostgreSQL 17 migration/SQL and HTTP tests exercised budget boundaries, DFS order and deduplication, pause/restart recovery, stale admissions, DNS policy, and publication rollback. The owned Debian 12 arm64 VM built the candidate and completed all 25 application workflows. After the final parser cap and defensive probe fixes were merged, the VM resynced the original checkout, rebuilt the images, and passed all 25 workflows again with exactly 25 PASS lines and process exit 0. Focused PostgreSQL 17 migration, scanner HTTP/SQL, and Profiler checkpoint tests passed from that same source; Shopkeeper's cgroup reported 2 GiB memory and zero swap. Guest logs are `~/lime-discovery-final-original-verify.log` and `~/lime-discovery-final-sql-http-tests.log`. The verification project and separate owned PostgreSQL fixture were removed; host Docker stayed stopped. The full Go suite, changed-package race tests, `go vet`, docs-site lint/build/47-page export, deployment helper mocks, and fresh `govulncheck` also passed in the original checkout. Detailed evidence is retained in the target-bound Codex Security collection at `artifacts/validation/nov2-discovery-checkpoint-final.md`. These checks do not establish a large-site load result or production cutover.

### November 2 security regression run before checkpointed discovery

An owned Debian 12 arm64 VM built the then-current source with the checked-in Linux verification override and ran `scripts/verify-app.sh` to completion: all 25 workflows passed, including scans, screenshots, reports, Link Checker, lifecycle recovery, and the full MCP SDK/action sequence. Docker applied `Memory=MemorySwap=2147483648` to Shopkeeper; the container reported `memory.max=2147483648` and `memory.swap.max=0`. The verification containers and volumes were removed afterward. The host Docker daemon was not started, and an unrelated native fixture in the guest was not changed. The guest log is `~/lime-runtime-nov2-verify-final-edge.log`; it is retained in the owned VM, not bundled with this repository.

On that same pre-discovery-patch source, the full uncached Go suite, Juicer/router/Link Checker race tests, `go vet`, a real Chrome frame-integrity suite, the dashboard production build, and the docs-site lint/build/static export passed. The focused Chrome suite covered forged child results, genuine same-origin and out-of-process findings, reversed nested frame target order, stable full scans, late-frame failure without saved evidence, and child screenshot omission. A fresh `govulncheck ./...` found no reachable Go vulnerabilities after the x/net update. Host allowlist and backend memory policy fixtures passed; the isolated runtime run exercised the actual limits. At that time sitemap discovery still preceded the page slices; the later checkpointed-discovery result is recorded above and in [Security hardening handoff](security-hardening-2026-10-07.md). This is not a live cutover, production-host audit, or large-site load test.

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

This establishes a deterministic local integration baseline, not universal public-site reachability, arbitrary-size crawl completeness, JavaScript-rendered link extraction, load capacity, recovery on every provider, or production security clearance. The checker is bounded, static HTTP/HTML and one-shot; use the canonical root origin and read coverage/inconclusive outcomes. Existing locked dependency audit warnings remain a separate upgrade/security backlog, not resolved by this feature. See [Link Checker Architecture](../architecture/link-checker.md) for request budgets, network trust and known limits. No user's AI client, keys, unrelated containers, or normal settings were changed.

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

### Marketing Availability And Website Review

The October 5–6, 2026 UTC review replaced stale current-feature preview/unreleased labels across the homepage, roadmap, onboarding, API catalog and rendered guides. Current 2.0 capabilities are distinct from older published downloads and genuine future/validation work. Copy now describes configured axe-core checks, best-effort screenshot evidence, bounded HTTP/HTML link checking, report/recovery limits and twelve read-only MCP tools. User instructions include Codex, Claude Code and both OpenCode configuration generations. Installation commands and GitHub README instructions were not changed by this marketing review.

Public-main source links that returned 404 were replaced with version-relative checkout paths and a working repository link. The marketing gallery now uses a native modal, initial close-button focus, contained keyboard navigation, keyboard-scrollable images, Escape/button/backdrop dismissal, background scroll locking and thumbnail focus restoration. Actual image dimensions are supplied to static-export-safe Next images. Visual review corrected the modal header alignment and increased the viewer focus-ring contrast; product screenshot assets and the dashboard's yellow-highlight/preview behavior were not changed.

Completed local evidence:

- Production build/TypeScript, full docs ESLint, five API code-format/copy-source tests and `git diff --check` passed. Content validation checked 37 guides and 85 JSON/shell examples; static validation checked 45 HTML pages, internal links/anchors/assets and ten screenshot images. Examples were parsed or syntax-checked, not executed.
- The all-route normal-motion reader pass completed at `2026-10-05T18:26:45.564Z`: 42 routes at 1440 and 390 pixels, 84 combinations, no failures/browser errors/page overflow, plus search, reading order, mobile menus/section links and gallery interactions. Evidence is `.artifacts/verification/docs-refinement-results.json`.
- API/roadmap verification completed at `2026-10-05T18:26:20.866Z`: nine route/viewport combinations at 1440, 390 and 320 pixels, all 36 endpoint cards, 52 exact-text copy panels per width, denied-clipboard guidance, native keyboard notes and current/validation/future status anchors. A normal-motion mobile API interaction smoke check also passed. Evidence is `.artifacts/verification/api-roadmap-polish/results.json`.
- The final broad marketing run completed at `2026-10-05T22:09:46.545Z`: 21 route/viewport combinations at those three widths, eight current feature cards, installer copy/help and denied-clipboard handling, mobile navigation, decoded images and first/last expanded screenshot keyboard/scroll/dismissal behavior. Local links, image/resource/browser error, stale-label and overflow checks passed. Desktop navigation reached a generic `networkidle` wait timeout; that run is not a wholly passing local interaction result. Native scrolling and image loading use bounded state checks, including the intended image source. Evidence is `.artifacts/verification/marketing-current/results.json`, with final `after-` screenshots visually reviewed. An earlier completed run at `18:28:33.846Z` reported no local failures, but its full JSON was overwritten by subsequent runs; no reconstructed report is claimed. The mixed-build image-timeout rehearsal is retained separately as `results-rehearsal-during-rebuild-20261005T183010.json`.
- The navigation verifier now awaits the matching URL, active navigation link and visible page heading instead of generic network idle. A focused check of that actual function completed with exit 0 at `2026-10-06T04:36:01.733Z`: 15 successful route hops across 1440, 390 and 320 pixels, with no browser/resource errors or failures. The function was extracted from the verifier's TypeScript AST and its source hash recorded; no replacement navigation implementation was tested. Evidence is `.artifacts/verification/marketing-current/marketing-navigation-smoke.json`. The broad timeout report remains unchanged; no subsequent whole-marketing rerun or product-navigation defect/fix is claimed.

The broad marketing command exited 1 for the navigation wait above and one genuine publication gap: `https://lime.heysuman.com/install.sh` returned HTTP 404. The local exported script returned 200; 76 other checked links returned successful responses, including the official OpenAI documentation redirect. No external link was left unverified in this run. The public GitHub latest release was still `v1.0.5` during the review. Publish the installer/site and matching application release before assuming public installation supplies the current capabilities; this local review does not publish, push or commit them.

See [Docs Site](../docs-site.md) for repeatable focused commands. This evidence note was added and the export rebuilt after the browser checks above; that final rebuild is documentation-only, not a later complete browser/product run. No normal-instance data, settings, client credentials, containers, VPS resources or backend behavior were changed by the marketing review. Earlier dated records remain the applicable product-runtime baseline.

### Full Operational MCP 2.0 — October 6, 2026

The current contract adds opt-in scan/link lifecycle, reversible failed-issue triage, and report/performance changes to MCP, plus capability/workspace reads and bounded materialized report/screenshot/link-CSV evidence. Canonical dashboard `/mcp` exposes 17 read tools by default or 29 with operator-enabled **Allow MCP write actions**. Migration 14 leaves existing keys read-only; MCP cannot change its own permissions, keys, or integration settings. New-job request UUIDs are reserved in PostgreSQL before execution, completed responses replay, changed arguments conflict, and unfinished uncertain reservations never automatically relaunch. Deletion and settings changes require explicit confirmation arguments. See [MCP Integration](../mcp.md) for exact contracts and boundaries.

Completed focused checks of this source:

- The complete Go suite passed with the race detector; MCP protocol/action tests passed with 90.9% package coverage, and Go vet passed. Real isolated PostgreSQL tests checked migration-14 upgrade default-false behavior, down/up preservation of prior key credentials, twelve concurrent request reservations, persisted response replay after repository restart, and reuse conflicts. These exercise actual SQL, not mocked persistence, but do not establish every deployment's upgrade/restore path.
- The actual-source canonical dashboard suite passed 23 Node tests. Controlled service boundaries covered scan-owned failed-issue UUID and needs-review report scope, actual content packet shapes and hashes, image/CSV/PDF/LLM MIME and empty/PDF-magic validation, 4 MiB rejection, caller/deadline/queued-body cancellation, authentication/database waits, late-response discard, revoked access, settings allowlists/locked permission checks, and backend-only trusted marker dispatch. The final two route regressions cover blocked `get_scan` score/database enrichment under the same 30-second canonical deadline and caller abort, returning controlled errors without late success. These are unit/service-boundary checks, not a live complete product run.
- The four actual-source settings-transaction tests passed. The subsequent real PostgreSQL lock proof completed at `2026-10-06T05:56:23.122Z` (11:26:23.122 IST), observing actual blocking through `pg_blocking_pids` and a controlled MCP failure after 5,020 milliseconds. The settings row was unchanged while held and after release; the blocked transaction had rolled back before failure, no write remained queued, and releasing the lock produced no late commit. A real canonical retry succeeded, the original value was restored, and `browserErrors: []` was recorded (this mode starts no browser). Evidence is `.artifacts/verification/settings-lock-focused/focused-results.json`. The limits are MCP-only transaction-local PostgreSQL guards, not a universal five/twenty/thirty-second RPC or pool/network bound; ordinary dashboard saves and application pool defaults are unchanged.
- The final MCP-focused Node suites passed 49 checks: 23 canonical dashboard, fifteen transport, four settings-transaction, and seven verifier secret/error/installed-workflow success guards. Eight client-configuration, eight update-notice, six link API, and seven presentation checks also passed, as did dashboard/docs lint and TypeScript and `git diff --check`. The existing scoring algorithm and screenshot spotlight/preview behavior were not changed by the MCP extension. The final Go MCP/repository race rerun passed; SQL integration cases with their test environment unset were skipped in that rerun, not new database proof. Actual SQL migration/ledger and settings-lock evidence is recorded separately above.
- The final documentation production build passed with 37 guides, 93 valid JSON/shell examples, 45 exported HTML pages, and internal-link/anchor/asset/screenshot validation. Examples were parsed or syntax-checked, not executed. The earlier normal-motion all-route reader pass at `2026-10-06T05:00:12.413Z` (10:30:12.413 IST) checked 42 routes, 84 desktop/mobile combinations, reader interactions, and `failures: []`; its result is retained as `.artifacts/verification/full-mcp-docs-before-final-results.json`, because the standard reader artifact is replaced by subsequent runs. The later final-copy reader proof is recorded below.
- Fresh API/roadmap verification completed at `2026-10-06T05:02:48.286Z` (10:32:48.286 IST): nine route/viewport combinations at 1440, 390, and 320 pixels, all 36 endpoint cards and 52 exact-text copy panels per width, denied-clipboard guidance, native notes/status anchors, and a normal-motion mobile interaction smoke. It recorded no errors, overflow, or failures. The result was preserved as `.artifacts/verification/full-mcp-api-roadmap-results.json`; the older `api-roadmap-polish/results.json` is a different dated run.

The clean final-source complete product baseline finished at `2026-10-06T06:13:35.133Z` (11:43:35.133 IST) with process exit 0, all 25 named workflows passed, and `browserErrors: []`. It retains the 23 preceding scan/report/settings/read-MCP/link-check workflows, adds the operational full-MCP workflow, and completes desktop/tablet/mobile route, navigation, search, and screenshot-layout checks at 1440, 768, 390, and 320 pixels. Real scan creation/coverage, pause/resume/restart recovery, same-ID retry, issue/occurrence paging, false-positive scoring/inheritance, yellow spotlight thumbnail/full capture, full/scoped exports, report gates, read SDK v1/v2/stdio bridge, link HTTP/source/CSV behavior, companions, cancellation/recovery, and deletion all passed together. The original result is `.artifacts/verification/results.json`; the retained copy is `full-mcp-final-product-results.json`.

That final run's `.artifacts/verification/full-mcp-client-results.json` completed at `2026-10-06T06:13:31.745Z` (11:43:31.745 IST), with exactly twenty named SDK/UI phases passed and no nested installed-client result. Both SDK generations actually exercised all twelve write tools, real persisted jobs/companions, triage and fresh scores, full/scoped PDF/CSV/LLM content, exact saved screenshot bytes and link CSV, settings/report gates, same-ID lifecycle/retry, rescan/inherited triage, cancel/recheck, strict arguments/live revocation, and confirmed deletion/evidence cleanup. SDK v1 again proved durable replay across a backend restart; SDK v2 again negotiated legacy `2025-11-25`. Read-only defaults, cancelled write-opt-in confirmation, unsaved drafts, persisted permission, and no MCP privilege escalation passed. The retained SDK copy is `full-mcp-final-sdk-results.json`.

The complete runner automatically removed only its `lime-verification` services and volumes; a post-run container inventory confirmed none remained. The normal LIME services on ports 3000/8081/5432 and both existing WordPress stacks on 8088/8089 with their databases remained running, unchanged by this isolated check. No normal rebuild, deployment, push, commit, or 2.0 publication was performed. Installed-client execution was not enabled inside this final complete run; the separate Codex success and OpenCode provider-limited results below remain the applicable client evidence.

After the final product run, the built root-path documentation passed its normal-motion browser verification at `checkedAt: 2026-10-06T06:18:12.769Z` (11:48:12.769 IST), with process exit 0, 42 routes, 84 desktop/mobile checks at 1440/390 pixels, and `failures: []`. Search/keyboard focus and activation, user-guide reading order, mobile navigation and visible section targets, screenshot gallery interaction, and literal MCP client examples all passed. The fresh desktop docs home and mobile first-scan captures were visually reviewed. Evidence is `.artifacts/verification/docs-refinement-results.json`, retained as `full-mcp-final-docs-results.json`. This reader check uses only its temporary static server/Chromium and does not execute product scans, configure AI clients, or touch product containers. This additional evidence note and its export rebuild are documentation-only, not a later product or browser pass.

Candidate full-workflow results are not a final integration pass. The first attempt completed at `2026-10-06T05:00:41.936Z` with 22 baseline workflows passed before an obsolete verifier assertion rejected the newly supported link mutation name. That assertion failure is retained in `.artifacts/verification/full-mcp-attempt1-results.json` and its failure screenshot; no product fix is claimed for it. The second attempt completed at `2026-10-06T05:09:04.115Z` with 23 baseline workflows passed and `browserErrors: []`, then failed a settings-UI label assertion inside the new full-MCP flow.

The second candidate's full-MCP artifact completed at `2026-10-06T05:09:03.984Z` and records five passed phases: old-key/default-read compatibility, dashboard write opt-in confirmation/draft/persistence, real SDK-v1 scan creation with concurrent durable replay and companion results, false-positive set/unset and fresh scoring, and actual full/scoped PDF/CSV/LLM, saved screenshot bytes, and link CSV content. Its next settings/report-gate/no-escalation phase failed; later v1/v2 lifecycle, revocation, restart replay, installed-client execution, and complete cleanup are not claimed from that candidate. Preserved evidence is `full-mcp-attempt2-client-results.json`, `full-mcp-attempt2-results.json`, and the corresponding failure screenshot under `.artifacts/verification/`. Final focused/full rerun results must be recorded separately after completion, not inferred from these passing phases.

A focused third candidate completed at `2026-10-06T05:16:05.243Z`, again retaining those five passed phases before a verifier falsely classified `Unknown argument: mcp_key_hash` as leaked private key material. This is the name of the intentionally rejected input field, not an exposed stored hash/value. The verifier must check secret values rather than suppressing a correct unsupported-field error. The failed attempt is preserved as `full-mcp-attempt3-client-results.json`, `full-mcp-attempt3-results.json`, and its failure screenshot; no product fix or later phase/full-run pass is claimed from this candidate.

The fourth focused candidate completed at `2026-10-06T05:20:10.055Z` with `browserErrors: []` and eight passed full-MCP phases. In addition to earlier evidence, real SDK-v1 settings persistence/report gates/no-escalation, same-ID pause/resume/failed-page retry, and rescan identity/inherited triage/backend-restart replay passed. The next standalone-link phase successfully cancelled and rechecked its job, then failed a UI assertion taken before client-fetched destination data had settled. The failure capture showed the expected completed missing-destination HTTP 404 card; the verifier is being changed to await that specific saved card, not to suppress a product error. Preserved evidence is `full-mcp-attempt4-client-results.json`, `full-mcp-attempt4-results.json`, and `full-mcp-attempt4-failure.png`. The containing phase and whole focused run are failed candidates; remaining v2/installed-client/cleanup work is not inferred as passing.

The fifth focused candidate's MCP artifact completed at `2026-10-06T05:23:11.232Z` and failed its v1 score-change assertion because its target matched a prior interrupted-run rescan whose false-positive decision was correctly inherited. The before-triage image confirmed existing triage state, rather than a failure to persist a new mark. Fixture URLs were made run-unique for SDK/client jobs while explicit rescans still reuse their own original target, so the inheritance assertion remains meaningful. Preserved evidence is `full-mcp-attempt5-client-results.json`, `full-mcp-attempt5-results.json`, `full-mcp-attempt5-failure.png`, and `full-mcp-attempt5-before-triage.png`. This corrects test isolation; no product fix or final pass is claimed from that candidate.

The completed focused SDK/UI evidence was saved at `2026-10-06T05:35:56.829Z` (11:05:56.829 IST) in `.artifacts/verification/full-mcp-sdk-results.json`; its companion focused result is `full-mcp-sdk-focused-results.json`, with `browserErrors: []`. All twenty named phases passed: two shared default-read/write-opt-in phases and nine operational phases for each pinned SDK generation. Both SDKs actually called all twelve write tools and checked real persisted scan/companion and standalone-link results, set/unset triage and fresh scoring, actual full/scoped PDF/CSV/LLM content and saved screenshot bytes, settings/report gates and no privilege escalation, same-ID pause/resume/retry, rescan/inherited triage, cancel/recheck, invalid arguments/live revocation, and confirmed deletion/evidence cleanup. SDK v1 also verified durable replay across an explicit backend restart; SDK v2 used its legacy `2025-11-25` protocol mode. Replaying a completed create after deletion did not recreate a job. The artifact also contains a separate initial installed-client result; that nested result did not pass and is not counted among the twenty named phases. This focused completion does not convert the earlier 23-baseline-workflow candidate into a new complete `make verify-app` pass.

The initial installed-client attempt is preserved in `.artifacts/verification/installed-mcp-attempt1-results.json`. OpenCode connected and discovered all 29 tools, but neither CLI completed its model workflow in that attempt. Codex had emitted no MCP calls because the verifier launcher left the appended-prompt stdin open; closing stdin corrected the launcher, not the MCP product implementation. Later client runs preserve provider output and fail the installed-only command if a real workflow is incomplete.

The installed-client rerun at `2026-10-06T05:44:16.350Z` (11:14:16.350 IST) used Codex CLI `0.158.0` and OpenCode `1.14.18`. Codex passed eleven successful tool calls across ten distinct tools: capabilities, a real mobile scan with tag/link companion through completion, issue listing and true/false triage on the same issue UUID, a 14,961-byte LLM report, a real standalone link check through completion, its 792-byte CSV, and the completed scan companion. Independent reads confirmed the created jobs and restored triage; both owned jobs were deleted and verified absent. Global client configuration fingerprints matched, and no new login or configuration change was performed. Evidence is `.artifacts/verification/installed-mcp-final/installed-mcp-client-results.json` with sanitized CLI event files beside it.

In that same rerun, installed OpenCode's authenticated handshake discovered all 29 tools, but its configured model provider returned HTTP 404 from `https://integrate.api.nvidia.com/v1/chat/completions` before any tool call. A model process exiting zero did not count as workflow success: the installed-only verifier correctly recorded an incomplete/nonzero result. An explicit earlier configured-model retry is separately saved in `.artifacts/verification/installed-mcp-explicit-model/`; it also returned provider HTTP 404 before tools.

The later current-catalog-model rerun completed at `2026-10-06T05:50:38.647Z` (11:20:38.647 IST). Codex again passed, with thirteen successful calls across the same ten distinct tools, including three scan-status reads, completed scan companion, real LLM/link CSV content, independently confirmed saved jobs/restored triage, and both owned jobs deleted and verified absent. Installed OpenCode again discovered all 29 tools, but the runtime-only `nvidia-nim/moonshotai/kimi-k2.6` selection returned an account-level HTTP 404 from the configured NVIDIA endpoint before any MCP tool call. The model had been confirmed in the provider's live catalog and supplied as a runtime entry; that did not establish account access. Evidence is `.artifacts/verification/installed-mcp-current-model/installed-mcp-client-results.json`, its event files, and the containing `focused-results.json`, which correctly records `status: "incomplete"`, `browserErrors: []`, and a nonzero workflow-validation outcome. Global configuration fingerprints matched; no new login/reconfiguration was performed, and normal authentication/session cache refresh is not covered by those fingerprints.

The operator then authorized OpenCode free-model verification. The final pure free-model control completed at `2026-10-06T06:04:41.160Z` (11:34:41.160 IST) with Codex again passing twelve successful calls across ten distinct tools, including the completed companion, actual 14,961-byte LLM and 792-byte link CSV, independent persistence/restored-triage checks, and both owned jobs deleted and verified absent. Installed OpenCode `1.14.18` authenticated and discovered all 29 tools with runtime `opencode/mimo-v2.6-flash-free` and native `--pure`; `externalPluginsDisabled: true` was recorded. Its provider returned HTTP 403 `FreeTierError`, stating that the free tier can only be used from within OpenCode, before any MCP tool call. Earlier Big Pickle free-model attempts also returned the same 403, including a retry retaining native built-in metadata/permission handling. Neither plugin isolation nor the runtime model selection established why the provider rejected this installed CLI.

The final free control is preserved in `.artifacts/verification/installed-mcp-free-pure/installed-mcp-client-results.json` and its CLI event files; `.artifacts/verification/installed-mcp-free-model/` retains an earlier free-model result. The containing final focused result correctly records `status: "incomplete"`, `browserErrors: []`, and a nonzero installed-workflow validation outcome. Configuration fingerprints matched, no new login/global configuration edit or provider identity spoofing was performed, and the test granted no shell access or dangerous permission bypass. A process exit zero or successful MCP handshake did not pass the real-workflow guard.

OpenCode's model-directed workflow remains incomplete because model execution was rejected before tools, not because a LIME tool failure was observed. No LIME product fix, free-provider availability, or OpenCode workflow success is claimed from these failures. Configuration, MCP handshake, and model-provider execution are distinct evidence. The completed clean final-source product baseline above proves the recorded product/SDK workflows, not this provider-blocked installed-client path. These local checks do not publish 2.0, verify every client/provider/OS/deployment, establish arbitrary-scale reliability, or resolve the recorded dependency/security backlog.

### Security hardening review — October 6–7, 2026

This review is **in progress**, not a full security sign-off. A repository-wide Deep Scan against `9af20b24` failed on usage limits after partial discovery. Its 73 report instances include duplicates and stale descriptions of subsequently fixed code; 114 candidates or paths were deferred. Findings have therefore been rechecked against the current branch before changes. Neither the failed scan nor the focused checks below establish complete coverage.

The branch has committed bounded scan-create bodies (`1aa1e83`), same-host and budgeted sitemap discovery with cancellation-safe workers (`227b014`, `239f497`), protected backup creation and fail-closed dumps (`ce88e1e`), formula-safe issue CSV (`285da0e`), PDF enablement/concurrency/queue controls at both routes (`88d3677`), own-property score weights (`c71c7b0`), malformed-path-safe docs preview (`ae1fcc5`), private new native screenshot files (`0cd4a6e`), ordinary API browser-Origin checks (`6064e4e`), deployment secret/installer-port hardening (`e3c6b26`), credential redaction in new scan diagnostics (`4dcbccb`), a per-job Link Checker root-DNS guard (`1e31772`), a duration bound for ordinary API uploads (`0316cde`), and commit-built release-image/tag integrity (`3201baa`). The Debian updater environment parser was previously hardened in `43f621e`. The reported profiler pause deadlock is covered by `TestDiscoverCancellationUnblocksPageQueue`; its race-enabled test passed 100 repetitions on the current branch. An authenticated sitemap fixture confirms that log redaction did not remove working Basic authentication. Link Checker regressions cover public-to-private rebinding (including redirects and failed earlier private connections), deliberately private roots, mixed DNS answers, and public address rotation; the race-enabled package and full Go suite passed.

Focused verification after the Origin and deployment changes passed: the full Go suite, race-enabled router/MCP tests, four ordinary-origin tests, all 17 MCP transport tests, dashboard lint/TypeScript, 15 installer tests, three installer hot-reload tests (including daemon-free Compose config), Bash syntax, docs lint and production build. The docs export validated 39 guides and 47 HTML pages. A disposable real-SQL PDF policy test exists but was skipped without an isolated PostgreSQL URL. No complete `make verify-app` or live Docker upgrade was run after these security changes; that runner replaces `.artifacts/verification/` evidence, and the local Docker daemon did not respond to a read-only inventory attempt. Normal LIME and unrelated containers, volumes, settings, and saved records were not altered for this review.

The ordinary API proxy's 1 MiB body cap now has a separate 60-second incoming-body deadline; it does not shorten long backend/report work. A partial HTTP upload through Next's Node adapter returned 408 and closed the keep-alive socket. The 24 focused MCP transport and ordinary-origin tests, dashboard lint, TypeScript, and production build passed. This timer starts only when Next receives the body: the documented Nginx example buffers client uploads first and applies its own client-body policy, so the direct-Node test does not prove a 60-second end-to-end limit through Nginx.

The release image publisher now requires a clean tracked/non-ignored checkout, snapshots the captured commit into a temporary Git archive, verifies or atomically claims the remote version tag before any image build, and runs both Docker builds from that archive with pinned version, commit, and build flags. A disposable bare-origin/fake-Docker test covers divergent and concurrent tag claims, a failed remote, ignored nested files, local HEAD movement, clean context removal, and unchanged offline no-push builds. Bash syntax, Make dry runs, and docs lint/build passed. No GHCR publication or live Docker build was attempted. A failed publish can leave a retryable tag without a completed release; a privileged remote force-move after the claim is outside the script's control. The root Docker context also excludes nested local env, log, PEM, and Go workspace files while retaining `.env.example` templates (`638b48e`). Docker's documented `**`/last-match rules and tracked-file inventory support this change, but no daemon-backed context test ran. The development Compose bind mount bypasses `.dockerignore`, so developers must not place private files under `lime/public`.

Open decisions and work requiring broader regression proof remain: manual/source/release/docs Compose and native service exposure, browser network egress after URL validation, Chromium isolation, page-controlled axe results, scan/evidence and affected-URL PDF resource budgets, and process-argument database URLs in dump helpers. The scans dashboard still loads, scores, and renders every saved scan; a durable fix needs database-backed search/pagination, bounded tag choices, and a compatibility decision for the separately unbounded `GET /api/scans`. Credential-bearing scan URLs currently support authenticated sitemap fetches, so blanket rejection is not a compatibility-safe fix; API/UI/report output disclosure needs a coordinated design. Existing direct API access is not protected by the MCP bearer key. Do not present this branch as fully security-reviewed or publish it based on the focused checks alone.

This section preserves the earlier in-progress state. The later sealed Standard scan, current source fixes, real-Chrome checks, and still-open policy/deployment limits are recorded in [Security hardening handoff — October 7, 2026](security-hardening-2026-10-07.md); do not read this older open-work list as the final disposition of that later patch.
