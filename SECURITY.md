# Security Policy

## Supported Versions

Security fixes are expected to target the latest released version of LIME. Until `v1.0`, fixes may land on `main` first and be included in the next release tag.

## Reporting A Vulnerability

Please do not open public GitHub issues for sensitive security reports.

Send a private report to the project maintainer with:

- affected version or commit
- deployment target, such as Docker, Fly.io, or local development
- clear reproduction steps
- logs or screenshots when they help explain impact
- whether the issue requires authenticated dashboard access

If GitHub private vulnerability reporting is enabled for the repository, use that path. Otherwise, contact the maintainer through the repository owner profile.

## Scope

Security-sensitive areas include:

- scan target validation and same-host enforcement
- screenshot serving
- report export routes
- MCP authentication and runtime enablement
- database migrations and backup/restore behavior
- update and release scripts

## Self-Hosted Responsibility

LIME is self-hosted software. Operators are responsible for:

- keeping the deployment updated
- protecting database credentials
- restricting dashboard access where needed
- running behind TLS in production
- configuring firewall and reverse-proxy rules for exposed services
