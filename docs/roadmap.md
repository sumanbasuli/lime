# LIME Product Roadmap

This roadmap separates the shipped 1.x product from work that still needs validation or implementation. It is not a release schedule or a claim that every deployment, client, public website, or large scan has been verified. See [Verification And Handoff](verification.md) for the tested baseline and its limits, and [CHANGELOG](../CHANGELOG.md) for release history.

## Current Shipped Baseline

The existing product includes:

- Sitemap and single-page scans with same-host profiling and viewport presets.
- Configured WCAG A/AA axe-core checks, issue grouping, local ACT guidance, focused yellow-highlight screenshots, and distinct preview/full-image review.
- Pause/resume, startup recovery, failed-page retry within the same partial scan, and full rescans.
- False-positive triage, score/cache updates, and inherited decisions for matching future scans.
- Scan-level and issue-scoped PDF, CSV, and LLM exports, with reporting limits and export flags.
- Server-wide Reporting, Performance, and Integrations settings stored in PostgreSQL.
- PostgreSQL score/issue-summary read caches, paginated occurrence reads, request timing, and a dashboard PDF-generation concurrency cap.
- A redesigned dashboard, static marketing website/docs, and a Link checker design preview.
- A read-only MCP endpoint, one generated instance key, and six bounded tools for saved data.
- Source-built Docker development, published images/release bundles, and Docker, Fly.io, and Debian deployment/update helpers.
- Contributor/security guidance and release publishing tied to `VERSION` and `CHANGELOG.md`.

The deterministic verification suite covers existing dashboard/API/data workflows in an isolated production stack. MCP checks include pinned official SDK v1/v2 clients and a pinned local stdio bridge. These checks do not establish that every installed AI application or remote deployment has connected.

## Next Validation And Hardening Priorities

### Repeatable Large-Site Measurement

The performance foundations are implemented; larger workloads still need measured evidence. Add a repeatable benchmark that records data size, configured limits, hardware, concurrency, and timings for:

- Dashboard and scan score/coverage summaries.
- Issue-page first render, summary chunks, and occurrence detail.
- Full and scoped PDF, CSV, and LLM exports.
- Concurrent reads and triage/report cache invalidation.

Use the existing request timing and PostgreSQL read models first. Keep occurrence reads paginated and report generation bounded. The report-cache table and TTL setting are reserved infrastructure; current report loaders do not consume them. Implement and measure any report-input cache before describing it as active. Do not add Redis or distributed workers without measurements showing a problem the current architecture cannot address. See [Performance](performance.md).

### Deployment And Release Validation

Document target-specific fresh install, upgrade, backup, restore, and rollback checks. A local production-stack pass is not a Fly.io or Debian deployment pass, nor does a fresh disposable database prove an upgrade from an older release.

Before claiming a target is verified:

1. Record its release versions and configuration.
2. Test migrations against representative existing data as well as a fresh database.
3. Verify persisted scans, screenshots, settings, report generation, and MCP after upgrade.
4. Exercise a recoverable backup/restore path; do not assume every update helper performs a backup.
5. Record dependency/security review results and unresolved findings separately from functional tests.

See [Setup](setup.md), the [operator guides](index.md#for-operators), and [Verification And Handoff](verification.md).

### Client Interoperability And Diagnostics

Current MCP behavior is stateless Streamable HTTP with JSON `POST` responses. A `GET` response of 405 and the absence of session IDs are intentional, not by themselves a compatibility defect.

Collect evidence from real client/deployment combinations before extending the protocol. Possible follow-up work includes clearer connection diagnostics, configurable origin policies for non-local browser clients, and session/streaming support if a justified client workflow needs it. OAuth and scoped keys remain deferred; they are not part of the current static bearer-key contract. See [MCP Integration](mcp.md).

## Future Product Work

### Link Checker

The current screen is a design preview with a disabled run action. Link checking, persisted runs/results, progress, retries, and exports need a backend workflow and end-to-end verification before the feature can be described as available. Add user instructions and API/reference documentation alongside that implementation, not ahead of it.

### Integration Boundaries

The current MCP tools read saved scans, scores, issue groups/details, report availability, and non-secret settings. They do not create scans, pause/resume/retry/delete/rescan, change false-positive state, mutate settings, or generate reports automatically.

Preserve these boundaries when refining the integration:

- Disabling MCP rejects new requests; rotating the instance key revokes the previous key.
- Keep key material out of responses, shared configuration, logs, and screenshots except the one-time generation response shown to the operator.
- Keep issue/group/occurrence pagination bounded.
- Authenticate before dashboard score enrichment.
- Return report/screenshot paths using the existing serving routes; do not imply that those ordinary HTTP routes inherit MCP authentication.

The dashboard, ordinary HTTP APIs, reports, and saved screenshot routes do not have built-in user authentication. Protect a remotely reachable deployment externally. Adding multi-tenant identity or authorization would be a separate product/security design, not a consequence of enabling MCP.

## Deferred

- Redis as a required production dependency.
- Distributed scan workers.
- OAuth-based MCP authorization and scoped instance keys.
- MCP write/admin tools.
- Multi-tenant authentication and authorization.
- Profile/account management behind the sidebar identity display.

Work step by step: establish the existing baseline, make one scoped change, verify the browser/API/data flow, and update the relevant user and developer guides before moving on.
