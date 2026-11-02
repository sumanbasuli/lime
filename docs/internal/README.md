# Internal engineering notes

This directory holds dated test results, local environment details, and contributor handoff records. The documentation build excludes it from website pages and search.

- [Verification history](verification-history.md): product, MCP, installer, and website test records.
- [v2 main-project verification — November 2, 2026](v2-main-project-verification-2026-11-02.md): retained-data upgrade, usability corrections, API, database, browser, and MCP release checks.
- [Agent verification](agent-verification.md): OpenClaw setup decisions and recorded agent runs.
- [MCP verification notes](mcp-verification.md): bridge checks and how to interpret client test results.
- [Security hardening handoff — October 7, 2026](security-hardening-2026-10-07.md): audit disposition, completed checks, deployment gaps, and policy decisions.
- [Runtime security updates — October 23, 2026](runtime-security-updates-2026-10-23.md): patched runtime/dependency versions, native build lock enforcement, nginx verification, and remaining update gaps.
- [Chromium sandbox — October 26, 2026](chromium-sandbox-2026-10-26.md): required sandbox, legacy screenshot ownership, one-time upgrade, Docker/native checks, and remaining deployment limits.
- [Durable sitemap discovery checkpoint design](sitemap-discovery-checkpoint-plan.md): migration `000020`, cumulative budgets, pause/restart behavior, and acceptance criteria for the implemented checkpointed discovery flow.

Public guides should explain what users can do, how to do it, and the limits that affect their work. Keep machine-specific model names, test transcripts, candidate failures, and local artifact inventories here. Preserve technical details needed for setup and troubleshooting in the relevant public reference, using direct language and concrete steps.

## Release publishing check

Run `bash scripts/verify-release-image-tags.sh` from the repository root after changing release publishing. It creates a disposable bare Git remote, records the publisher's make/Docker calls, and runs the archived Makefile against a fake Docker. The check covers first publication with an annotated tag claim, same-commit reruns with annotated and lightweight tags, divergent tags, concurrent tag claims, remote lookup and claim failures, dirty tracked and untracked Docker-context files, and offline `PUSH_IMAGES=false` builds. It also verifies that both pushed images receive a temporary archive of the claimed commit, their Makefile recipes and version/commit build arguments come from that commit, exported local build flags cannot override `--pull`, ignored nested files are absent, and the archive is removed afterward. No registry or external Git host is contacted. A failed image publish may leave a tag that can be retried from the same commit; no-push builds continue to use the local checkout context.
