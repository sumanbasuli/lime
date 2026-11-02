# LIME Release Bundle

This bundle runs the published LIME containers without building from source.

## Files

- `docker-compose.release.yml` — release stack using published GHCR images
- `.env.example` — environment template with the release image tag, public ports, runtime Shopkeeper target, and database settings
- `data/` — checked-in ACT and axe metadata required by the app
- `deploy/docker/` — required Chromium seccomp policy, its source notes, and upstream license

## Usage

1. For a new install, run `umask 077; cp .env.example .env; chmod 600 .env`. Do not overwrite an existing `.env` during an update.
2. Set `DATABASE_URL` to your external PostgreSQL connection string
3. Review `LIME_IMAGE_REGISTRY`, `LIME_IMAGE_TAG`, the public ports, and the internal Shopkeeper target in `SHOPKEEPER_URL`
4. Start the stack:

```bash
docker compose --env-file .env -f docker-compose.release.yml up -d
```

If your server has the legacy standalone binary instead of the Compose plugin, use `docker-compose` with the same arguments.

Chromium's sandbox is required. Keep `deploy/docker/chromium-seccomp.json` beside this Compose deployment and use Docker Engine on Linux amd64/arm64 (or Docker Desktop). For an existing install, obtain the complete updated bundle, preserve the deployment's `.env`, project name, and volumes, and follow the [one-time upgrade instructions](https://lime.heysuman.com/docs/reference/deployment/updates/#one-time-chromium-sandbox-upgrade). Updating only the image tag in an old Compose file will fail the browser startup check. Never use `down -v` during an upgrade.

The entrypoint prepares the existing screenshot volume before dropping to UID/GID `10001` with no capabilities. Supported root-owned legacy files keep their names, contents, and modes. Unsafe entries stop startup with a diagnostic. Custom catalog mounts need read/traverse access for backend UID `10001` and UI UID `1001`; keep screenshots and configuration private.

`DATABASE_URL` is the source of truth for both Shopkeeper and the UI. The UI also reads PostgreSQL directly for server-rendered pages, so it must be able to reach the same database.
Browser traffic stays same-origin under the UI host, and the Next server proxies `/api/...` requests to `SHOPKEEPER_URL` at runtime.

Both UI and Shopkeeper ports are published on host interfaces by default for compatibility. The dashboard and ordinary API have no built-in login; the MCP key does not protect them. Before allowing remote access, restrict the published ports with a firewall or authenticated reverse proxy, allow only your intended hostnames at the proxy, and serve the dashboard over TLS. If clients only need the dashboard, do not expose the direct Shopkeeper port publicly.

Set `LIME_ALLOWED_HOSTS` in `.env` to `ui,shopkeeper` plus each public dashboard or direct API DNS name before exposing a custom domain. Compose passes that list to both services, which return 421 for an unrecognized `Host`; `localhost` and literal IP hosts are always accepted. Use exact comma-separated names without schemes or wildcards. Keep the proxy's original `Host` header. This setting does not replace the firewall or authentication above. Shopkeeper's default memory and total memory-plus-swap limits are both `2g`, allowing no extra swap; set `LIME_SHOPKEEPER_MEMORY_LIMIT` in `.env` if a measured workload needs another ceiling. Preserve both settings and the updated Compose file across bundle upgrades.

## Public URLs

- UI: `http://localhost:<LIME_UI_PORT>`
- Shopkeeper API (optional direct access): `http://localhost:<LIME_API_PORT>`
