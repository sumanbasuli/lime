# LIME agent reference

The LIME agent combines a workspace, three skills, and an OpenClaw configuration for working with scans and link checks through MCP. Start with the [user guide](https://lime.heysuman.com/docs/user/agent/) for setup and examples.

## Package structure

| Path | Purpose |
| --- | --- |
| `agent/workspace/` | Instructions for reviewing results, using tools, and reporting findings. |
| `agent/workspace/skills/lime-audit/` | Analyze saved scans, coverage, findings, and link results. |
| `agent/workspace/skills/lime-operations/` | Create and manage scans and link checks, review false positives, and update settings. |
| `agent/workspace/skills/lime-evidence/` | Retrieve reports, screenshots, and link-check CSV files. |
| `agent/openclaw.example.json` | Read-only OpenClaw configuration. |
| `agent/scripts/openclaw-config.mjs` | Generate a separate configuration and copy the workspace. |
| `agent/scripts/request-id.mjs` | Generate a UUID for a new scan, rescan, or link check. |

The skills use the tools available from your LIME instance. The [MCP reference](mcp.md) documents tool arguments, responses, permissions, and export limits.

## Generate an OpenClaw profile

The generator supports OpenClaw 2026.7.1 native HTTP MCP connections and OpenAI models using subscription sign-in. Replace `<your-model>` with a model available to your account.

```bash
node agent/scripts/openclaw-config.mjs \
  --directory "$(pwd -P)/.artifacts/lime-agent-demo" \
  --url "http://localhost:3000/mcp" \
  --model "openai/<your-model>"
```

Use a new, empty directory. The generator creates a private workspace and state directory and prints the environment variables to use with OpenClaw. It saves the selected model and endpoint, while the MCP key is read from `LIME_MCP_KEY`. It refuses to overwrite an existing profile.

For a remote LIME instance, use an HTTPS dashboard URL ending in `/mcp`. Plain HTTP is supported for localhost connections.

The configuration uses OpenClaw's built-in agent runtime. It allows LIME tools and reads within the agent workspace. Shell commands, browser access, messaging, scheduled tasks, and file changes are disabled. Other runtimes or model providers need their own configuration.

## Allow changes

Generate a separate profile with `--allow-writes` to include action tools, then enable **Allow MCP write actions** in LIME's **Settings > Integrations**. The agent follows your instructions for each action and asks before deleting results or changing shared settings.

Write access applies to all clients using the instance's MCP key. The key protects MCP requests; protect remote access to the dashboard and ordinary APIs separately.

For a new scan, standalone link check, rescan, or recheck, generate a request ID:

```bash
node agent/scripts/request-id.mjs
```

Give that ID to the agent with your request. If the connection is interrupted, retain the ID and original arguments while checking whether the job was created. Starting again with a new ID can create a duplicate job.

## Test changes to the package

```bash
npm --prefix agent test
node --test docs-site/scripts/verify-openclaw-agent.test.mjs
```

These tests check configuration, workspace copying, permissions, skill references, and the verifier's checks for test resources and results. The separate live OpenClaw verifier runs an agent session against the disposable LIME test stack and checks saved results and cleanup.

Follow [Testing LIME](verification.md#mcp-and-ai-client-checks) to start the test stack, run the client checks, and remove it afterward. Choose a model your account can use. A provider login or model error must be resolved before testing the agent's LIME tools.

## Maintain the agent

Keep skills aligned with the current MCP schemas. Preserve read-only defaults, request IDs during retries, clear descriptions of incomplete results, and explicit approval for deletion or shared settings changes.

For an upgrade, review the changes and generate a fresh profile. Run a read-only query first, then enable actions if needed. Keep private transcripts and request records out of version control. Dated test results belong in `docs/internal/`, which is excluded from the public site.
