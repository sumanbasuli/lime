# Operational Troubleshooting

Start by checking service status and logs before changing settings or storage. Use the dashboard's URL for application and API requests; the marketing and documentation website is a separate app.

## Identify The Runtime

From the intended source Compose directory:

```bash
docker compose ps
docker compose logs --tail=100 shopkeeper ui
curl -fsS http://localhost:3000/api/health
curl -fsS http://localhost:3000/api/version
```

For release deployments, consistently include the actual `--env-file`, `-f`, project name, and overrides. `docker compose config --quiet` checks interpolation without dumping resolved credentials. Do not paste full env/config output or database URLs into tickets. On native Debian use `systemctl status lime-shopkeeper lime-ui` and `journalctl -u lime-shopkeeper -u lime-ui --since '30 minutes ago'`.

`/api/health` is backend HTTP liveness through the proxy, not a PostgreSQL/Chromium readiness check. Also load a DB-backed page, examine startup migration logs, and use a small authorized scan/export when functional verification is needed. `/api/version` reports the Go build metadata; the UI update card compares its own packaged/runtime version.

## Symptom Guide

| Symptom | What to check |
|---------|-----------------------------------|
| UI API requests return 500/502 | Confirm UI `SHOPKEEPER_URL` exists and reaches the backend from the UI runtime; browser localhost and container localhost differ |
| API health works but dashboard pages fail | Both services need the same reachable `DATABASE_URL`; check UI DB errors and migration completion |
| Backend exits before listening | Inspect migration/connection error; confirm working directory includes `migrations/` and the DB role can apply it |
| Scan stays profiling or has fewer pages than the XML | Inspect nested-sitemap failures and Profiler retained/cross-host/unresolved counts; eligibility makes GET requests and follows redirects |
| `scanned_urls` equals total but coverage is partial | The counter includes attempted pages; check failed URL coverage and backend page errors |
| Pausing takes time | It is cooperative; wait for `paused`, not just the requested flag; successful in-flight evidence is saved |
| Restarted scan loses partial findings | Expected clean recovery for unpaused active scans; explicit pause/resume preserves completed evidence |
| PDF fails but CSV works | Check backend `REPORT_BASE_URL`, Chromium startup, internal UI access, report ready marker, and enabled PDF setting |
| PNG URLs 404 after an update | Check the existing screenshot volume/root and exact scan/file; database paths are metadata, not image pixels |
| MCP returns 401/403 or missing scores | Use the canonical dashboard `/mcp`, confirm enablement/key, and review [MCP Integration](../mcp.md); direct backend score cache can be null when cold/stale |
| No release card | Inspect `/_lime/update-check`, server flag, browser visibility/dismissal, current version, and best-effort GitHub failure behavior |
| Link companion stays queued | Check parent scan status; it waits for accessibility completion, remains queued during a pause, and has independent progress afterward |
| Link targets are blocked, errored, or incomplete | Distinguish network policy, timeout/redirect/network errors, failed source fetches, and truncation; see [Link Checker Architecture](../architecture/link-checker.md) |

## Database And Migrations

Changing `POSTGRES_USER`, `POSTGRES_PASSWORD`, or `POSTGRES_DB` in Compose does not reinitialize an existing `pgdata` volume. Match actual database credentials rather than deleting the volume. Source Compose constructs internal database URLs from these bootstrap variables; setting only the native root `DATABASE_URL` does not override its container database.

With an authorized DB client, inspect:

```sql
SELECT version, dirty FROM schema_migrations;
SELECT status, count(*) FROM scans GROUP BY status ORDER BY status;
SELECT status, count(*) FROM urls GROUP BY status ORDER BY status;
```

Capture migration errors and the version/dirty state before repair. Do not force a migration version, edit scan/result rows, or run down files based on a generic error. See [Database Architecture](../database.md) and [Backup And Restore](backup-restore.md).

## Scan Network And Browser Checks

Profiler and Chromium run from Shopkeeper, not from the browser viewing the dashboard. Targets using `localhost`, private DNS, authentication, redirects, bot protection, or blocked resources can behave differently there. Profiler resolves final page URLs by HTTP GET and skips cross-host/unresolved candidates; incomplete nested sitemap discovery fails the scan instead of silently taking a subset.

