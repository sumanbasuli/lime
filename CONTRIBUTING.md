# Contributing To LIME

Thanks for helping improve LIME. This project is a self-hosted accessibility scanner with a Go backend, a NextJS dashboard, and PostgreSQL as the shared data store.

## Development Setup

Use Git, Make, and Docker with Compose for the source-built stack. Start Docker first; in a new checkout and with no existing database volume:

```bash
make init-env
make start-all
```

The dashboard is at `http://localhost:3000`; backend health is at `http://localhost:8080/api/health`. Use `make start-dev` instead for dashboard hot reload. Do not overwrite an existing `.env` or reset its volumes to update source.

For native development, follow [Setup](docs/setup.md) for Go/Node versions, dependency installation, Chromium, and environment handling. Run the backend and dashboard commands in separate terminals:

```bash
make start-db
SHOPKEEPER_SCREENSHOT_DIR="$PWD/.artifacts/native-screenshots" make dev-shopkeeper
make dev-ui
```

To edit the marketing website and docs independently of the dashboard:

```bash
npm --prefix docs-site ci
make docs-dev
```

Open `http://localhost:3001/`. See [Docs Site](docs/docs-site.md) for content ownership and screenshot refresh instructions.

## Before Opening A PR

Run the checks that match the files you touched.

For frontend changes:

```bash
npm --prefix lime run lint
(cd lime && npx tsc --noEmit)
```

For backend changes:

```bash
(cd shopkeeper && go test ./...)
```

For website/docs changes:

```bash
npm --prefix docs-site run lint
(cd docs-site && npx tsc --noEmit)
make docs-verify
```

For product/API/lifecycle/report/settings changes, run `make verify-app`. It builds an isolated production stack and disposable fixtures; it must not use normal local scans or settings. Canonical MCP/proxy changes also need `npm --prefix lime run test:mcp-transport`; release-notice changes need `npm --prefix lime run test:update-notice`. See [Verification And Handoff](docs/verification.md) for prerequisites, coverage, artifacts, and the dated test record.

For release, Docker, migration, or cross-stack changes:

```bash
make build
```

## Database Changes

- Add a new numbered SQL migration pair under `shopkeeper/migrations/`; never change a migration already applied by a released build.
- Supply the matching down migration, but do not assume a schema rollback can recover deleted data or undo a release safely.
- Mirror schema changes in `lime/src/db/schema.ts`.
- Keep Shopkeeper as the owner of writes for scan lifecycle and scan results.
- NextJS owns settings and derived read caches; keep scan/audit writes in Shopkeeper.

## Documentation Changes

Update docs with code changes that affect:

- setup or deployment
- runtime configuration
- database schema
- scan lifecycle behavior
- report/export behavior
- public APIs

Start with [docs/index.md](docs/index.md). Update curated user workflows in `docs-site/content/product-docs.ts`, repository reference material under `docs/`, and endpoint descriptions in `docs-site/content/api.ts` as appropriate. Keep public navigation and source links in sync. See [Docs Site](docs/docs-site.md) for the renderer's supported Markdown and build checks.

## Pull Request Expectations

- Keep PRs scoped to one behavior or workstream.
- Include verification notes in the PR description.
- Do not mix unrelated formatting churn with functional changes.
- Do not add new production dependencies without documenting deployment and upgrade impact.
