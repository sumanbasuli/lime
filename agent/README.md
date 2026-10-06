# LIME agent for OpenClaw

Use the LIME agent to review accessibility findings, check links, and manage scans from OpenClaw. The package includes a workspace, three skills, and a configuration generator. It connects to your LIME instance through MCP and starts with read-only access.

## Contents

| Path | Purpose |
| --- | --- |
| `workspace/AGENTS.md` | Instructions for using tools, recovering requests, and explaining results. |
| `workspace/skills/lime-audit/` | Review saved scans, findings, coverage, and links. |
| `workspace/skills/lime-operations/` | Manage scans and link checks, mark false positives, and update settings. |
| `workspace/skills/lime-evidence/` | Retrieve reports, screenshots, and link CSV files. |
| `openclaw.example.json` | Example OpenClaw configuration. |
| `scripts/openclaw-config.mjs` | Generate a separate private profile and copy the workspace. |
| `scripts/request-id.mjs` | Generate a UUID for a new scan, link check, rescan, or recheck. |

The skills cover LIME's 17 read tools and 12 optional action tools. The agent can review and manage LIME results; fixes to the scanned website still need to be made in that site's code.

## Prerequisites

- LIME 2.0 running at an address OpenClaw can reach.
- MCP enabled in **Settings > Integrations**, with your MCP key ready. LIME shows newly generated keys only once.
- OpenClaw 2026.7.1 with native MCP support and a compatible Node.js version.
- An OpenAI subscription model available to your account. The included configuration uses OpenClaw's built-in agent and OpenAI sign-in.

Other MCP clients can use the skills with their own connection and tool settings. Use the generator to configure your chosen model in OpenClaw; switching to another runtime or provider needs its own configuration.

## Connect OpenClaw

Run from your LIME checkout in Bash or Zsh. Replace `openai/<your-model>` with a model available in OpenClaw. For a remote instance, use its HTTPS dashboard address followed by `/mcp`. The key prompt hides your input.

```bash
export LIME_AGENT_PROFILE="$(pwd -P)/.artifacts/lime-agent-demo"
export LIME_MCP_URL="http://localhost:3000/mcp"
export LIME_AGENT_MODEL="openai/<your-model>"

node agent/scripts/openclaw-config.mjs \
  --directory "$LIME_AGENT_PROFILE" \
  --url "$LIME_MCP_URL" \
  --model "$LIME_AGENT_MODEL"

export OPENCLAW_STATE_DIR="$LIME_AGENT_PROFILE/state"
export OPENCLAW_CONFIG_PATH="$LIME_AGENT_PROFILE/openclaw.json"
export LIME_AGENT_WORKSPACE="$LIME_AGENT_PROFILE/workspace"
printf 'LIME MCP key: '
read -r -s LIME_MCP_KEY
printf '\n'
export LIME_MCP_KEY

openclaw config validate
openclaw skills list
openclaw mcp doctor lime --probe
openclaw agent --local --agent lime --json --timeout 180 \
  --message "Summarize my recent LIME scans and link checks. Highlight incomplete scans and the issues I should review first."
```

Use an empty directory for each profile. The generator saves the model, endpoint, and workspace paths and reads the key from your environment. It refuses existing files or symbolic links. On macOS, use `/private/tmp` if creating a temporary profile because `/tmp` is a symbolic link. The generated `.gitignore` helps keep private state out of version control.

Keep using the same terminal so OpenClaw can find the profile and key. `--local` runs a single agent session. Close the terminal when finished, or unset the demo variables before using another profile.

If OpenClaw asks you to sign in, run `openclaw models auth login --provider openai --profile-id openai:default` in the same terminal, then retry the agent command. Check that the response refers to results you can find in your LIME dashboard.

## Enable actions

To let the agent make changes, enable actions in both the OpenClaw profile and LIME settings, then tell it what you want to do.

Create a new profile with `--allow-writes`, then enable **Allow MCP write actions** under LIME's **Settings > Integrations** and save. This LIME permission applies to all clients using the instance's MCP key.

```bash
export LIME_AGENT_PROFILE="$(pwd -P)/.artifacts/lime-agent-operations"
node agent/scripts/openclaw-config.mjs \
  --directory "$LIME_AGENT_PROFILE" \
  --url "$LIME_MCP_URL" --model "$LIME_AGENT_MODEL" --allow-writes
export OPENCLAW_STATE_DIR="$LIME_AGENT_PROFILE/state"
export OPENCLAW_CONFIG_PATH="$LIME_AGENT_PROFILE/openclaw.json"
export LIME_AGENT_WORKSPACE="$LIME_AGENT_PROFILE/workspace"
node agent/scripts/request-id.mjs
```

Include the generated UUID in your request, for example: “Scan https://example.com on Mobile and include a link check. Use request ID `<fresh UUID>`. When both checks finish, summarize the results and get the text report.” Generate a separate ID for each new job.

If a request times out, keep its ID and original arguments while the agent checks whether the job was created. Starting again with a new ID can create a duplicate. Check saved settings and job state before retrying other interrupted changes.

If the new profile needs a sign-in, repeat the login command in the same terminal. The agent asks before deleting results or changing shared settings. Tell it exactly which records or settings to change.

## Working with results

Review coverage and needs-review findings alongside the score. Reports describe saved scan results, and screenshots show the page as it looked during the scan. MCP file transfers are limited to 4 MiB; download larger reports from the dashboard.

The profile allows LIME tools and reads within its workspace. Shell commands, browser access, messaging, scheduled tasks, and file changes are disabled. Keep your profile and conversation history private because they can contain scanned URLs, page content, and reports.

For remote LIME access, use HTTPS and protect the dashboard with your usual access controls. The MCP key only protects MCP requests. If you rotate the key, update every connected client.

## Test and maintain

Run `npm --prefix agent test` for package checks. For a live OpenClaw test, follow [Testing LIME](../docs/verification.md#mcp-and-ai-client-checks) to start the disposable stack, run the verifier, and clean up afterward.

When upgrading, review the changes and generate a fresh profile. Try a read-only request first, then enable actions if needed. Keep private request records and transcripts out of version control.

Before removing a profile, check whether it has any unfinished scans or link checks. Deleting local profile files does not remove jobs or results from LIME.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| 401 response | MCP must be enabled and the key must match LIME's current key. |
| Action tools missing | Check both `--allow-writes` in the profile and **Allow MCP write actions** in LIME Settings. |
| Connection fails | Use the dashboard `/mcp` URL and Streamable HTTP. A browser GET may return 405. |
| Unknown configuration field | Check that your OpenClaw version supports the example configuration. |
| Model or sign-in error | Check your OpenClaw account and model selection. A new profile may need a new sign-in. |
| Request times out | Keep the original request ID and check saved state before retrying. |

Further reading: [OpenClaw MCP](https://docs.openclaw.ai/tools/mcp), [OpenClaw skills](https://docs.openclaw.ai/tools/skills-config), [LIME MCP integration](../docs/mcp.md), and [agent reference](../docs/agent.md).
