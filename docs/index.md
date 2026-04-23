# LIME Documentation

LIME is a self-hosted accessibility scanner powered by axe-core, Chromium, PostgreSQL, and a NextJS dashboard. These docs cover local development, architecture, production deployment, updates, and release operations.

## Start Here

* **[Local Development Setup](setup.md)**: Run LIME locally with Docker or native processes, including environment variables and common commands.
* **[Docker & Release Pipeline](deployment/docker.md)**: Local Docker workflow, production build targets, GHCR release publishing, and release bundle format.
* **[Deploy to Fly.io](deployment/fly.md)**: Two-app Fly setup with private networking, managed/external Postgres, screenshot storage, and rolling updates.
* **[Deploy to a VPS with Docker](deployment/vps-docker.md)**: Recommended VPS path using published GHCR images.
* **[Deploy to a VPS without Docker](deployment/vps-native.md)**: Native systemd install for operators who cannot run Docker.
* **[Updating LIME](deployment/updates.md)**: Update commands per target, backups, rollback notes, and the sidebar update notice.

## Architecture

1. **[Shopkeeper (Main Backend & Orchestrator)](architecture/shopkeeper.md)**: The core Go application that manages the entire lifecycle of a scan.
2. **[Profiler](architecture/profiler.md)**: Module responsible for recursively extracting URLs from a sitemap (including sitemap indexes).
3. **[Juicer](architecture/juicer.md)**: Module responsible for scanning individual URLs using axe-core, capturing screenshots, and processing pages in a controlled, multi-threaded manner.
4. **[Sweetner](architecture/sweetner.md)**: Module responsible for refining, batching, and aggregating scan results to prevent duplicate issue reporting.
5. **[User Interface (NextJS)](architecture/ui.md)**: The frontend application residing in the `lime` folder, interacting with the Shopkeeper API.

## Reference

* **[Database Architecture](database.md)**: Details regarding the chosen database schema, technologies (PostgreSQL, Drizzle), and the Go backend DB strategy.
* **[Development Roadmap & Build Steps](roadmap.md)**: Step-by-step track of what needs to be built and current progress.

Operational notes for scan lifecycle behavior are documented primarily in:
- `docs/architecture/shopkeeper.md` for backend ownership, deletion/rescan rules, and restart recovery
- `docs/architecture/ui.md` for polling and page-navigation behavior
- `docs/setup.md` for runtime and debugging commands

ACT enrichment notes are documented primarily in:
- `docs/architecture/shopkeeper.md` for the shared catalog, resolver behavior, and API enrichment model
- `docs/architecture/sweetner.md` for how Sweetner's canonical axe rule IDs feed ACT lookups later
- `docs/architecture/ui.md` for where ACT guidance appears in the interface
- `docs/setup.md` for ACT catalog refresh and runtime path resolution

Release and production build notes are documented primarily in:
- `docs/deployment/docker.md` for GHCR publishing, release bundles, and production Docker usage
- `docs/setup.md` for `make build`, `make build-docker`, native local env expectations, and release runtime env requirements
- `README.md` for the quick-start release workflow

Runtime proxy notes are documented primarily in:
- `docs/architecture/ui.md` for the same-origin `/api/...` proxy behavior and screenshot delivery model
- `docs/deployment/docker.md` for `SHOPKEEPER_URL`, external-DB release usage, and reverse-proxy deployment behavior

## Guidelines For Contributing

* Ensure all new features or modules are documented here first before coding starts.
* Code must be thoroughly commented to ensure maintainability and to help auto-generate future documentation.
* The `docs/index.md` serves as the single source of truth for the project. Keep the structure organized and up to date.
