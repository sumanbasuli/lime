# LIME Product Roadmap

This roadmap tracks the work needed to move LIME from the current stable self-hosted scanner to a public `v1.0` release, then harden MCP and future integrations after release.

## Current Baseline

LIME already has the core product shape in place:

- sitemap and single-page scans
- strict same-host profiling for new scans
- viewport-aware axe-core execution through Shopkeeper
- focused screenshots, issue grouping, ACT guidance, and false-positive triage
- partial-scan failed-page retry inside the same scan
- full-scan and per-issue PDF, CSV, and LLM exports
- server-wide Settings for report limits and export feature flags
- read-only MCP endpoint with generated bearer key auth
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
- Integrations: MCP enablement and key generation controls.

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

## V2.0: MCP Hardening And Integration Polish

### Goal

Harden the existing read-only MCP integration so more third-party AI tools can inspect scans and reports from outside the LIME dashboard.

### Current Baseline

LIME already:

- Exposes `POST /mcp` on the existing Shopkeeper HTTP service.
- Controls MCP runtime availability from Settings.
- Allows users to generate and regenerate an MCP key in Settings.
- Stores only a hash of the MCP key.
- Shows the raw key only at generation or regeneration time.
- Requires `Authorization: Bearer <mcp-key>` on MCP requests.
- Exposes read-only tools for scans, issue summaries, issue details, report metadata, and visible settings.

### Planned Hardening

- Add configurable origin allowlisting for non-local browser-based MCP clients.
- Improve compatibility with clients that expect full Streamable HTTP session behavior.
- Add clearer runtime diagnostics for disabled MCP, missing keys, and rejected origins.
- Leave OAuth-based MCP authorization for a later version.

### Current MCP Capability Set

The current MCP endpoint is read-only.

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
- MCP must not trigger report generation automatically.

Exit criteria:

- Common third-party MCP clients can connect over HTTP with the generated key.
- Unauthorized requests return `401`.
- Disabled MCP returns a clear unavailable response.
- Rejected origins are understandable and configurable.
- Read-only scan and issue inspection works against large scans.

## Deferred

- Redis as a required production dependency.
- Full OAuth 2.1 MCP authorization.
- MCP write/admin tools.
- Distributed scan workers.
- Multi-tenant authentication and authorization.
