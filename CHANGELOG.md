# Changelog

All notable changes to LIME are tracked here. The release workflow uses the
section matching `VERSION` to populate GitHub Release notes.

## [Unreleased]

- Replaced the Link Checker preview with persisted standalone page/crawl jobs, bounded HTTP destination checks, grouped source references, lifecycle actions, and link CSV exports; added an optional **Include link check** companion for normal scans without changing accessibility scoring or screenshot evidence.
- Added link-checker user/API/architecture guidance and updated marketing/onboarding/roadmap copy with resource, network, rendering, and unreleased-version limitations.
- Refined saved link-check results with local Bootstrap brand icons, compact destinations and full-URL evidence, structured source occurrence cards, all-outcome filters, run metadata, non-standard HTTP guidance, and source-page retry states that hide outdated rows.
- Added six read-only Link Checker MCP tools for saved job history/details/statistics, scan companions, filtered destinations, and paginated retained source references; kept the existing six accessibility/settings tools, endpoint/key contract, scoring, and exports unchanged. Documented dashboard-relative link/CSV metadata, no/deleted-companion semantics, historical HTTP limitations, untrusted site evidence, and user prompt/paging recipes.
- Refined all user, operator, and contributor documentation against current behavior; added troubleshooting/FAQ and backup/restore guides, audience-specific reading paths, and clearer operational and MCP limitations.
- Improved docs Markdown rendering, mobile section navigation, search keyboard behavior, and project-path hydration; added complete content/example, internal-anchor, and desktop/mobile route verification.
- Enabled the sidebar release check by default, with `LIME_UPDATE_CHECK=false` as the server opt-out; preserved browser-off/release-dismissal preferences and explicitly disabled checks in the isolated docs/verification stack.
- Corrected release comparison to use the packaged dashboard version when no nonblank build/runtime override is supplied, preventing default development placeholders from announcing false updates.
- Hardened the shared dashboard proxy used by MCP with body/fetch deadlines, cancellation and controlled error handling, and corrected decoded-compression headers; added actual-source transport regressions without changing authentication or scoring rules.
- Validated MCP integer arguments exactly instead of accepting floating-point-rounded fractions, rejected explicit null arguments, and corrected standalone ESM client setup instructions.
- Verified the pinned `mcp-remote` stdio-to-HTTP bridge against the original six accessibility/settings tools with isolated credentials and process/port cleanup checks; documented its runtime and client-host environment requirements. Later tool additions require their own dated verification evidence.
- Added a canonical dashboard `/mcp` proxy with authenticated fresh score enrichment through the existing scorer, dashboard-relative report metadata with availability and screenshot URLs, validated tool schemas/errors, and complete issue-detail pagination.
- Added real v1/v2 SDK-based MCP verification using the legacy 2025 protocol and client-agnostic bearer-key guides for Codex, Claude Code, Cursor, VS Code, and stdio bridges; documented read-only scope, direct-backend cache limitations, legacy audit details, and unsupported OAuth-only connectors.
- Fixed interrupted Chromium startups being persisted as failed pages after pause cancellation; parent-run cancellation now keeps unfinished pages pending for resume, while active-run browser failures and local page timeouts remain genuine failures.
- Fixed issue-detail request cancellation and added visible retry recovery; improved mobile search, drawer navigation, issue actions, viewport icons, and the main landmark without changing spotlight screenshot behavior. Dashboard skip navigation is excluded from printed reports.
- Fixed concurrent scan progress updates that could leave a completed scan's count below its audited page count; MCP initialization now advertises the actual backend build version.
- Fixed omitted issue-read pagination limits so group and occurrence APIs use their documented defaults instead of returning empty pages.
- Fixed issue-group pagination after false-positive changes by refreshing the loaded issue order before fetching later groups.
- Serialized issue-summary cache replacement with a parent scan-row lock and source-timestamp check so concurrent reads cannot create duplicate keys or persist obsolete/deleted scan snapshots.
- Fixed long scan targets overflowing narrow mobile headers while keeping the complete hostname and URL readable.
- Restored the optional release-notice endpoint by escaping the App Router's private-folder prefix, and bounded its best-effort GitHub request to five seconds while preserving browser visibility and release-dismissal preferences.
- Added isolated existing-feature end-to-end verification and a project handoff guide covering ownership, setup, lifecycle, reports, settings, MCP, and reproducible checks.
- Redesigned the public marketing and documentation site to match the dashboard visual system, with responsive Material Symbol navigation, improved documentation reading layouts, and consistent product, API, screenshot, roadmap, and onboarding pages.
- Added the original Link Checker design preview to the public documentation and reproducible screenshot set; the working checker replaces it in the unreleased source above.
- Hardened the docs refresh pipeline with deterministic dependency installs, preflight linting and target validation, automatic isolated-stack cleanup, browser/runtime error checks, screenshot integrity checks, and post-build internal-link and asset validation.

