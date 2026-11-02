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
| Backend exits before listening | Inspect sandbox/catalog startup checks and migration/connection errors; confirm the current Compose policy, readable ACT catalog, `migrations/` working directory, and DB privileges |
| Chromium sandbox startup fails after an image update | Install the complete updated Compose deployment and `deploy/docker/` assets; follow the one-time upgrade, check host user-namespace policy, and keep the sandbox enabled |
| Container ownership preparation fails | Inspect the exact screenshot entry named in logs; links, special files, nested mounts, and unexpected owners require operator review against the backup |
| Scan stays profiling or has fewer pages than the XML | Inspect nested-sitemap failures and Profiler retained/cross-host/unresolved counts; off-host URLs and redirects are not fetched |
| `scanned_urls` equals total but coverage is partial | The counter includes attempted pages; check failed URL coverage and backend page errors |
| Pausing takes time | It is cooperative; wait for `paused`, not just the requested flag; successful in-flight evidence is saved |
| Restarted scan loses partial findings | Expected clean recovery for unpaused active scans; explicit pause/resume preserves completed evidence |
| PDF fails but CSV works | Check backend `REPORT_BASE_URL`, Chromium startup, internal UI access, report ready marker, and enabled PDF setting |
| PDF returns 413 because the report is too large | Download Full CSV for the same scan or issue, if CSV exports are enabled; it contains the saved occurrence data without making a partial PDF |
| PNG URLs 404 after an update | Check the existing screenshot volume/root and exact scan/file; database paths are metadata, not image pixels |
| MCP returns 401/403 or missing scores | Use the canonical dashboard `/mcp`, confirm enablement/key, and review [MCP Integration](../mcp.md); direct backend score cache can be null when cold/stale |
| No release card | Inspect `/_lime/update-check`, server flag, browser visibility/dismissal, current version, and best-effort GitHub failure behavior |
| Link companion stays queued | Check parent scan status; it waits for accessibility completion, remains queued during a pause, and has independent progress afterward |
| Link targets are blocked, errored, or incomplete | Distinguish network policy, timeout/redirect/network errors, failed source fetches, and truncation; see [Link Checker Architecture](../architecture/link-checker.md) |

## Database And Migrations

Changing `POSTGRES_USER`, `POSTGRES_PASSWORD`, or `POSTGRES_DB` in Compose does not reinitialize an existing `pgdata` volume. Match actual database credentials rather than deleting the volume. Source Compose constructs internal database URLs from these bootstrap variables; setting only the native root `DATABASE_URL` does not override its container database.

