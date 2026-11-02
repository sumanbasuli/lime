# LIME Product Roadmap

LIME 2.0 brings accessibility scans, link checking, and AI-assisted workflows together in one self-hosted workspace. This roadmap describes what's available and where the project is heading. Planned work has no fixed release date; see the [changelog](../CHANGELOG.md) for release history.

## Current Accessibility And Integration Capabilities

Available in LIME 2.0:

- Sitemap and single-page scans with same-host profiling and viewport presets.
- WCAG A/AA axe-core checks, grouped findings, ACT guidance, and highlighted screenshots with compact previews and expanded views.
- Pause/resume, startup recovery, failed-page retry within the same partial scan, and full rescans.
- False-positive triage, score/cache updates, and inherited decisions for matching future scans.
- Scan-level and issue-scoped PDF, CSV, and LLM exports, with reporting limits and export flags.
- Server-wide Reporting, Performance, and Integrations settings stored in PostgreSQL.
- PostgreSQL score/issue-summary read caches, paginated occurrence reads, request timing, and a dashboard PDF-generation concurrency cap.
- A dashboard for managing scans and results, with a public website and documentation.
- MCP support for reading findings and exports, managing scans and link checks, reviewing false positives, and changing reporting and performance settings. Connections are read-only by default, with write access enabled separately in Settings. Setup examples cover Codex, Claude Code, and OpenCode.
- A LIME agent with reusable skills and an OpenClaw configuration example.
- Source-built Docker development, published images/release bundles, and Docker and Debian deployment/update helpers.
- Contributor/security guidance and release publishing tied to `VERSION` and `CHANGELOG.md`.

See [Verification](verification.md) for the test suite and [MCP Integration](mcp.md) for supported tools and client setup.

## Current Link-Checking Capabilities

### Link Checker

Check a single page or follow links across the same site. Saved results show destinations, source references, progress, and response details. You can cancel a running check, recheck a saved result, delete it, or export CSV.

Select **Include link check** when starting an accessibility scan to run both. The link check starts after accessibility finishes and has its own results; it does not affect the accessibility score. See the [user guide](https://lime.heysuman.com/docs/user/link-checker/) for instructions and [architecture reference](architecture/link-checker.md) for crawl limits and HTTP behavior.

## Next Validation And Hardening Priorities

### Repeatable Large-Site Measurement

The next performance priority is a repeatable benchmark for larger sites. It should measure:

- Dashboard and scan score/coverage summaries.
- Issue-page first render, summary chunks, and occurrence detail.
- Full and scoped PDF, CSV, and LLM exports.
- Concurrent reads and triage/report cache invalidation.

Record data size, limits, hardware, and concurrent work alongside the results so comparisons are useful. Start with the existing PostgreSQL summaries and request timings. Report caching is a possible improvement; its schema exists, but current report loaders do not use it. See [Performance](performance.md).

### Deployment And Release Validation

Expand install and upgrade coverage across supported deployment methods, including migrations from older releases and recovery from backups.

For each deployment method:

1. Record its release versions and configuration.
2. Test migrations against representative existing data as well as a fresh database.
3. Verify persisted scans, screenshots, settings, report generation, and MCP after upgrade.
4. Exercise a recoverable backup/restore path; do not assume every update helper performs a backup.
5. Review dependencies and record any issues that still need attention.

See [Setup](setup.md), the [operator guides](index.md#for-operators), and [Verification](verification.md).

### Client Interoperability And Diagnostics

LIME uses stateless Streamable HTTP with JSON `POST` responses. It does not use MCP sessions or an SSE stream; `GET /mcp` returns 405.

Planned improvements include clearer connection diagnostics and broader client compatibility testing. Origin controls, sessions, and streaming may follow where clients need them. OAuth and scoped keys remain future work. See [MCP Integration](mcp.md).

## Future Product Work

### Broader Link-Checking Workflows

Possible additions include scheduled checks, notifications, JavaScript-rendered links, authenticated crawling, and fragment-anchor checks. These are not available yet. Feedback from current users will help set their priority.

### Integration Boundaries

MCP gives AI clients access to saved results and, when write access is enabled, scan management, link checks, false-positive review, and reporting settings.

Future integration work should preserve these controls:

- Disabling MCP rejects new requests; rotating the instance key revokes the previous key.
- Write access defaults false, including for existing keys after upgrade. Permission/key administration stays in the dashboard; MCP cannot enable its own access.
- Require confirmation for deletion and settings changes. Keep durable request IDs for new-job actions; an uncertain interrupted reservation must not automatically launch another job.
- Keep key material out of responses, shared configuration, logs, and screenshots except the one-time generation response shown to the operator.
- Keep issue/group/occurrence pagination bounded.
- Authenticate before dashboard score enrichment.
- Return report/screenshot paths using the existing serving routes; do not imply that those ordinary HTTP routes inherit MCP authentication.

The dashboard, ordinary HTTP APIs, reports, and saved screenshots do not have built-in user authentication. Remote deployments need access controls at the network or reverse proxy. User accounts and multi-tenant access would require a separate authentication design.

## Deferred

- Redis as a required production dependency.
- Distributed scan workers.
- OAuth-based MCP authorization and scoped instance keys.
- MCP key/permission administration, OAuth login, and per-client write scopes.
- Multi-tenant authentication and authorization.
- Profile/account management behind the sidebar identity display.

Contributions should include tests for the affected workflow and updates to the relevant user and developer guides.
