# LIME Release Bundle

This bundle runs the published LIME containers without building from source.

## Files

- `docker-compose.release.yml` — release stack using published GHCR images
- `.env.example` — environment template with the release image tag, public ports, runtime Shopkeeper target, and database settings
- `data/` — checked-in ACT and axe metadata required by the app

## Usage

1. Copy `.env.example` to `.env`
2. Set `DATABASE_URL` to your external PostgreSQL connection string
3. Review `LIME_IMAGE_REGISTRY`, `LIME_IMAGE_TAG`, the public ports, and the internal Shopkeeper target in `SHOPKEEPER_URL`
4. Start the stack:

```bash
docker compose --env-file .env -f docker-compose.release.yml up -d
```

`DATABASE_URL` is the source of truth for both Shopkeeper and the UI. The UI also reads PostgreSQL directly for server-rendered pages, so it must be able to reach the same database.
Browser traffic stays same-origin under the UI host, and the Next server proxies `/api/...` requests to `SHOPKEEPER_URL` at runtime.

## Public URLs

- UI: `http://localhost:<LIME_UI_PORT>`
- Shopkeeper API (optional direct access): `http://localhost:<LIME_API_PORT>`
