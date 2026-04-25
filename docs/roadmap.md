# LIME Product Roadmap

This roadmap tracks the work needed to move LIME from the current stable self-hosted scanner to a public `v1.0` release and then to a read-only MCP-enabled `v2.0`.

## Current Baseline

LIME already has the core product shape in place:

- sitemap and single-page scans
- strict same-host profiling for new scans
- viewport-aware axe-core execution through Shopkeeper
- focused screenshots, issue grouping, ACT guidance, and false-positive triage
- partial-scan failed-page retry inside the same scan
- full-scan and per-issue PDF, CSV, and LLM exports
- server-wide Settings for report limits and export feature flags
- Docker, Fly.io, GHCR images, release bundles, and update scripts

The remaining work before `v1.0` is primarily performance hardening, release polish, and public project hygiene.

## V1.0: Optimization And Public Release

### Goal

Make large scans feel fast and predictable for operators, especially when viewing issue details and generating reports, while keeping the deployment simple enough for self-hosted users.

### Defaults

- Use PostgreSQL-first caching and read models for `v1.0`.
- Do not add Redis as a required dependency for `v1.0`.
- Revisit Redis only after profiling shows a problem that PostgreSQL read models, indexes, and bounded in-process caches do not solve.
- Keep performance controls minimal in Settings.

### Priority Hot Paths

Optimize these paths first:

- dashboard recent scans and score summaries
- scan detail score and coverage summaries
- `/scans/[id]/issues` first render
- issue chunk and issue detail loading
- full and scoped report-data loading
- PDF, CSV, and LLM export startup latency

### Workstream 1: Measurement

- Add lightweight request timing around hot NextJS routes and Shopkeeper report routes.
- Add repeatable large-scan benchmark notes for dashboard, issues page, issue chunks, issue detail, full PDF, and scoped PDF.
- Capture baseline numbers before changing the data model.
- Add slow-query visibility for development and Docker verification.

Exit criteria:

- A large-scan benchmark can be repeated locally.
- The slowest queries for the issues page and report generation are identifiable.

### Workstream 2: PostgreSQL Read Models And Indexes

- Add composite indexes for the real hot predicates and ordering patterns used by issue pages, score summaries, exports, and retry/delete flows.
- Add persisted read models or cache tables for per-scan score, coverage, and issue-card summaries.
- Keep occurrence detail queries live and paginated.
- Avoid rebuilding a full in-memory issue list just to serve the first issue-page chunk.
- Refresh or invalidate derived data when scans complete, failed-page retries finish, false-positive state changes, report-shaping settings change, or scans are deleted.

Exit criteria:

- The issues page loads bounded initial data for large scans.
- Dashboard and scan score summaries do not repeatedly aggregate the full audit tables.
- False-positive toggles update summary state correctly.

### Workstream 3: Report Generation

- Reuse the same read models for PDF, CSV, and LLM report inputs.
- Keep full reports bounded by Settings limits.
- Keep issue-specific CSV as the full occurrence export path.
- Preserve screenshots in PDFs while keeping repeated context deduplicated by reference.
- Add a report-generation concurrency cap in Settings.
- Cache report-input metadata by scan, scope, format, and settings fingerprint where it avoids repeated expensive reads.

Exit criteria:

- Full and scoped PDF generation starts with immediate UI feedback.
- Report generation does not require a full recomputation of all issue summaries on every request.
- Existing export feature flags continue to gate PDF, CSV, and LLM routes.

### Workstream 4: Settings

Evolve Settings into three sections:

- Reporting: existing PDF, CSV, and LLM limits and feature flags.
- Performance: summary cache TTL, report-data cache TTL, and report concurrency cap.
- Integrations: reserved for MCP controls in `v2.0`.

Exit criteria:

- Existing report settings migrate safely.
- New performance defaults work without operator changes.
- Settings remain server-wide and stored in PostgreSQL.

### Workstream 5: Public Open-Source Release

- Add contributor, security, issue, and PR documentation.
- Make `README.md` and `docs/index.md` point users to support, security, deployment, updates, performance, and roadmap docs.
- Keep release publishing tied to `VERSION`, `CHANGELOG.md`, Docker images, and GitHub Releases.
- Verify fresh installs and upgrades through Docker and Fly.io paths.

Exit criteria:

- `make build` passes.
- Fresh database migrations pass.
- Existing database migrations pass.
- Docker and Fly.io smoke checks are documented.
- Public docs are sufficient for a self-hosted operator to install, update, report issues, and contribute.

## V2.0: Read-Only MCP Integration

### Goal

Expose LIME to third-party AI tools through MCP so users can inspect scans and reports from their preferred AI client without needing that client to run inside the LIME dashboard.

### Transport And Auth

- Use the official Streamable HTTP MCP transport model.
- Expose MCP on the existing Shopkeeper HTTP service at a dedicated endpoint such as `/mcp`.
- Control MCP runtime availability from Settings.
- Allow users to generate and regenerate an MCP key in Settings.
- Store only a hash of the MCP key.
- Show the raw key only at generation or regeneration time.
- Require `Authorization: Bearer <mcp-key>` on MCP requests.
- Leave OAuth-based MCP authorization for a later version.

### First MCP Capability Set

The first MCP release is read-only.

Expose tools or resources for:

- listing scans
- reading scan status, progress, score, coverage, and metadata
- listing issue groups for a scan
- reading issue details with paginated occurrences
- reading report availability and export metadata
- reading relevant reporting and performance settings

Do not expose:

- scan creation
- scan pause, resume, retry, delete, or rescan
- false-positive mutation
- Settings mutation
- destructive admin actions

### MCP Safety Requirements

- Disabling MCP in Settings immediately rejects new MCP requests.
- Regenerating the key revokes the old key.
- MCP responses must use bounded pagination for large scans.
- MCP must not expose screenshot files outside the existing authenticated request model.
- MCP must not trigger report generation automatically in the first release.

Exit criteria:

- A third-party MCP client can connect over HTTP with the generated key.
- Unauthorized requests return `401`.
- Disabled MCP returns a clear unavailable response.
- Read-only scan and issue inspection works against large scans.

## Deferred

- Redis as a required production dependency.
- Full OAuth 2.1 MCP authorization.
- MCP write/admin tools.
- Distributed scan workers.
- Multi-tenant authentication and authorization.
