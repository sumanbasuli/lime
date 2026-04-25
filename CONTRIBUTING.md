# Contributing To LIME

Thanks for helping improve LIME. This project is a self-hosted accessibility scanner with a Go backend, a NextJS dashboard, and PostgreSQL as the shared data store.

## Development Setup

```bash
cp .env.example .env
make start-all
```

Useful commands:

```bash
make migrate-all
make build
```

For native development:

```bash
make start-db
make dev-shopkeeper
make dev-ui
```

## Before Opening A PR

Run the checks that match the files you touched.

For frontend changes:

```bash
cd lime
npm run lint
npx tsc --noEmit
```

For backend changes:

```bash
cd shopkeeper
go test ./...
```

For release, Docker, migration, or cross-stack changes:

```bash
make build
```

## Database Changes

- Add forward-only SQL migrations under `shopkeeper/migrations/`.
- Add matching down migrations.
- Mirror schema changes in `lime/src/db/schema.ts`.
- Keep Shopkeeper as the owner of writes for scan lifecycle and scan results.
- Keep NextJS direct database usage read-oriented unless a route is explicitly a UI-owned settings route.

## Documentation Changes

Update docs with code changes that affect:

- setup or deployment
- runtime configuration
- database schema
- scan lifecycle behavior
- report/export behavior
- public APIs

Start with `docs/index.md` and link deeper docs from there.

## Pull Request Expectations

- Keep PRs scoped to one behavior or workstream.
- Include verification notes in the PR description.
- Do not mix unrelated formatting churn with functional changes.
- Do not add new production dependencies without documenting deployment and upgrade impact.
