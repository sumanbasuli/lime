# LIME agent and OpenClaw integration

The `agent/` package turns LIME's existing operational MCP contract into a scoped assistant workflow. Its workspace instructions and three skills cover saved accessibility/link analysis, authorized scan/link lifecycle and triage/settings actions, and actual evidence retrieval. It does not introduce another backend, change existing product workflows, or grant access to the audited site's source code.

## Setup and ownership

Start with the [user agent guide](https://lime.heysuman.com/docs/user/agent/) and the [package README](../../agent/README.md). The README provides an independent OpenClaw profile, secret-free example, UUID helper, action opt-in, recovery, and maintenance instructions. Set `OPENCLAW_STATE_DIR` and `OPENCLAW_CONFIG_PATH` before diagnostics as well as model turns; no live gateway/channel configuration is imported or replaced.

The hardened demo targets OpenClaw 2026.7.1's native Streamable HTTP MCP configuration and explicitly pins its embedded `openclaw` harness with an `openai/<model>` provider. The installed test machine uses existing Codex sign-in; this is not a test of the separate Codex app-server harness. Portable `SKILL.md` workflows are client-neutral, but the OpenClaw tool names (`lime__*`), environment substitution, plugin/runtime policy, and profile controls are not universal MCP configuration. CLI-backed models are deliberately rejected by the generator because native host tools are not necessarily governed by the OpenClaw allowlist.

The top-level `auth.profiles`/`auth.order` metadata selects the `openai:default` OAuth profile without storing credentials. It is required to route the pinned embedded harness through the subscription-backed transport rather than looking for a Platform API key. This provider login is distinct from LIME MCP's static bearer key. Generated profiles freeze the validated model/runtime, endpoint, and private workspace paths; only the MCP key remains an environment placeholder.

| Area | Source and responsibility |
| --- | --- |
| Agent context | `agent/workspace/AGENTS.md`, `SOUL.md`, `TOOLS.md`, `USER.md`, `IDENTITY.md`, `HEARTBEAT.md`. |
| Workflow skills | `agent/workspace/skills/`: audit, operations, evidence, with conditional references. |
| Demo generation | `agent/openclaw.example.json`, `agent/scripts/openclaw-config.mjs`: private copied workspace, read-only defaults, exact action opt-in, no key/config/auth import. |
| UUID generation | `agent/scripts/request-id.mjs`: operator-side fresh IDs; no agent shell permission. |
| Package checks | `agent/tests/`: configuration, endpoint, overwrite, filesystem, and policy regression checks. |
| Real-client verification | `docs-site/scripts/verify-openclaw-agent.mjs`: actual local agent turns, native MCP metadata trace, durable independent reads, and owned cleanup. |

LIME's [MCP protocol reference](../mcp.md) owns tool semantics, artifact limits, request reservations, permission behavior, and server deadlines. Skills should route to the actual schemas/capabilities rather than drift into a second static API implementation.

## Reproduce verification safely

Install the existing docs-site verification dependencies first. The explicit project/database/ports isolate tests from normal LIME and WordPress. Do not run `make clean`, stop all containers, or point this test at a production endpoint.

```bash
npm --prefix agent test
npm --prefix docs-site ci
export LIME_DOCS_DB_PASSWORD="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')"
LIME_DOCS_DB_PORT=16432 LIME_DOCS_API_PORT=19080 LIME_DOCS_UI_PORT=14000 \
  docker compose -p lime-verification -f docker-compose.docs.yml up -d --build --wait
npm --prefix agent run verify:openclaw -- --model openai/gpt-5.6-sol
LIME_DOCS_DB_PORT=16432 LIME_DOCS_API_PORT=19080 LIME_DOCS_UI_PORT=14000 \
  docker compose -p lime-verification -f docker-compose.docs.yml down --volumes
unset LIME_DOCS_DB_PASSWORD
```

The last Compose command removes **only disposable test containers and volumes**. Run it even if the verifier fails, after ensuring no agent turn remains active. The database password is unique to this test stack; a retained volume still requires the password used when it was created. The verifier checks the disposable database identity before key/settings changes, uses temporary OpenClaw configuration/state/workspace, and does not deliver messages. Provider/model access is required and may consume account usage; login/catalog success alone cannot satisfy the runtime gate.

## Acceptance and evidence

A passing release gate requires package/skill validation, an actual OpenClaw read-only model workflow, authorized write workflow with accepted IDs and terminal/coverage reads, actual exported evidence, reversible scoped triage, no unrequested mutation from captured instructions, independently verified persisted data, and owned-record/profile cleanup. Record which tools actually ran; the 29-tool source contract is not a claim that every model chose every tool. Use the existing full-MCP SDK/product suite for complete tool and lifecycle regression coverage.

The metadata trace must omit authorization/config secrets. Keep raw artifacts and private account state outside version control. On model/provider failure, preserve the failure stage and sanitized evidence, repair that boundary, and rerun; do not label a catalog-only handshake as production-ready. Configuration/skill checks, live model tests, prior SDK coverage, and untested deployment environments must remain separate.

## Ongoing operation

Default read-only access, bounded pagination/polling, exact scoped human authority, and untrusted evidence handling belong in every workflow. Client permissions do not create server-side tenant isolation. Private task state must retain request IDs/arguments to reconcile uncertain writes; never create replacement jobs as a timeout workaround. Shared reporting/performance changes require specific approval and readback; key administration and write enablement remain dashboard-only.

Review the installed runtime/version before upgrades, because native harness defaults can change independently of LIME. Generate a fresh independent profile, verify reads first, then opt in to writes deliberately. No periodic scans, channel routing, gateway service, agent spawning, installation, deployment, or automatic cleanup is enabled by this package.

## Verified local baseline on October 6 2026

The final isolated OpenClaw run passed at `2026-10-06T07:04:08.495Z` using OpenClaw `2026.7.1 (2d2ddc4)`, `openai/gpt-5.6-sol`, and the explicitly selected embedded `openclaw` harness. The metadata trace recorded **43 successful model MCP calls across 19 tools**: 16 reads plus `create_scan`, `mark_issue_false_positive`, and `create_link_check`. Independent SDK verification/cleanup calls are excluded from that count. The actual model saw exactly 17 read tools in the read-only profile and 29 in the explicitly enabled operations profile; all three skill entrypoints and relevant workflow references were read.

| Boundary | Result |
| --- | --- |
| Read-only analysis | Real capability/statistics/history reads; no action calls or permission/key workaround. |
| Authorized accessibility scan | One stored Single-page Mobile scan with the requested tag and companion; the model observed completed saved states and coverage. |
| Actual evidence | LLM report 3,555 bytes, saved link CSV 1,284 bytes, screenshot 36,016 bytes; metadata-only responses did not count as artifact success. |
| Reversible triage | Exactly the authorized issue marked true, then restored false; independent SDK readback confirmed the restored state. |
| Standalone links | One stored standalone single-page check, terminal-state observation, known HTTP 404, source references, and actual CSV. |
| Captured-content boundary | Malicious fixture labels actually returned in eight model reads/exports; no unauthorized mutation, secret disclosure, shell, browser, ordinary HTTP, or channel-tool calls. |
| Runtime and skills | Exact provider/model/harness and 17/29 model catalogs; only allowed tools and private-workspace reads; all three skills used. |
| Cleanup | Three owned jobs deleted and absence verified, disposable permission mode restored, private OpenClaw profiles removed, global configuration fingerprints unchanged. |

Evidence is retained locally under `.artifacts/verification/openclaw-agent-final-v2/`, principally `openclaw-agent-results.json` and the four sanitized model responses. An earlier implicit-runtime pass is under `openclaw-agent/`; the intervening explicitly pinned candidate failed at authentication before any job/action. That failure showed that the embedded harness also needs explicit `openai:default` OAuth metadata to select the subscription transport. The final profile fixes that route; neither the failed candidate nor a catalog-only handshake is counted as the final passing baseline.

Nine package tests, seven verifier guard tests, three skill validators, and seven independent instruction/recovery scenarios passed. Website validation covered 39 guides, 95 shell/JSON examples, and 47 exported HTML pages; desktop/mobile checks covered 44 routes and 88 checks, including both agent guides without overflow or browser errors. These results do not claim every model executed all 29 tools, a Codex app-server/CLI-backed harness was tested, or remote/multi-tenant deployments are secured by an MCP key. Full operational tool coverage belongs to the separate MCP regression suite.

That full-MCP suite was rerun against the same disposable stack after the agent test and passed at `2026-10-06T07:08:03.673Z`: **20 phases with both SDK versions**, 17 read tools and all 12 action tools, with no failed phases or browser errors. Coverage included concurrent request replay, scan companions, reversible triage/scoring, real PDF/CSV/LLM/screenshot content, settings persistence and report gates, pause/resume/retry, durable replay after a backend restart, rescan/recheck/cancel, strict validation, live permission revocation, and confirmed deletion of saved evidence without replay recreating jobs. Its separate evidence is `.artifacts/verification/agent-mcp-contract/focused-results.json`; these SDK calls are not included in the 43 model-call count.
