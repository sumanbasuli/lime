# Security Policy

## Supported Versions

Security fixes target the current maintained version of LIME. A fix in the repository is not available to installed users until it is included in a release; check the release notes before assuming an installation contains it.

## Reporting A Vulnerability

Please do not open public GitHub issues for sensitive security reports.

Send a private report to the project maintainer with:

- affected version or commit
- deployment target, such as Docker, Debian systemd, or local development
- clear reproduction steps
- logs or screenshots when they help explain impact
- whether the issue requires reaching the dashboard or ordinary API, and whether external access controls apply

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
- restricting dashboard and ordinary API access; source and release Compose publish their ports on host interfaces by default, and neither route has built-in login (the MCP key protects only MCP)
- running behind TLS in production
- configuring firewall and reverse-proxy rules for exposed services
- listing each public dashboard or API DNS name in `LIME_ALLOWED_HOSTS` on the receiving service; LIME rejects other DNS names, while localhost and literal IP access still need network controls
- limiting who can submit private scan targets and isolating the scanner from sensitive internal services; a trusted private host on a standard HTTP or HTTPS port can also receive requests on the paired standard port
- treating submitted pages as untrusted: Chromium's sandbox is required, and Shopkeeper runs as a non-root user with no process capabilities; use the current Compose policy and complete the documented one-time upgrade, allow scan submissions only from trusted operators, and isolate the backend from unrelated workloads and sensitive networks
- avoiding credentials in scan and link-check URLs; LIME hides URL userinfo, queries, and fragments in public URL fields, but keeps exact targets in its database and backups for execution and rechecks. Captured page content and screenshots can also contain sensitive data.