## [1.0.5] - 2026-05-14

- Fixed needs-review-only scans so the scan detail page links to issue details when review-required audit checks exist without failed issue groups.

## [1.0.4] - 2026-05-01

- Fixed Debian/Linux deployment portability by auto-detecting `docker compose` versus `docker-compose`, adding OS-aware Make targets, making native screenshot storage configurable, and hardening the systemd install path.

## [1.0.3] - 2026-04-26

- Improved mobile layout behavior across the public docs site, including homepage cards, API reference cards, docs pages, screenshot gallery, search, and the mobile navigation overlay.
- Removed accidentally tracked temporary scan-repair JSONL exports from the repository.
- Added root ignore rules for temporary files and local logs.

## [1.0.2] - 2026-04-26

- Fixed the GitHub Pages screenshots gallery route by moving committed screenshot assets out of the `/screenshots/` route namespace.
- Updated docs screenshot manifests, inline user-doc screenshots, and `make docs` capture output to use `/product-screenshots/`.

## [1.0.1] - 2026-04-26

- Refined the public docs-site homepage, screenshots page, API page, and roadmap copy for clearer release-facing messaging.
- Added shadcn-style docs navigation refinements, search, source references, and screenshot presentation improvements.
- Added contributor documentation for adding user-facing docs and requesting exact screenshots through `make docs`.
- Updated MCP user and reference docs to describe the current read-only `/mcp` implementation, available tools, bearer-key setup, smoke tests, and current limitations.
- Refreshed docs-demo screenshots, including the partial-scan retry state.

## [1.0.0] - 2026-04-25

Hello OSS.

- Added the static LIME product and documentation site under `docs-site/`, built for GitHub Pages and the `https://lime.heysuman.com/` custom domain.
- Added a polished shadcn-style docs experience with product pages, user guides, developer docs, API reference, screenshot gallery, and LIME dashboard branding.
- Added the GitHub Pages workflow for static docs publishing, separate from the Docker/release workflow.
- Added `make docs` to refresh real product screenshots from an isolated production `lime-docs` Docker Compose stack using fresh demo scans for `heysuman.com`, `fake-university.com`, and `overlaysdontwork.com`.
- Added `make docs-build`, `make docs-run`, and `make docs-dev` for static docs builds, local static serving, and docs hot reload.
- Changed `make start-all` and `make start-ui` to run the production Next standalone build, with `make start-dev` reserved for the Next development server.
- Added PostgreSQL-first performance and cache work for dashboard summaries, scan score summaries, issue pages, and report generation inputs.
- Added large-report improvements including paginated issue details, bounded PDF occurrences, small/full CSV modes, and compact LLM text exports.
- Added same-scan retry support for failed pages in completed partial scans.
- Added report settings for PDF, CSV, and LLM availability plus operator-controlled report limits and performance knobs.
- Added Docker and Fly.io release readiness with GHCR image publishing, changelog-driven release notes, and release bundle generation.
- Added public OSS readiness docs including contribution, security, roadmap, deployment, architecture, and support guidance.
- Added strict host verification in the scan profiling flow to keep scans on the entered host after redirect checks.

## [0.1.0] - 2026-04-23

- Added the Shopkeeper scan pipeline with sitemap profiling, Chromium/axe-core scanning, result refinement, screenshots, and PostgreSQL persistence.
- Added the NextJS scan dashboard with scan progress, issue details, false-positive triage, CSV export, and PDF reports.
- Added same-scan retry support for failed pages in partial scans.
- Added large-report loading improvements for issue pages and report generation.
- Added production deployment support for Docker release bundles and Fly.io.
- Added automated GHCR image publishing and GitHub Release bundle generation from `CHANGELOG.md`.
