# Accessibility Scanner System Documentation

Welcome to the internal documentation for the Shopkeeper accessibility scanner system. This project aims to build a scalable, multi-threaded accessibility scanning tool using axe-core, orchestrated by a Go backend, and presented through a NextJS user interface.

## System Architecture

The project is divided into several core components:

1. **[Shopkeeper (Main Backend & Orchestrator)](architecture/shopkeeper.md)**: The core Go application that manages the entire lifecycle of a scan.
2. **[Profiler](architecture/profiler.md)**: Module responsible for recursively extracting URLs from a sitemap (including sitemap indexes).
3. **[Juicer](architecture/juicer.md)**: Module responsible for scanning individual URLs using axe-core, capturing screenshots, and processing pages in a controlled, multi-threaded manner.
4. **[Sweetner](architecture/sweetner.md)**: Module responsible for refining, batching, and aggregating scan results to prevent duplicate issue reporting.
5. **[User Interface (NextJS)](architecture/ui.md)**: The frontend application residing in the `lime` folder, interacting with the Shopkeeper API.

## Additional Documentation

* **[Local Development Setup](setup.md)**: How to set up and run the project locally, including environment variables and available commands.
* **[Database Architecture](database.md)**: Details regarding the chosen database schema, technologies (PostgreSQL, Drizzle), and the Go backend DB strategy.
* **[Docker & Deployment](deployment/docker.md)**: Instructions and architecture for containerizing the application for easy local execution and deployment.
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

## Guidelines for Contributing

* Ensure all new features or modules are documented here first before coding starts.
* Code must be thoroughly commented to ensure maintainability and to help auto-generate future documentation.
* The `docs/index.md` serves as the single source of truth for the project. Keep the structure organized and up to date.
