# Fly.io Deployment

LIME runs on Fly.io as two apps:

- **`lime-shopkeeper`** - Go backend + headless Chromium. Internal only.
- **`lime-ui`** - NextJS dashboard. Public via Fly's shared proxy.

They talk to each other over Fly's private `.internal` network. PostgreSQL is provided separately, either Fly's Managed Postgres (MPG) or an external provider such as Neon or Supabase.

## Prerequisites

- `flyctl` installed and authenticated: <https://fly.io/docs/flyctl/install/>
- A Fly organization (default `personal` works fine)
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
export LIME_UPDATE_CHECK=true                 # optional (show update notices)

./scripts/fly-deploy.sh v0.1.0
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

./scripts/fly-deploy.sh v0.1.0
```

The helper:

1. creates the two apps if they do not already exist
2. provisions a `lime_screenshots` volume (10 GB by default, override with `LIME_VOLUME_SIZE_GB`)
3. stores or reuses `DATABASE_URL`, and sets `SHOPKEEPER_URL` plus `LIME_UPDATE_CHECK` as Fly secrets
4. deploys both apps from published GHCR images with the `rolling` strategy

Custom app names or regions:

```bash
./scripts/fly-deploy.sh v0.1.0 my-shop my-ui fra
```

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
- Shopkeeper has no public port. Expose one temporarily for debugging with `flyctl proxy 8080 -a lime-shopkeeper`.

## Custom domains

```bash
flyctl certs create -a lime-ui lime.example.com
# add the DNS record Fly prints, then:
flyctl certs check -a lime-ui lime.example.com
```

## Updates

```bash
./scripts/fly-update.sh v0.2.0
```

Rolling update behaviour:

1. Shopkeeper deploys first; migrations run on boot.
2. UI deploys second.

Each app has `min_machines_running = 1` by default. Scale machines up to avoid any brief interruption during the restart:

```bash
flyctl scale count 2 -a lime-shopkeeper
flyctl scale count 2 -a lime-ui
```

Fly's rolling deploy replaces machines one at a time when more than one machine is running.

## Screenshots storage

Screenshots are stored on the volume mounted at `/app/screenshots` inside Shopkeeper. A single volume is pinned to one Fly machine. If you scale Shopkeeper to multiple machines, each machine will have its own screenshot disk. For v1 run a single Shopkeeper machine; a scale-out story will be documented in a later release.

## Notes and caveats

- Chromium needs memory. `shared-cpu-2x@2048MB` is the minimum that reliably completes multi-page scans. Bump to `performance-2x@4096MB` for large sites.
- Autoscale is off on Shopkeeper to keep scans and the screenshot volume on a known machine. The UI auto-stops when idle.
- `LIME_UPDATE_CHECK=true` enables the sidebar update notice by calling the GitHub releases API once per load.
