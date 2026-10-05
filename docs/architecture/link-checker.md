# Link Checker Architecture

The link checker is a separate Shopkeeper-owned HTTP workflow. It supports standalone single-page checks, bounded same-origin source crawls, and a default-off companion for an accessibility scan. Jobs, destinations, and source references are persisted in PostgreSQL; the dashboard starts jobs, polls progress, pages through results, and exposes lifecycle actions and CSV.

This guide describes the current unreleased source. It is not proof of a published image, deployment, security audit, production load test, or scheduled monitoring service. Use [Verification And Handoff](../verification.md) for dated checks actually run, and the [user guide](https://lime.heysuman.com/docs/user/link-checker/) for dashboard instructions.

## Ownership And Compatibility

| Owner | Responsibility |
| --- | --- |
| Shopkeeper link runner | Normalize URLs, fetch and extract HTML references, follow bounded source pages, validate targets, enforce budgets/network policy, update jobs/results |
| Shopkeeper repository/handlers | Job/result persistence and paging, create/cancel/recheck/delete, CSV, scan companion lookup |
| Accessibility scanner | Start a selected companion only after the parent scan completes; preserve selection on rescan and coordinate failed-parent retry |
| Next dashboard | Default-off new-scan checkbox, companion card, standalone history/detail screens, result/source filters and paging, existing runtime API proxy |
| PostgreSQL migration | Durable job state and results; unique companion per parent scan and cascading cleanup |
| Static docs website | User, API, operational, and implementation guides; it does not run link checks |

The runner does not use Chromium, axe-core, the viewport, ACT guidance, false-positive decisions, score/cache calculation, or issue screenshot capture. Link failures do not become axe issue groups or change accessibility report contents. Existing accessibility scans omit `include_link_check` or send false and keep their previous behavior. No additional service, queue, Redis instance, or Next settings flag is required.

Key implementation files:

| Source | What to change here |
| --- | --- |
| `shopkeeper/internal/linkchecker/checker.go` | Extraction, normalization, request/redirect handling, network policy, budgets, result meaning |
| `shopkeeper/internal/linkchecker/runner.go` | Durable-job polling, local worker cap, request cancellation, shutdown |
| `shopkeeper/internal/repository/link_checks.go` | Atomic companion creation, claim/recovery, result snapshots, paging, aggregates |
| `shopkeeper/internal/handler/link_checks.go` and `router/router.go` | REST validation, lifecycle eligibility, companion lookup, CSV and route registration |
| `shopkeeper/internal/models/link_checks.go` | Public job/result/source shapes and request model |
| `shopkeeper/internal/mcp/link_checks.go` and `server.go` | Authenticated read-only tools for saved jobs, statistics, companions, targets, and sources |
| `shopkeeper/migrations/000013_add_link_checks.up.sql` and `lime/src/db/schema.ts` | Forward schema and matching Drizzle definitions |
| `lime/src/lib/api.ts` and `src/components/link-check-*.tsx` | Typed dashboard API client, history/detail/summary UI |
| `lime/src/components/new-scan-form.tsx` and `scan-link-check.tsx` | Default-off selection and companion status card |

Follow the existing scanner/repository lifecycle hooks when modifying retry, rescan, or parent deletion; the link runner is not permitted to rewrite axe evidence.

The ordinary dashboard and HTTP APIs have no built-in user authentication. The MCP bearer key protects MCP only and does not authorize or protect the link-check REST API. Use external access control for any remotely reachable instance, and submit only origins you are authorized to request. The existing MCP endpoint adds six read-only saved-link tools alongside its six accessibility/settings tools; it adds no mutation tools or new authentication contract.

## Job Modes

### Standalone Single Page

`POST /api/link-checks` with `check_type: "single"` extracts references from the entered HTML page and checks the normalized HTTP(S) destinations. Fetching a destination to inspect its response does not turn it into another source page. Submit a webpage, not a sitemap XML input.

### Standalone Crawl

`check_type: "crawl"` starts at the entered root and follows eligible HTML source-page destinations within the same origin. Origin includes scheme, hostname, and effective port; this is deliberately different from Profiler's same-host sitemap eligibility. External origins and linked document/media targets can be checked but are not recursively crawled.

The default source-page cap is 100, with a supported range of 1–500. A cap is a work ceiling, not a completeness estimate. A site can contain more URLs than the cap, omit unreachable or JavaScript-only links, and change during the run.

### Accessibility Companion

`POST /api/scans` accepts `include_link_check: true`. Creation stores one queued `check_type: "scan"` companion associated with that scan; the default is false. After accessibility completes, the runner uses the scan's persisted discovered URLs as source pages instead of expanding the sitemap into a recursive crawl. It makes new HTTP requests and does not read links from screenshots or axe output.

The two jobs have distinct status/progress. A completed accessibility scan can still have a queued or running companion. Accessibility failure must not be interpreted as a clean link result. A failed browser page audit and a broken HTTP link target are different kinds of evidence.

Companions use a 500-source-page cap. Source seeds come from persisted discovered URL rows, not only browser-audit successes; a page whose Chromium audit failed may still produce independently useful HTTP link evidence. The repository retains at most 501 seeds: 500 for processing and one overflow marker so a large scan remains explicitly truncated. It does not load or persist an arbitrarily large inventory for a link job.

The job's entered target origin remains the network/extraction boundary. Profiler's same-host sitemap rule can retain a URL whose scheme differs; a companion can request an allowed off-origin destination for reachability, but does not extract its outgoing references. A sitemap or root redirecting from HTTP to HTTPS or between bare/`www` hosts can therefore produce truncation. Use the final canonical target origin rather than treating the two eligibility policies as interchangeable.

## Lifecycle And Recovery

Link jobs use `queued`, `running`, `completed`, `failed`, and `cancelled`. `completed` means the bounded runner finished, not that all results are healthy or every possible page was discovered. Counters, summaries, and results are provisional while running. Read `truncated`, `pages_failed`, and `error` alongside status.

Companion rules:

- Pausing an accessibility scan leaves its not-yet-started companion queued. Resume can allow it to start after the accessibility run completes.
- Once a companion starts, it is an independent HTTP job. Accessibility Pause is not a pause control for it.
- An accessibility failure is reflected on the waiting companion. If failed-page retry later completes the accessibility scan, an eligible failed companion can be retried. Completed snapshots and explicitly cancelled companions are preserved; use Recheck for fresh link evidence.
- Rescan creates a new accessibility scan, preserves the include-link selection, and creates a fresh companion. It never overwrites the original scan/check.
- Cancelling a companion cancels only link checking, not the parent accessibility scan.
- Recheck creates a fresh detached job and preserves its source job's mode, cap, and saved seed inventory without copying a parent `scan_id`. A companion recheck therefore has mode `scan` but no parent, and checks the saved inventory rather than reprofiling a sitemap. A companion that never saved an inventory cannot be rechecked; rescan its parent with the selection instead. This is not an in-place retry that erases evidence.
- Parent scan deletion cascades to attached link data. Settled checks have their own delete action; active jobs must be cancelled first. Deleting only a companion keeps the historical parent selection true, so rescan can create a new one.

Run only one Shopkeeper per database. In-process runner ownership and startup recovery do not provide a distributed job lease or a multi-backend queue. Do not deploy several workers against the same database and assume work is coordinated. Keep the original accessibility clean-start recovery versus explicit pause/resume distinction intact when changing companion hooks.

The runner polls eligible durable jobs once per second and runs at most two HTTP-only jobs per backend process. Each job's source/target requests are sequential; this is not the five-worker Chromium accessibility pool. Conditional transactional claim prevents two local poll attempts from starting the same queued row, but it is not distributed ownership. Companion claims lock the parent before the job and recheck that accessibility is completed, matching retry/deletion lock order so a concurrent parent retry cannot start a waiting companion prematurely.

On startup, interrupted running link jobs are returned to queued. A claimed queued job clears its earlier target rows and counters before running again under the same ID; this is restart recovery, not a resume that preserves every partial response. Persisted cancelled/terminal jobs are not restarted by that running-job reset. Snapshot writes are transactionally guarded by running status so late work cannot resurrect a cancelled or deleted job.

## Extraction And Result Meaning

The checker reads returned HTML, resolves references against the effective page/base URL (including the first valid `<base href>`), and normalizes HTTP(S) destinations. Fragment-only references are skipped; fragment identifiers on other destinations are removed: `https://example.com/help#missing` is tested as `/help`, not as an anchor assertion. Query strings are preserved. Non-HTTP(S) and malformed references are skipped rather than reported as successful HTTP checks.

Extraction currently covers `a`, `area`, and `link` `href`; common media/resource `src`; `object data`; `video poster`; and parsed `img`/`source` `srcset` candidates. Only same-origin anchor/area destinations classified as internal can expand a crawl. It does not extract CSS `url()`, form actions, arbitrary data attributes, or every possible URL-bearing syntax. A source redirect off the entered origin can be checked for reachability, but the off-origin document is not expanded into more references and the job is marked truncated.

It does not execute JavaScript, render a DOM in Chromium, submit forms, reuse browser sessions/cookies, or authenticate. Client-generated links and authenticated content can be absent. A successful response is not evidence that the intended content, fragment, accessibility behavior, or security properties are correct.

One normalized destination produces one `link_check_results` row per job. Its `occurrence_count` and saved `sources` retain where it appeared; sources include `page_url`, `element`, `attribute`, and text. Source pages themselves receive a synthetic `element: "page"`, `attribute: "url"` reference, so target totals include their reachability and are not an anchor-element count. Reference text is bounded to a short context string, not the full source document.

Source pages use GET and require returned HTML/XHTML for extraction. Other unchecked destinations use HEAD; 405 or 501 causes a GET fallback. A result-list response previews at most five retained sources; use the source endpoint for the retained reference set. Both target and source reads are paginated. A source with a successful HTTP response but non-HTML content can still be healthy as a destination while failing source extraction; always inspect `pages_failed`, truncation, and its error text.

| Result status | Interpretation |
| --- | --- |
| `healthy` | Successful response without a redirect |
| `redirected` | Successful final response after redirecting |
| `broken` | HTTP error response such as 404 or 500; access/rate-limit exceptions are inconclusive instead |
| `error` | Request could not establish a definitive response, or returned 401/403/429/unexpected status; inspect error detail |
| `blocked` | Network policy refused a destination or redirect |
| `unchecked` | A retained destination was not checked before work stopped at a budget/interruption |

`error_kind` distinguishes request failures such as `timeout`, `network`, `redirect_loop`, and `blocked` where applicable; an HTTP access/rate-limit error can have error text without an `error_kind`. Summary `timeout` counts timed-out errors and must not be added to the error count as if it were a seventh disjoint result category. `status_code` and `final_url` can be null when no valid response was obtained. `link_type` labels targets as `internal`, `external`, `document`, or `media`; its current classification uses URL extensions and element/origin context, not verified response MIME type or safety.

## Network Trust Boundary

The submitted root origin is explicitly trusted and may resolve to a private address for local/staging workflows, including `host.docker.internal`. This is intentional functionality, not a blanket public-only policy. Protect job-creation routes and trust the people allowed to submit root origins.

For discovered external origins and redirects outside the root, the runner requires globally routable destinations and refuses private/reserved addresses. It resolves a destination before the request and pins the selected IP for dialing, rather than resolving a validated hostname again at connect time. Redirect hops are revalidated. Ambient HTTP proxy environment variables are not used to bypass the checker's network policy.

These rules constrain this HTTP runner; they do not add authentication, authorization, rate limiting, or equivalent restrictions to the existing accessibility Chromium/Profiler pipeline. They are not a security certification. A blocked destination is not a broken link verdict; operator review must consider the submitted origin and network topology before changing policy.

## Resource Budgets

| Budget | Current limit |
| --- | --- |
| Standalone crawl source pages | Default 100; supported maximum 500 |
| Unique HTTP(S) destinations | 2,000 per job |
| Retained source references | 10,000 per job |
| HTTP requests | 5,000 per job, including redirects/fallback requests |
| Redirect hops | 5 per destination |
| Extracted HTML body | 2 MiB per source page; larger bodies are parsed only up to the cap and mark truncation |
| Per-request deadline | 10 seconds |
| Overall job deadline | 10 minutes |

Budgets are part of the saved-result interpretation. Reaching a resource ceiling can leave truncated coverage or unchecked retained targets; the runner must not silently claim full coverage. Reading only the first results/source page also does not represent the complete saved scope. HTTP deadlines, response-body limits, and cancellation must stay bounded when modifying extraction or adding another protocol.

Link checking shares backend CPU, network, database, and connection resources with accessibility work. Companions run after their own parent completes, not after every other instance job has finished. The dashboard's PDF concurrency setting does not control HTTP link jobs. Do not describe a local fixture pass as a production load benchmark.

## Result Presentation

The dashboard presents the saved API evidence without reclassifying outcomes. Recognized destination hosts use a small, locally bundled Bootstrap Icons SVG subset; matching is by parsed hostname, not arbitrary URL text. There are no remote favicon requests. Brand/resource icons describe destinations, not availability or security.

Collapsed cards keep query-heavy URLs compact. Expansion retains the complete destination URL and paginated, numbered source occurrences with source page, element, attribute and captured text. Empty captured text is not an accessibility finding. The synthetic `page[url]` inventory reference is explicitly distinct from an HTML element. Repeated references remain separate saved occurrences.

The six outcome filters and run metadata come from the existing job summary/timestamps. Elapsed time includes the queue, not just HTTP execution. Non-standard responses such as HTTP 999 retain their saved category and code with manual-verification guidance. If source pagination fails, the requested page's error/retry state hides previously loaded rows; retry reads the same offset and never changes the saved job.

## Persistence And Migration

Forward migration `000013_add_link_checks` adds `scans.include_link_check BOOLEAN NOT NULL DEFAULT false`, `link_checks`, and `link_check_results`. The default leaves historical scans unchanged and does not create companions retroactively.

`link_checks` stores a UUID ID, optional unique `scan_id`, root URL, mode, status, configured page ceiling, progress counters, truncation/error, JSONB summary/internal seed URLs, and timestamps. `link_check_results` stores a unique target per check, response category/code/final URL/redirect count, type, occurrence count, JSONB sources, and optional error detail.

The job's `scan_id` foreign key cascades on parent deletion; result rows cascade on job deletion. Standalone `scan_id` is null. JSONB source storage avoids unbounded result-list payloads, but it still belongs in backup/privacy planning. Link checks have no screenshot assets to reconstruct. See [Database](../database.md) and [Backup And Restore](../deployment/backup-restore.md).

## HTTP API

Use the dashboard origin so requests go through its existing runtime Shopkeeper proxy. These routes do not inherit MCP authentication. Mutating examples are for an authorized test instance, not a read-only production diagnostic.

```json
{"url":"https://example.com/","check_type":"crawl","max_pages":100}
```

For an optional companion on a normal scan:

```json
{"sitemap_url":"https://example.com/sitemap.xml","scan_type":"sitemap","viewport_preset":"desktop","include_link_check":true}
```

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/link-checks` | Create a `single` or `crawl` job; HTTP 201 |
| GET | `/api/link-checks` | Paginated saved history |
| GET | `/api/link-checks/stats` | Aggregates across all saved jobs, including companions and repeated checks |
| GET | `/api/link-checks/{id}` | Job configuration, status, progress, summary, limits, and error |
| GET | `/api/link-checks/{id}/results` | Paginated target rows; optional result-status filter |
| GET | `/api/link-checks/{id}/results/{resultId}/sources` | Paginated retained source references |
| GET | `/api/link-checks/{id}/export.csv` | CSV of the saved destination/reference scope |
| POST | `/api/link-checks/{id}/cancel` | Stop the selected active link job only |
| POST | `/api/link-checks/{id}/recheck` | Create a fresh standalone check, preserving the original |
| DELETE | `/api/link-checks/{id}` | Delete the selected job and cascaded result/reference data |
| GET | `/api/scans/{id}/link-check` | Retrieve the parent's companion if present |

List, result, and source responses use `{ items, total, limit, offset, has_more }`. Their default limit is 50, supported limit range 1–200, and offset range 0–1,000,000. Filter values match the result statuses above; use `error`, not `timeout`, to request errored targets and inspect `error_kind` for the subtype. Invalid IDs, filters, or pagination return 400; missing checks/results return 404. Cancel/recheck/delete return 409 when lifecycle state is ineligible. Successful delete returns 204; companion lookup returns HTTP 200 with null when an existing scan has none, or 404 for a missing scan.

Standalone creation defaults to `crawl` when `check_type` is omitted, defaults zero/omitted `max_pages` to 100, and sets a valid single-page request's stored cap to 1. Invalid mode, page bounds, URL/credentials, or unknown body fields return 400. IDs are UUID-shaped strings; the job `seed_urls` inventory is internal and not returned in public JSON. Stats are sums over saved jobs, not a unique-site or cross-run target count. The [API Reference](https://lime.heysuman.com/api/) records request/response details alongside existing scan endpoints.

Link CSV is separate from the accessibility PDF/CSV/LLM formats and their Settings toggles. Each retained source reference receives a row with repeated target fields; a target with no retained sources still has a row. Exported values require spreadsheet-formula neutralization as well as normal CSV quoting because source text and URLs are untrusted input. Exporting a failed, cancelled, or truncated job cannot invent missing targets or references. Each export reads a consistent saved target/reference snapshot in one bounded SQL query. Prefer a settled job for final evidence: an active check can discover or update more results after the export.

## Read-Only MCP Integration

Shopkeeper exposes `list_link_checks`, `get_link_check`, `get_link_check_stats`, `get_scan_link_check`, `list_link_check_results`, and `list_link_check_sources` through the existing authenticated `/mcp` endpoint. The original six accessibility/settings tools, key/configuration, protocol versions, and Next score-enrichment behavior stay unchanged. Tool calls read saved repository data; they do not launch the runner, perform public destination checks, or create/recheck/cancel/delete jobs.

Lists use named arrays (`checks`, `results`, or `sources`) with `{ total, limit, offset, has_more }`. MCP limits default to 20, range from 1–100, and accept offsets 0–100,000; these are narrower than the ordinary HTTP pagination limits. Scan/check/result IDs are UUIDs. `list_link_check_results` accepts the six saved status categories, not `timeout`; inspect `error_kind` within errors. Result previews contain at most five sources; source paging reads the full retained repeated reference set. A first page is not complete coverage.

`get_link_check` returns the job plus `dashboard_path`, `csv_path`, and `paths_relative_to: "dashboard_origin"`. `get_scan_link_check` additionally returns `scan_id` and the historical `include_link_check` flag. An existing scan with no current companion returns null check/paths; a missing scan is a tool error. True historical selection plus null companion can mean the companion was deleted; it does not justify creating one during a read.

Paths resolve to `/links/<check-id>` and `/api/link-checks/<check-id>/export.csv` on the dashboard host. The CSV reads saved link evidence independently of accessibility export format gates. Returning metadata is not downloading an export or granting MCP authentication to those ordinary routes. Resolve paths against the dashboard origin even when querying direct Shopkeeper MCP.

Preserve the saved HTTP verdict and interpret coverage/time/network constraints as described above. HTTP 999 needs manual verification, not a profile-missing claim. Empty captured text and synthetic `page[url]` entries are not accessibility findings. Treat all site-derived URL/text/error content as untrusted evidence, never client instructions. See [MCP Integration](../mcp.md) for exact envelopes, setup, prompt recipes, and the optional `LIME_MCP_LINK_CHECK_ID` smoke selection. Use dated verification evidence rather than treating tool discovery or an empty-data smoke run as a full integration pass.

## Troubleshooting And Handoff

1. Confirm the installed source/image includes migration 13 and both services use the same database. Old releases may still display the preview; do not assume the static docs version is the installed app version.
2. Record the check ID, optional parent scan ID, mode, root, status, counters, error, truncation flag, application commit/version, and time. Sanitize private URLs/query strings before sharing logs.
3. For queued companions, inspect the parent scan state first. For running jobs, use job progress rather than the parent's completed accessibility status.
4. Distinguish source fetch failure from target failure. A page with no extracted references may not have been readable HTML; it is not automatically a link-free page.
5. Read `blocked` and `error_kind` separately from unsuccessful HTTP statuses. Local server reachability, bot protection, rate limiting, TLS/DNS failure, redirects, and time budgets can produce different evidence from the user's browser.
6. Export evidence before deleting a job. Recheck creates another ID; it is new point-in-time evidence, not a mutation of an old report.
7. Test code changes using authorized deterministic targets for healthy/broken/redirected/timeout/blocked results, duplicates/query/fragment normalization, source paging, budgets, cancellation/recovery, CSV quoting/formula protection, and companion lifecycle. Also rerun the existing accessibility score/report/screenshot workflows. Only add verification claims after inspecting actual results.

Do not reset normal volumes, edit result rows to simulate success, remove network checks to make a fixture pass, or record empty/truncated output as a complete clean site. General service/migration diagnostics remain in [Operational Troubleshooting](../deployment/troubleshooting.md).