Shopkeeper logs Chrome auto-detection at startup. Native installs need a supported Chrome/Chromium command on the service PATH, writable browser temporary storage, and a writable screenshot directory. The current allocator does not read `CHROMIUM_PATH` as a custom override despite a commented template example. `chrome failed to start` can indicate missing dependencies, permissions, memory pressure, or an interrupted operation; correlate it with parent pause/restart state before treating it as a target-page failure.

Five Chromium page workers run per scan, and PDF generation uses Chromium too. Several scans can therefore exceed a small host's capacity even though each uses a five-worker limit. Source/release Compose configure 2 GB shared memory, not a guaranteed total memory budget. Inspect container exit/OOM state and logs; reduce simultaneous work before changing deadlines or code.

Canceled unfinished pages during a pause remain pending; genuine navigation failures/local page deadlines while the parent remains active are stored as failures. A completed partial scan offers **Retry failed pages**; an all-failed scan is failed and requires a fresh scan/rescan. Do not relabel stored failures manually to create apparent full coverage.

## Screenshots And PDF Routing

Storage defaults to `/app/screenshots/{scanId}`. Native installs use `SHOPKEEPER_SCREENSHOT_DIR`, and the process user must be able to create files there. Do not broadly chmod/chown a deployment root to resolve one missing file; inspect the exact configured directory, mount, and service identity first.

For the source Compose stack, these checks do not change files:

```bash
docker compose exec -T shopkeeper id
docker compose exec -T shopkeeper ls -ld /app/screenshots
docker compose exec -T shopkeeper wget -qO- http://ui:3000/api/health
```

Stored `/app/screenshots/…` strings are not public browser URLs. Use `/api/screenshots/{scanId}/{filename}` on the dashboard origin; MCP provides separate screenshot URL fields. A missing focused capture can be legitimate for hidden/click-open/canvas content; the UI offers the saved page view as an on-demand fallback where available.

The two internal URL directions are different:

- UI `SHOPKEEPER_URL` → Shopkeeper API, e.g. `http://shopkeeper:8080`
- Shopkeeper `REPORT_BASE_URL` → dashboard report document, e.g. `http://ui:3000`

Current source/docs Compose sets the report URL; release Compose and Fly require an explicit operator override. Adding an env value that the Compose template never forwards does not change the container. For native colocated services the report default is `http://localhost:3000`. Custom UI ports/hosts must update the backend value too. An external login gateway must not replace the internal report page with a login screen, and reverse-proxy timeouts must accommodate PDF generation (backend render deadline is four minutes).

PDF/CSV/LLM toggles and the PDF limiter apply through dashboard routes. Direct backend PDF downloads bypass those Next controls. Report metadata availability is not proof a file has already been generated.

## Link checks, update notices, and caches

For link-check problems, inspect the job's own status, `pages_failed`, `truncated`, result categories, and `error_kind`; accessibility completion does not mean its companion has completed. Use a complete webpage URL reachable from Shopkeeper, not a sitemap XML file or a browser-only login URL. Extraction is HTML-only and does not verify fragment anchors. Entered root origins are trusted and may be private; external discovered destinations and off-origin redirects are restricted. Keep job-creation access protected instead of removing policy to make a blocked target pass. [Link Checker Architecture](../architecture/link-checker.md) covers limits, lifecycle, source/reference paging, and safe evidence collection.

`LIME_UPDATE_CHECK` defaults on when unset; explicit false disables outbound GitHub checks. The per-browser setting only hides the card. Dismissing a release hides that exact tag on the same origin, not all future releases. The endpoint intentionally returns 200 with no latest release/card on best-effort failures; this is not a deployment failure. See [Updating LIME](updates.md).

Score/issue caches use scan timestamps plus their TTL, and triage invalidates them. Server-wide UI settings can be cached for five seconds in another UI process. `reportDataCacheTtlSeconds` is reserved and does not currently cache report responses. Use [Performance And Caching](../performance.md) before tuning values or assuming a cached export exists.

## Reporting a problem

Include the LIME version, deployment method, affected scan or check ID, expected result, actual result, and relevant logs. For scan problems, include the status and viewport; for request failures, include the HTTP response code. Note whether the issue also occurs in the isolated `make verify-app` stack. Remove credentials, private URLs, and sensitive page content before sharing, and use a small reproducible example when possible.
