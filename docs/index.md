# Documentation Reference

Use this reference to run, maintain, or contribute to LIME. If you want to scan a website and review its results, start with the [user guides](https://lime.heysuman.com/docs/user/) instead.

LIME is a self-hosted accessibility scanner built with axe-core, Chromium, PostgreSQL, a Go backend, and a Next.js dashboard. Automated findings are a starting point for accessibility review, not proof that a website meets every accessibility requirement.

## Choose your path

| I want to… | Start here | Continue with |
| --- | --- | --- |
| Try LIME on my computer | [Local setup](setup.md) | [Create your first scan](https://lime.heysuman.com/docs/user/first-scan/) |
| Host an instance for a team | [Docker deployment](deployment/docker.md), [Debian](deployment/debian.md), or [Fly.io](deployment/fly.md) | [Backups and restore](deployment/backup-restore.md), then [updates](deployment/updates.md) |
| Fix an installation or scan problem | [Operator troubleshooting](deployment/troubleshooting.md) | [Setup diagnostics](setup.md) |
| Connect an AI tool | [User MCP guide](https://lime.heysuman.com/docs/user/mcp/) | [MCP protocol and integration reference](mcp.md) |
| Check broken destinations | [User link-checker guide](https://lime.heysuman.com/docs/user/link-checker/) | [Link checker architecture and limits](architecture/link-checker.md) |
| Change the code | [Contributing](../CONTRIBUTING.md) | [Architecture](architecture/shopkeeper.md) and [verification](verification.md) |
| Improve the website or guides | [Docs site](docs-site.md) | [Verification and handoff](verification.md) |

## For operators

- [Local setup](setup.md): prerequisites, ports, environment variables, and Docker or native development.
- [Docker deployment](deployment/docker.md): release bundles, pinned images, persistence, and reverse proxies.
- [Debian deployment](deployment/debian.md): native Linux services and installation paths.
- [Fly.io deployment](deployment/fly.md): separate backend and UI apps, private networking, and persistent screenshots.
- [Backups and restore](deployment/backup-restore.md): protect both PostgreSQL data and screenshot evidence before changes.
- [Updating LIME](deployment/updates.md): upgrade choices, migration and rollback limits, and the update notice.
- [Operator troubleshooting](deployment/troubleshooting.md): work from symptoms to service, database, Chromium, and report checks.

## For contributors

- [Contributing](../CONTRIBUTING.md): development workflow and pull request expectations.
- [Verification and handoff](verification.md): reproducible checks, recorded evidence, and known boundaries.
- [Docs site](docs-site.md): content sources, local preview, search, screenshots, and publishing.
- [Roadmap](roadmap.md): shipped foundations versus proposed work. A roadmap item is not an available feature.

## Technical reference

| Component | Responsibility |
| --- | --- |
| [Shopkeeper](architecture/shopkeeper.md) | HTTP API, scan orchestration, persistence, and lifecycle recovery |
| [Profiler](architecture/profiler.md) | Sitemap discovery and URL collection |
| [Juicer](architecture/juicer.md) | Chromium workers, axe-core audits, and screenshot capture |
| [Sweetner](architecture/sweetner.md) | Normalize and group audit evidence |
| [Link checker](architecture/link-checker.md) | Bounded HTTP extraction and destination checks, saved source references, and scan companions |
| [Dashboard](architecture/ui.md) | Results, scoring, triage, reports, settings, and same-origin proxy routes |

- [Database](database.md): schema, migrations, and data ownership.
- [Performance and caching](performance.md): read models, cache invalidation, and report costs.
- [MCP integration](mcp.md): read-only tools, authentication, client examples, and transport limits.
- [API reference](https://lime.heysuman.com/api/): endpoint ownership, request examples, and responses.

## Keep the docs trustworthy

User guides explain the dashboard workflow; this reference explains how it works and how to operate it. Keep both in sync when behavior changes. Document defaults, prerequisites, destructive operations, and known limitations alongside the relevant instructions. Add or update verification evidence before claiming a feature is tested.

The public website and dashboard are separate applications. The documentation URL is [lime.heysuman.com/docs/](https://lime.heysuman.com/docs/); the full website also includes the API reference, screenshots, and roadmap. Local preview instructions are in [Docs site](docs-site.md).
