# Fly.io Deployment

LIME runs on Fly.io as two apps:

- **`lime-shopkeeper`** - Go backend + headless Chromium; keep it private to the UI/operator network.
- **`lime-ui`** - NextJS dashboard. Public via Fly's shared proxy.

They talk to each other over Fly's private `.internal` network. PostgreSQL is provided separately, either Fly's Managed Postgres (MPG) or an external provider such as Neon or Supabase.

Run one Shopkeeper machine per database. Startup recovery assumes the previous backend is gone and can reset every active scan; there is no distributed worker lease. A second backend plus the same database is not a supported high-availability scan deployment.

## Prerequisites

- `flyctl` installed and authenticated: <https://fly.io/docs/flyctl/install/>
- A Fly organization, such as `personal`
- A PostgreSQL database reachable from Fly (see [Database options](#database-options))

## Files in the repository

- `deploy/fly/shopkeeper.fly.toml` - Shopkeeper app config (internal, 2 GB RAM, volume for screenshots)
- `deploy/fly/ui.fly.toml` - UI app config (public, 512 MB RAM, auto-stop idle machines)
- `scripts/fly-deploy.sh` - first-time provisioning helper
- `scripts/fly-update.sh` - rolling update helper for new image tags

## First-time deployment

### Option A: External PostgreSQL URL

```bash
export DATABASE_URL='postgresql://...'        # required
export FLY_ORG='personal'                     # optional (default personal)
# Optional: disable the default-enabled GitHub release check.
# export LIME_UPDATE_CHECK=false

./scripts/fly-deploy.sh v2.0.0
```

### Option B: Fly Managed Postgres

Create the two app shells first, attach the database to both, then run the helper. When `DATABASE_URL` is not set locally, the helper checks for an existing `DATABASE_URL` secret on both apps and reuses it.

```bash
flyctl apps create lime-shopkeeper --org personal
flyctl apps create lime-ui --org personal

flyctl mpg create --name lime-db --region iad
flyctl mpg list
flyctl mpg attach <cluster-id> -a lime-shopkeeper
flyctl mpg attach <cluster-id> -a lime-ui

./scripts/fly-deploy.sh v2.0.0
```

The helper:

1. creates the two apps if they do not already exist
2. provisions a `lime_screenshots` volume (10 GB by default, override with `LIME_VOLUME_SIZE_GB`)
3. stores or reuses `DATABASE_URL`, and sets `SHOPKEEPER_URL` plus `LIME_UPDATE_CHECK` as Fly secrets
4. deploys both apps from published GHCR images with the configured `rolling` strategy

The helper does not configure the backend-to-UI report URL. After provisioning the app shells (or after the initial empty deployment, before verification), set it explicitly:

```bash
flyctl secrets set -a lime-shopkeeper REPORT_BASE_URL=http://lime-ui.internal:3000
```

Use your actual UI app name for custom deployments. Shopkeeper's default `http://localhost:3000` cannot reach a different Fly app; PDF downloads fail without the correct internal URL. Changing a secret on an existing deployment can restart machines, so pause/wait for active scans first. The UI's opposite-direction `SHOPKEEPER_URL` is set by the helper.

Custom app names or regions:

```bash
./scripts/fly-deploy.sh v2.0.0 my-shop my-ui fra
```

Persist custom regions/app settings in your deployment configuration. `fly-update.sh` accepts app names but no region argument and reads the checked-in TOML files, whose `primary_region` defaults to `iad`; do not assume a one-time `fra` argument permanently changes later updates.

## Database options

### Fly Managed Postgres (MPG)

```bash
flyctl mpg create --name lime-db --region iad
flyctl mpg list
flyctl mpg attach <cluster-id> -a lime-shopkeeper
flyctl mpg attach <cluster-id> -a lime-ui
```

The attach step writes `DATABASE_URL` into each app's secrets. You can find the cluster ID in the Fly dashboard or with `flyctl mpg list`. If both app secrets already exist, `scripts/fly-deploy.sh` can run without a local `DATABASE_URL` export.

### External PostgreSQL (Neon, Supabase, Crunchy Bridge, etc.)

Set `DATABASE_URL` in the environment before running the deploy script. The helper stores it on both apps as a secret.

## Routing

- The browser talks only to the UI origin (`https://lime-ui.fly.dev` or your custom domain).
- The UI proxies `/api/...` to `http://lime-shopkeeper.internal:8080`.
- For a private operator connection, use `flyctl proxy 8080 -a lime-shopkeeper` rather than publishing the backend.

Check `flyctl ips list -a lime-shopkeeper` and the service configuration before relying on private access. The template includes a `services.ports` entry for port 8080, which can become publicly accessible if the app has a public IP ([configuration reference](https://fly.io/docs/reference/configuration/)). Remove any unwanted public exposure. The ordinary API has no built-in login, and the MCP key does not protect it.

## Custom domains

```bash
flyctl certs create -a lime-ui lime.example.com
# add the DNS record Fly prints, then:
flyctl certs check -a lime-ui lime.example.com
```

## Updates

```bash
./scripts/fly-update.sh v2.0.0
```

The helper invokes Shopkeeper first, then UI, and `flyctl deploy` uses Fly's configured health checks. It does not back up PostgreSQL, screenshots, or secrets. Take a matching recovery set and read [Updating LIME](updates.md) before deploying.

Rolling update behaviour:

1. Shopkeeper deploys first; migrations run on boot.
2. UI deploys second.

Each app has `min_machines_running = 1` in the primary region. Plan for backend interruption while the single Shopkeeper restarts; do not scale it to two machines to attempt zero downtime. UI replicas can reduce UI interruption, but each has its own settings cache and PDF generation limiter. Pause active scans and wait for `paused`, or let them finish, before a planned backend update so completed evidence is preserved.

## Screenshots storage

Screenshots are stored on the volume mounted at `/app/screenshots` inside Shopkeeper. Preserve the existing volume when updating and keep a backup separate from PostgreSQL. A fresh volume can leave database findings intact but screenshot URLs missing. Confirm machine/volume attachment after deployment with `flyctl status -a lime-shopkeeper` and `flyctl volumes list -a lime-shopkeeper`.

## Notes and caveats

- The template allocates Shopkeeper 2 GB and the UI 512 MB. These are configuration defaults, not measured capacity guarantees; concurrent scans/PDFs and complex pages can require more. Check logs and memory before tuning resources.
- Shopkeeper automatic stopping is disabled. UI auto-stop is configured, but `min_machines_running = 1` keeps one UI machine running in the primary region; only excess machines are eligible there.
- GitHub release checks are enabled by default. Set `LIME_UPDATE_CHECK=false` on the UI app to opt out; explicit false values remain disabled. The sidebar card also respects each browser's visibility and release-dismissal preferences; see [Updating LIME](updates.md).

## Verify The Deployment

```bash
flyctl status -a lime-shopkeeper
flyctl status -a lime-ui
flyctl checks list -a lime-shopkeeper
flyctl logs -a lime-shopkeeper
```

Check `/api/health` on the UI, load a dashboard page, finish a small scan, open its saved screenshot, and generate PDF, CSV, and LLM reports. If MCP is enabled, connect a client to `/mcp` on the UI's reachable URL. Keep secrets and database credentials out of issue reports. See [Operational Troubleshooting](troubleshooting.md) if a check fails.
