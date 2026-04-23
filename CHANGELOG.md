# Changelog

All notable changes to LIME are tracked here. The release workflow uses the
section matching `VERSION` to populate GitHub Release notes.

## [0.1.0] - 2026-04-23

- Added the Shopkeeper scan pipeline with sitemap profiling, Chromium/axe-core scanning, result refinement, screenshots, and PostgreSQL persistence.
- Added the NextJS scan dashboard with scan progress, issue details, false-positive triage, CSV export, and PDF reports.
- Added same-scan retry support for failed pages in partial scans.
- Added large-report loading improvements for issue pages and report generation.
- Added production deployment support for Docker release bundles and Fly.io.
- Added automated GHCR image publishing and GitHub Release bundle generation from `CHANGELOG.md`.
