# MCP Verification Notes

Internal handoff notes for contributors. Public setup instructions and API contracts remain in [MCP Integration](../mcp.md). See [Testing LIME](../verification.md) for test commands and [verification history](verification-history.md) for dated results.

## Historical Bridge Check

The public MCP guide previously recorded an isolated check of `mcp-remote@0.14.3` using Node 24.18.0. That check read the original six accessibility/settings tools and confirmed the launcher exited and released its callback port. It did not configure an installed desktop client or use OAuth, and it predates the link-check tools. Refer to the dated verification record for the tool set exercised by later runs.

The current bridge regression runs inside `make verify-app` with an isolated fixture key and temporary auth/cache directory, not existing client configuration or normal-instance keys. Pinning the bridge version is not a security audit and does not lock its full dependency tree.

## Evidence Boundaries

Saving client configuration or listing tools does not demonstrate that a model executed a workflow. The read-only SDK smoke test's `checked` list records calls made against the records available; tool discovery on an empty instance is not action coverage. Test write workflows only against an isolated, authorized fixture and compare accepted IDs, terminal state, and exported evidence with independently saved data.

Transport checks, SDK calls, and actual installed-client/model runs are separate evidence. Preserve each run's version, scope, sanitized results, and cleanup outcome in the verification record. Do not infer an integration pass from setup examples or a tool catalog.