If a source upgrade now says `POSTGRES_PASSWORD` is required, preserve the existing database: use its original password in a private root `.env`. Do not run `make init-env` against an older volume without its `.env`; it deliberately refuses to generate a different password for that state. See [Docker deployment](docker.md#local-docker-stack) for the legacy recovery sequence.

With an authorized DB client, inspect:

```sql
SELECT version, dirty FROM schema_migrations;
SELECT status, count(*) FROM scans GROUP BY status ORDER BY status;
SELECT status, count(*) FROM urls GROUP BY status ORDER BY status;
```

Capture migration errors and the version/dirty state before repair. Do not force a migration version, edit scan/result rows, or run down files based on a generic error. See [Database Architecture](../database.md) and [Backup And Restore](backup-restore.md).

## Scan Network And Browser Checks

Profiler and Chromium run from Shopkeeper, not from the browser viewing the dashboard. Targets using `localhost`, private DNS, authentication, redirects, bot protection, or blocked resources can behave differently there. Profiler only fetches sitemap and page URLs on the entered sitemap's authority; it refuses off-authority redirects before following them. Individual off-authority or unresolved pages are skipped, while an off-authority or failed nested sitemap fails discovery rather than silently producing a partial scan.

Treat pages you scan as untrusted network content. Chromium can follow redirects and load public assets beyond the sitemap host. Its page-local network guard blocks off-root private and localhost destinations, including redirects and subresources; a newly submitted private site remains scannable. For a private root on the usual HTTP or HTTPS port, the same host's paired port is also reachable by redirects and page resources. Do not treat that allowance as authorization to access every service on the host: accept private scan targets only from trusted users, and isolate Shopkeeper from sensitive management and metadata networks. If a page fails to load or looks incomplete, check whether it depends on another private service. The guard uses direct connections rather than an ambient enterprise HTTP proxy. It pins exact root IPs per page; a public-only root classification persists across Profiler, browser pages, and a companion link check so a later private answer is blocked. Its SOCKS5 policy covers TCP URL traffic.

Shopkeeper logs Chrome auto-detection at startup and probes a sandboxed browser before normal migrations or HTTP. Native installs need a supported Chrome/Chromium command on the service PATH, its native sandbox, private writable browser storage, and a writable screenshot directory. In Docker, use the current Compose seccomp policy and default image entrypoint; see the [one-time upgrade](updates.md#one-time-chromium-sandbox-upgrade). `chrome failed to start` can also indicate missing dependencies, permissions, memory pressure, or an interrupted operation; correlate it with parent pause/restart state before treating it as a target-page failure.

Shopkeeper runs at most two scan pipelines at once, with up to five Chromium page workers in each; further scans remain `pending` until a slot opens. PDF generation also uses Chromium. Source, release, and docs Compose cap the entire Shopkeeper container at 2 GiB of RAM with no extra swap by default; native systemd uses the same RAM ceiling. The cap includes Chromium child processes, so a large page or concurrent work can fail or restart Shopkeeper. Inspect container or service OOM state and logs, then reduce load or adjust `LIME_SHOPKEEPER_MEMORY_LIMIT` (Compose) or the native systemd drop-in described in the deployment guide.

The browser proxy permits up to 64 live connections per page, 256 across one Shopkeeper process, and 512 accepted connections over one page's run. If a page exceeds a limit, its proxy closes and the page is marked failed with `browser connection budget exceeded`; saved audit evidence is not published as a successful page. Check the target's background requests before retrying. These limits cover connections, not total bytes transferred through an allowed connection.

Canceled unfinished pages during a pause remain pending; genuine navigation failures/local page deadlines while the parent remains active are stored as failures. A completed partial scan offers **Retry failed pages**; an all-failed scan is failed and requires a fresh scan/rescan. If saving page status or issue evidence fails, LIME stops the scan and attempts to mark it failed rather than treating the result as complete. If the database remains unavailable, confirm the stored status after service recovery. Some page rows or evidence may already have been saved; fix the database problem and start a **Rescan** rather than relying on that result. Do not relabel stored failures manually to create apparent full coverage.

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

Source, docs-demo, and release Compose set `REPORT_BASE_URL` to `http://ui:3000` by default. Native colocated services default to `http://localhost:3000`. If your UI uses a different internal address, set the value through the deployment method's actual environment or Compose template. An external login gateway must not replace the internal report page with a login screen, and reverse-proxy timeouts must accommodate PDF generation (backend render deadline is four minutes).

PDF/CSV/LLM toggles apply through dashboard routes; Shopkeeper also enforces the PDF toggle and a per-process request limit on direct backend PDF downloads. That limit stays occupied until each response is sent. A 503 with `Retry-After` means the dashboard queue or backend PDF limit is busy; retry shortly. Report metadata availability is not proof a file has already been generated.

## Link checks, update notices, and caches

For link-check problems, inspect the job's own status, `pages_failed`, `truncated`, result categories, and `error_kind`; accessibility completion does not mean its companion has completed. Use a complete webpage URL reachable from Shopkeeper, not a sitemap XML file or a browser-only login URL. Extraction is HTML-only and does not verify fragment anchors. Entered root origins are trusted and may be private; external discovered destinations and off-origin redirects are restricted. Keep job-creation access protected instead of removing policy to make a blocked target pass. [Link Checker Architecture](../architecture/link-checker.md) covers limits, lifecycle, source/reference paging, and safe evidence collection.

`LIME_UPDATE_CHECK` defaults on when unset; explicit false disables outbound GitHub checks. The per-browser setting only hides the card. Dismissing a release hides that exact tag on the same origin, not all future releases. The endpoint intentionally returns 200 with no latest release/card on best-effort failures; this is not a deployment failure. See [Updating LIME](updates.md).

Score/issue caches use scan timestamps plus their TTL, and triage invalidates them. Server-wide UI settings can be cached for five seconds in another UI process. `reportDataCacheTtlSeconds` is reserved and does not currently cache report responses. Use [Performance And Caching](../performance.md) before tuning values or assuming a cached export exists.

## Reporting a problem

Include the LIME version, deployment method, affected scan or check ID, expected result, actual result, and relevant logs. For scan problems, include the status and viewport; for request failures, include the HTTP response code. Note whether the issue also occurs in the isolated `make verify-app` stack. Remove credentials, private URLs, and sensitive page content before sharing, and use a small reproducible example when possible.
