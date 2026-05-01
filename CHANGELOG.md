# Changelog

All notable changes to LIME are tracked here. The release workflow uses the
section matching `VERSION` to populate GitHub Release notes.

## [Unreleased]

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
