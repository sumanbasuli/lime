export interface ProductDoc {
  slug: string[];
  title: string;
  description: string;
  category: "User Docs" | "Developer Docs" | "API";
  screenshots?: string[];
  sourceFiles?: string[];
  markdown: string;
}

export const productDocs: ProductDoc[] = [
  {
    slug: [],
    title: "LIME Documentation",
    description: "Use, operate, extend, and integrate with LIME.",
    category: "User Docs",
    screenshots: ["dashboard", "issues", "reports", "link-checker"],
    markdown: `# LIME Documentation

LIME is a self-hosted accessibility scanner for teams that need reviewable results. It runs axe-core in Chromium, captures screenshots, groups failures and needs-review checks, and exports PDF, CSV, and LLM-ready reports.

## What you can do here

- Learn how to create scans, read score and coverage, and triage issue groups.
- Understand same-scan failed-page retry for partial scans.
- Export PDF, CSV, and LLM reports without blocking large issue pages.
- Configure server-wide reporting and performance settings.
- Preview the Link Checker workflow and understand its current non-scanning state.
- Find contributor docs for the backend, dashboard, docs site, and release process.

## Docs structure

User docs explain the product workflow from first scan to report export. Developer docs explain the codebase, contribution process, architecture, and release pipeline. API docs document the HTTP surface exposed by Shopkeeper and the dashboard proxy routes.
`,
  },
  {
    slug: ["user"],
    title: "User Docs",
    description: "Operate LIME from first scan through triage, exports, partial retry, and settings.",
    category: "User Docs",
    screenshots: ["dashboard", "scan-detail", "issues", "reports", "link-checker"],
    sourceFiles: ["docs-site/content/product-docs.ts"],
    markdown: `# User Docs

Use these docs when you are running audits, reviewing scan evidence, or exporting reports for remediation work. The pages are ordered like the product workflow: create a scan, monitor it, review issues, retry partial failures, export reports, and tune server settings.

## Recommended path

1. Start with [Create Your First Scan](/docs/user/first-scan/) to understand sitemap and single-page scans.
2. Use [Dashboard And Scan List](/docs/user/dashboard/) to read status, score, coverage, and scan actions.
3. Open [Scan Detail And Partial Retry](/docs/user/scan-detail/) when a scan is running, partial, or ready for failed-page retry.
4. Review [Issues And Screenshots](/docs/user/issues/) to triage failures and needs-review items.
5. Use [Export Reports](/docs/user/reports/) when you need PDF, CSV, or LLM-ready output.
6. Adjust [Settings](/docs/user/settings/) for report limits, feature toggles, and performance defaults.
7. Review [Link Checker Preview](/docs/user/link-checker/) to see the planned link-validation workflow.
8. Read [MCP For AI Tools](/docs/user/mcp/) when preparing to connect external AI clients to LIME.

## What matters operationally

- Treat score and coverage together. A partial scan score is not final until failed pages are retried or accepted.
- Use same-scan failed-page retry before starting a full rescan.
- Expand issue groups only when you need occurrence detail; large reports load progressively.
- Use small CSV or LLM exports when full occurrence data would produce files too large for normal tools.
- Keep screenshots and source references in reports so findings remain actionable.
- Treat MCP as a read-only integration surface for AI tools, not as a replacement for the dashboard workflow.
`,
  },
  {
    slug: ["user", "first-scan"],
    title: "Create Your First Scan",
    description: "Create sitemap and single-page scans and understand what happens next.",
    category: "User Docs",
    screenshots: ["new-scan", "dashboard"],
    sourceFiles: ["lime/src/app/scans/new/page.tsx", "lime/src/lib/api.ts"],
    markdown: `# Create Your First Scan

Use **New Scan** when you want LIME to audit a sitemap, sitemap index, or one specific page. A scan creates one durable scan record. Every URL, issue, screenshot, score, and export remains attached to that scan ID.

![New scan form](/product-screenshots/new-scan.png "Start a scan from the New Scan page. The form captures the target URL, scan mode, and optional label.")

## Before you start

1. Make sure the target URL is public or reachable from the server running Shopkeeper.
2. Use a sitemap URL when you want broad site coverage.
3. Use a page URL when you want to verify one page or reproduce one issue quickly.
4. Add a label or tag when you need to identify the environment, project, or release later.

## Create the scan

1. Open **Scans** from the dashboard sidebar.
2. Select **New Scan**.
3. Paste the sitemap URL or page URL.
4. Choose the scan mode that matches the target.
5. Choose **Screen size**: Desktop (1440×900), Laptop (1280×800), Tablet (768×1024), or Mobile (390×844). Desktop is the default.
6. Add the optional label, then submit the form.
7. Stay on the scan detail page if you want to watch progress, or return to the dashboard later. The scan continues when you leave the page.

The chosen screen size is stored with the scan and reused for every page, retries, and rescans. Use the Mobile preset to audit the site's mobile layout; resizing your dashboard browser does not change the audit viewport.

## What LIME does next

1. Shopkeeper creates the scan row and records the submitted target.
2. Profiler expands and validates eligible URLs for sitemap scans.
3. Browser workers visit eligible pages and run axe-core.
4. Screenshots, selectors, HTML snippets, failed checks, and needs-review checks are persisted.
5. Sweetner groups raw audit output into issue groups and occurrence rows.
6. Score and report data become available as pages complete.

## If the target redirects

LIME verifies collected URLs against the entered host before scanning. Off-host URLs are filtered out so a redirect or external link does not silently turn one scan into a scan of another domain.
`,
  },
  {
    slug: ["user", "dashboard"],
    title: "Dashboard And Scan List",
    description: "Read recent scans, progress, status, scores, and available actions.",
    category: "User Docs",
    screenshots: ["dashboard"],
    sourceFiles: ["lime/src/app/page.tsx", "lime/src/app/scans/page.tsx"],
    markdown: `# Dashboard And Scan List

The dashboard is the operational view for all scans. Use it to find recent work, confirm whether a scan is still running, open issue details, and start follow-up actions.

![Dashboard scan list](/product-screenshots/dashboard.png "The dashboard shows scan targets, status, labels, score summaries, and actions.")

## Read a scan row

1. Check the target URL first. This tells you what host the scan belongs to.
2. Check the status. Running scans are still changing; completed scans are ready for review.
3. Check page coverage. A score is only meaningful when enough pages completed.
4. Open the scan detail page for lifecycle and URL-level progress.
5. Open **Issues** when you are ready to triage grouped findings.

## Find a scan

Use the header search to match a target URL, label, status, or scan type. The scan list also offers label filters; you can combine a filter with search. The Overview shows recent scans and active progress, while **Scans** shows the full list.

## Statuses

- **Pending** means the scan has been created or reopened and is waiting for work.
- **Profiling** means LIME is discovering eligible URLs from the sitemap.
- **Scanning** means Shopkeeper is actively processing pending URLs.
- **Processing** means completed browser results are being grouped and stored.
- **Paused** means the scan was stopped cooperatively and can be resumed.
- **Completed** means at least one page completed and the run has finished.
- **Partial** is a coverage indicator for a completed scan with both completed and failed URLs; it is not a separate stored lifecycle status.
- **Failed** means no useful page coverage was produced.

## How to use score and coverage

1. Treat score and coverage as a pair.
2. Do not treat a partial scan score as final when failed pages remain.
3. Retry failed pages from the scan detail page before exporting the final report.
4. Use labels to compare the same site across release candidates, environments, or remediation passes.
`,
  },
  {
    slug: ["user", "link-checker"],
    title: "Link Checker Preview",
    description: "Understand the redesigned link-check workflow and what is available before backend checks ship.",
    category: "User Docs",
    screenshots: ["link-checker"],
    sourceFiles: ["lime/src/app/links/page.tsx", "lime/src/components/link-checker-preview.tsx"],
    markdown: `# Link Checker Preview

The **Link checker** screen is part of the redesigned dashboard. It establishes the interaction, result states, and visual language for validating links without changing the current scanning backend.

![Link checker preview](/product-screenshots/link-checker.png "The preview includes the target URL field, run action, and the result layout planned for link validation.")

## Current availability

- The page and navigation entry are available in the dashboard.
- URL entry and the preview interaction are available for design review.
- The page does not crawl or validate links yet.
- No link-check result is stored in PostgreSQL or included in scan reports.

## Planned workflow

1. Open **Link checker** from the dashboard sidebar.
2. Enter a fully qualified site or page URL.
3. Start the link check.
4. Review totals for healthy, redirected, and broken links.
5. Filter and export the result once backend support is added.

## Why the preview is documented

Calling out the preview state keeps operators from treating the screen as a completed scan feature. When the backend is implemented, update this page, the API manifest, screenshot assertions, and release notes together.
`,
  },
  {
    slug: ["user", "scan-detail"],
    title: "Scan Detail And Partial Retry",
    description: "Understand score, coverage, URL audits, and in-place retry for failed pages.",
    category: "User Docs",
    screenshots: ["scan-detail", "partial-retry"],
    sourceFiles: ["lime/src/app/scans/[id]/page.tsx", "shopkeeper/internal/handler/handler.go"],
    markdown: `# Scan Detail And Partial Retry

The scan detail page is the source of truth for one scan ID. It shows lifecycle, score, coverage, severity breakdown, URL status, and scan-level actions.

![Scan detail page](/product-screenshots/scan-detail.png "The scan detail page combines score, coverage, lifecycle, failed URL counts, and report entry points.")

## Review progress

1. Open a scan from the dashboard.
2. Confirm the target and scan ID.
3. Read the completed, pending, and failed URL counts.
4. Review the score summary only after enough URLs have completed.
5. Use the URL table to identify whether failures are isolated or widespread.

## Same-scan failed-page retry

When a completed scan is partial, LIME can retry only the failed pages inside the existing scan. This avoids running a full scan from the start and keeps the same scan ID, completed URL rows, audit evidence, and issue grouping. The score and report update as newly successful pages are added.

![Partial scan retry area](/product-screenshots/partial-retry.png?v=retry-card "Partial scans show an in-place retry area at the top of the scan detail page.")

## Retry failed pages

1. Wait until the scan is completed and marked partial.
2. Use **Retry failed pages** from the top retry area.
3. LIME reopens the same scan and resets only failed URLs to pending.
4. The progress view resumes from the previous completed count.
5. Newly successful pages merge into the existing report.
6. Pages that fail again return to failed status.

## Full rescan versus retry

Use **Retry failed pages** when the scan is partial and you want the current report to become more complete. Use **Full rescan** only when you intentionally want a new scan record for comparison.

## Pause and resume

1. Select **Pause** on an active scan.
2. Wait for **Pausing...** to become **Paused**. Pages already in flight may finish before the pause is saved.
3. Select **Resume** when you want to continue pending pages.
4. LIME keeps the same scan ID, screen size, completed pages, and saved findings. A paused scan stays paused if the backend restarts.

Closing the browser or changing pages does not pause a scan.

## Rescan or delete

Completed and failed scans offer **Rescan** (or **Full rescan** for partial coverage), which creates a new scan using the same target, type, screen size, and label. The original result remains available for comparison.

**Delete** is available for completed, paused, and failed scans. Confirming it removes that scan's results and screenshot files. Resume a paused scan to continue its existing work; do not use deletion as a pause control.
`,
  },
  {
    slug: ["user", "issues"],
    title: "Review Issues And Screenshots",
    description: "Work through failed and needs-review issue groups without loading huge reports at once.",
    category: "User Docs",
    screenshots: ["issues", "expanded-issue"],
    sourceFiles: ["lime/src/app/scans/[id]/issues/page.tsx", "lime/src/components/issue-details-feed.tsx"],
    markdown: `# Review Issues And Screenshots

The issue page groups audit results by rule. It loads the issue list first and loads occurrence details only when you expand an issue, so large scans do not block the initial page load.

![Issue details page](/product-screenshots/issues.png "The issues page lists failed and needs-review issue groups without loading every occurrence immediately.")

## Triage issue groups

1. Open **Issues** from a scan.
2. Start with critical and serious failures.
3. Check the occurrence count before expanding a group.
4. Expand one issue group when you need selectors, HTML, screenshots, and affected URLs.
5. Use issue-specific exports when one issue group is large enough to review separately.

## Expand an issue

![Expanded issue details](/product-screenshots/expanded-issue.png "Expanded issue details include occurrence URLs, selector, HTML context, guidance, and screenshots.")

When you expand a card, LIME loads the details for that issue group. The expanded view includes affected URLs, CSS selectors, HTML snippets, screenshot evidence, ACT guidance where available, and occurrence paging.

## Inspect screenshot evidence

The small image is a focused preview. Select it to open the larger highlighted screenshot in a lightbox, then use **Close** or Escape to return to the issue. If a focused capture is unavailable, an on-demand page capture may be offered as a fallback. The preview and expanded view use the same saved capture; changing the surrounding design should not change the yellow highlight or screenshot behavior.

## Needs-review checks

Needs-review items are included in the UI and reports. These are axe incomplete outcomes that need human judgment instead of automatic failure. Review them alongside failures when you are preparing an accessibility remediation backlog.

LIME groups findings by rule. If a rule already has a failed issue group in the scan, it is shown there rather than duplicated as a needs-review card. Its raw incomplete audit data stays saved. Rules with only incomplete outcomes appear as needs-review groups; reports and MCP follow the same grouping.

## Mark false positives

1. Expand or inspect the issue group enough to confirm the finding.
2. Use **Mark false positive** only when the issue should be excluded from scoring.
3. LIME keeps the issue visible for audit history.
4. Score summaries update after the false-positive state changes.

The Overview's open-issue counts exclude marked issues, and excluded groups remain visible after active failures and needs-review checks. Use **Unmark false positive** to include a marked finding again.

Each scan saves its own triage state. A new scan with the same target URL, scan type, and screen size inherits the latest completed, paused, or failed scan's mark or unmark decision for each matching rule. This also applies to **Rescan**. Changing the original scan later does not change a rescan that already saved its inherited state.
`,
  },
  {
    slug: ["user", "reports"],
    title: "Export Reports",
    description: "Download full reports, small reports, issue-specific reports, and LLM-ready text.",
    category: "User Docs",
    screenshots: ["reports"],
    sourceFiles: ["lime/src/components/issue-report-download-button.tsx", "lime/src/lib/issues-report-data.ts"],
    markdown: `# Export Reports

LIME supports scan-level and issue-level exports. Use scan-level reports for audit review and use issue-level reports when one rule needs focused remediation.

![Report download controls](/product-screenshots/reports.png "The issue page exposes PDF, CSV, and LLM report downloads, including full and small CSV choices.")

## Choose a format

- **PDF** is for audit review. It includes issue summaries, affected URLs, screenshots, and bounded occurrence detail.
- **Small CSV** includes every issue but limits the number of occurrences per issue. Use this when spreadsheet size matters.
- **Full CSV** includes every listed occurrence and can become very large on big scans.
- **LLM text** is a compact structured export for AI-assisted review and remediation planning.

## Download a scan-level report

1. Open the issue page for a completed scan.
2. Choose the report format near the top of the page.
3. For CSV, choose **Small report** unless you explicitly need every occurrence.
4. Keep the page open while a PDF is being prepared; LIME shows generation state for issue-specific PDFs.

## Download an issue-specific report

1. Find the issue group you want to share or remediate.
2. Use the download icon on that issue card.
3. Choose PDF, CSV, or LLM text for only that issue.
4. Use issue-specific CSV when a single issue has thousands of occurrences.

## Report limits

Server settings cap full PDF and issue-specific PDF occurrence detail so reports remain usable. CSV remains the source of truth when you need complete occurrence data.
`,
  },
  {
    slug: ["user", "settings"],
    title: "Settings",
    description: "Tune reporting, performance, and integration settings for your server.",
    category: "User Docs",
    screenshots: ["settings"],
    sourceFiles: ["lime/src/app/settings/page.tsx", "lime/src/components/dashboard-settings-form.tsx"],
    markdown: `# Settings

The settings page controls server-wide reporting, performance, and integration preferences. These settings apply to every user of the deployed instance. The **Update notice** switch is the exception: it is a preference for this browser only.

![Settings page](/product-screenshots/settings.png "Settings are grouped into reporting, performance, and integration sections.")

## Reporting settings

1. Enable or disable PDF generation.
2. Enable or disable CSV generation.
3. Enable or disable LLM text generation.
4. Set the maximum occurrence detail included in full scan PDFs.
5. Set the maximum occurrence detail included in issue-specific PDFs.
6. Set the occurrence limit used by small CSV exports.

## Performance settings

1. Tune summary cache TTL when dashboard and scan summary reads are frequent.
2. Tune report-data cache TTL when repeated exports are common.
3. Set the report-generation concurrency cap based on server CPU and memory.
4. Keep conservative defaults on small servers and increase only after profiling.

Select **Save settings** and wait for its confirmation. Reload the page to confirm persisted values. Disabling a report format also disables its download action and makes its API reject export requests.

## Integration settings

Integration settings include the read-only MCP controls used to connect external AI tools. MCP setup is documented in [MCP For AI Tools](/docs/user/mcp/).

## Browser update notice

The **Update notice** switch defaults to on, takes effect immediately, and survives reload in this browser; it does not require **Save settings** and does not change PostgreSQL settings. The server's best-effort GitHub release check is also enabled by default. A card appears only when a newer release is available and neither server checks nor this browser's display preference are disabled. Operators can set \`LIME_UPDATE_CHECK=false\` on the UI service to stop outbound checks. Turning off only this browser's card does not disable the server's outbound check; existing off/dismissal preferences remain respected.

Use **View release** to read release notes. Dismiss hides that exact release in this browser; a different newer release can appear later. This notice does not install updates. Operator configuration is covered in [Updating LIME](/docs/reference/deployment/updates/).
`,
  },
  {
    slug: ["user", "mcp"],
    title: "MCP For AI Tools",
    description: "Connect external AI clients to LIME through the read-only MCP interface.",
    category: "User Docs",
    sourceFiles: ["docs/mcp.md", "docs-site/content/product-docs.ts"],
    markdown: `# MCP For AI Tools

LIME includes a read-only MCP endpoint for external AI tools. It lets an AI client inspect scans, score summaries, issue groups, paginated occurrences, report availability, and relevant settings from an existing LIME instance.

MCP is read-only. AI tools can analyze LIME data, but they cannot create scans, retry scans, delete scans, change settings, or mark false positives.

## Current status

MCP is available when it is enabled in **Settings > Integrations** and an MCP key has been generated.

Current behavior:

- Use \`POST /mcp\` on the dashboard origin. It forwards to Shopkeeper for authentication and read-only tools, then adds fresh scan scores with the existing dashboard scorer.
- LIME returns JSON responses for MCP initialization, tool listing, and tool calls.
- \`GET /mcp\` returns 405: stateless POST JSON responses are valid Streamable HTTP; an always-open SSE stream is not required.
- MCP session state, OAuth, scoped keys, and write tools are not implemented.
- Origin validation currently allows requests with no \`Origin\` header and localhost origins. Server-to-server clients and local bridges normally omit \`Origin\`; remote browser-origin clients are not supported.

## What you will need

1. A LIME instance that includes MCP support.
2. Access to **Settings** in the LIME dashboard.
3. MCP enabled under **Settings > Integrations**.
4. A generated MCP key.
5. An AI tool that supports remote Streamable HTTP MCP servers, or a local HTTP-to-stdio bridge.

## Endpoint

Production endpoint:

\`\`\`text
https://<your-lime-host>/mcp
\`\`\`

Local development endpoint:

\`\`\`text
http://localhost:3000/mcp
\`\`\`

Use the dashboard host, not the static docs/marketing host on port 3001. Direct Shopkeeper \`/mcp\` (default port 8080) remains available, but its score summary is null when the saved cache is cold or stale. Dashboard \`/mcp\` provides fresh scores and the correct origin for relative report links. A remote machine or cloud client cannot reach your computer's localhost; use a reachable HTTPS dashboard endpoint.

The canonical proxy accepts bodies up to 1 MiB and has a 30-second deadline for incoming-body reads and upstream fetches. Transport errors use HTTP 413 (too large), 400 (unreadable/canceled body), 504 (proxy deadline), 502 (unreachable backend), or 500 (invalid configuration), and may return plain JSON \`error\` rather than a JSON-RPC tool result. Check HTTP status before \`isError\`. This is not a 30-second guarantee for score computation or report generation.

## Generate a key

1. Open **Settings**.
2. Open **Integrations**.
3. Select **Generate MCP key**; generation saves the key and immediately enables MCP.
4. Copy the key immediately. LIME only shows the raw key once.
5. Store the key in your AI tool or local environment.
6. Use **Enable MCP** and **Save settings** for later enable/disable changes.

The connection card shows your dashboard's URL and lets you copy the endpoint, generic HTTP connection details, or optional Codex config. Copy the newly generated key while it is shown; if clipboard access fails, select the displayed text manually. Copy actions do not install or configure a client. Key generation/rotation preserves unrelated reporting/performance drafts without saving them; use **Save settings** for those changes. Rotation requests confirmation because connected clients need the replacement key immediately.

Only a hash and hint are stored. Rotation revokes the old key immediately; disabling MCP rejects new tool requests. The key is shared by the instance, with no automatic expiry or per-user/per-scan scopes. Never commit a real key into a shared configuration.

Use environment variables when your AI tool supports them:

\`\`\`bash
export LIME_MCP_URL="https://lime.example.com/mcp"
export LIME_MCP_KEY="lime_mcp_xxxxxxxxxxxxxxxxx"
\`\`\`

## Choose a client connection

Use native Streamable HTTP with a custom bearer header when supported, or a reviewed local stdio bridge otherwise. LIME does not set up users' AI accounts automatically. OAuth-only connectors and remote browser-origin clients are not currently supported: do not assume ChatGPT or Claude web connectors can use LIME's static bearer key.

Native HTTP configuration does not require Node.js. The local bridge and TypeScript examples require a supported Node.js release with npm/npx available in the launching application's \`PATH\`. Check \`node --version\`, \`npm --version\`, and \`npx --version\` in that environment. The pinned v1 SDK/runner require Node 18 or newer; the v2 client requires Node 20 or newer. Package minimums are not a recommendation to run an unsupported Node release.

JSON does not universally expand environment variables. Use the format documented by your chosen client; these are setup instructions, not proof that a particular installed app has connected.

### Codex

Add to your user \`~/.codex/config.toml\` or trusted project \`.codex/config.toml\`:

\`\`\`toml
[mcp_servers.lime]
url = "http://localhost:3000/mcp"
bearer_token_env_var = "LIME_MCP_KEY"
\`\`\`

Or run this yourself:

\`\`\`bash
codex mcp add lime --url http://localhost:3000/mcp --bearer-token-env-var LIME_MCP_KEY
\`\`\`

Codex must receive the key in its process environment; a terminal export may not reach an already-running desktop app. Restart/reconnect using your host's environment setup. This static-key server does not require an OAuth \`codex mcp login\` step. See [OpenAI's MCP guide](https://developers.openai.com/codex/mcp/).

### Claude Code

Project \`.mcp.json\` supports this header environment expansion:

\`\`\`json
{
  "mcpServers": {
    "lime": {
      "type": "http",
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer \${LIME_MCP_KEY}"
      }
    }
  }
}
\`\`\`

Set the variable in Claude Code's environment, approve the project server when prompted, and inspect \`/mcp\` status and tools. This is Claude Code, not Claude web connector setup. See [Claude Code's guide](https://code.claude.com/docs/en/mcp).

### Cursor

Use project \`.cursor/mcp.json\` or personal \`~/.cursor/mcp.json\`. Cursor's environment placeholder includes \`env:\`:

\`\`\`json
{
  "mcpServers": {
    "lime": {
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer \${env:LIME_MCP_KEY}"
      }
    }
  }
}
\`\`\`

The variable must reach Cursor itself. Restart/reconnect and inspect MCP logs/tools; \`envFile\` is for stdio entries, not HTTP entries. See [Cursor's guide](https://cursor.com/docs/mcp).

### VS Code

VS Code uses \`.vscode/mcp.json\` with \`servers\`, not \`mcpServers\`. A secret prompt avoids embedding the key:

\`\`\`json
{
  "inputs": [{
    "type": "promptString",
    "id": "lime-mcp-key",
    "description": "LIME MCP key",
    "password": true
  }],
  "servers": {
    "lime": {
      "type": "http",
      "url": "http://localhost:3000/mcp",
      "headers": { "Authorization": "Bearer \${input:lime-mcp-key}" }
    }
  }
}
\`\`\`

Start the server through VS Code's MCP controls and verify its tools. See [VS Code's MCP reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration).

## Local bridge config

Use this pattern when an AI tool only supports local \`stdio\` MCP server entries:

\`\`\`json
{
  "mcpServers": {
    "lime": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote@0.14.3",
        "http://localhost:3000/mcp",
        "--transport",
        "http-only",
        "--header",
        "Authorization:\${LIME_MCP_AUTH_HEADER}"
      ],
      "env": {
        "LIME_MCP_AUTH_HEADER": "Bearer <paste-generated-key-in-private-config>"
      }
    }
  }
}
\`\`\`

The example pins the bridge release tested with LIME. Node.js and npx must be on the host client's \`PATH\`; its Undici dependency requires Node 20.18.1 or newer. The isolated check used Node 24.18.0, read all six tools, and confirmed the launcher exited and callback port was released. It did not configure a desktop client or use OAuth. Use a supported Node release and review third-party dependencies before deployment; pinning the bridge is not a security audit or a dependency-tree lock.

The URL is explicit: subprocess arguments do not expand \`\${LIME_MCP_URL}\` as a shell would. This bridge substitutes environment placeholders in headers; the no-space argument avoids launcher quoting problems. Protect the private config/environment. For remote access use HTTPS; non-localhost HTTP requires \`--allow-http\` and a trusted private network. The bridge is not a LIME application dependency. See the [bridge's configuration guide](https://github.com/punkpeye/mcp-remote#custom-headers).

For a client that accepts a stdio launch command, the equivalent shell form is:

\`\`\`bash
export LIME_MCP_AUTH_HEADER="Bearer $LIME_MCP_KEY"
npx --yes mcp-remote@0.14.3 http://localhost:3000/mcp \\
  --transport http-only \\
  --header 'Authorization:\${LIME_MCP_AUTH_HEADER}'
\`\`\`

Single quotes keep header substitution in the bridge rather than the shell. It expects MCP messages on stdin/stdout; a standalone terminal launch can wait quietly and is not a complete connection test. \`make verify-app\` tests the actual stdio bridge with an isolated fixture key and temporary auth/cache directory, without changing user client configuration or normal-instance keys.

## Smoke test

After enabling MCP and configuring the key, verify that missing credentials are rejected on a \`POST\` request:

\`\`\`bash
curl -i -X POST "$LIME_MCP_URL" \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json, text/event-stream" \\
  --data '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "ping"
  }'
\`\`\`

Then test an initialized request:

\`\`\`bash
curl -i "$LIME_MCP_URL" \\
  -H "Authorization: Bearer $LIME_MCP_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json, text/event-stream" \\
  --data '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-11-25",
      "capabilities": {},
      "clientInfo": {
        "name": "lime-smoke-test",
        "version": "0.1.0"
      }
    }
  }'
\`\`\`

Expected result: HTTP 200 with a JSON MCP initialize response. A missing or invalid key should return HTTP 401.

Use the returned protocol version on subsequent requests and complete initialization with a notification:

\`\`\`bash
curl -i "$LIME_MCP_URL" \\
  -H "Authorization: Bearer $LIME_MCP_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json, text/event-stream" \\
  -H "MCP-Protocol-Version: 2025-11-25" \\
  --data '{"jsonrpc":"2.0","method":"notifications/initialized"}'
\`\`\`

Expected result: HTTP 202 with no body. A client library handles this lifecycle automatically. LIME negotiates the three 2025 protocol versions (March 26, June 18, November 25); these examples use November 25, not the newer protocol generation. See the [transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) and [lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) specifications.

## Verify a connection

From a repository checkout with \`docs-site\` dependencies installed:

\`\`\`bash
export LIME_MCP_URL="http://localhost:3000/mcp"
export LIME_MCP_KEY="<your-generated-key>"
# Optional: select a saved scan instead of the latest.
export LIME_MCP_SCAN_ID="<saved-scan-uuid>"
npm --prefix docs-site run verify:mcp
\`\`\`

The default uses SDK v1 \`1.32.0\`. To select the pinned v2 client \`2.3.0\` with legacy 2025 negotiation:

\`\`\`bash
LIME_MCP_SDK=v2 npm --prefix docs-site run verify:mcp
\`\`\`

Omit the optional scan variable to use the latest returned scan automatically. This command uses the pinned official SDK and never creates scans, enables MCP, rotates keys, or changes settings. It checks all six advertised tools, calls list/settings on any instance, calls scan/groups/report metadata when a scan exists, and calls issue detail when a group exists. The \`checked\` output records the tools actually called; an empty instance does not prove all six returned saved data. Its sanitized trace excludes authorization headers and response bodies.

Separately check your chosen app's tool list and ask it to read a known saved scan. SDK success is not proof every AI client or remote deployment has connected. The full deterministic suite is covered in [Verification And Handoff](/docs/reference/verification/).

## TypeScript client example

Use this when you are testing an integration outside an AI client UI. In an empty, separate integration directory, initialize a package and install the SDK and pinned TypeScript runner:

\`\`\`bash
npm init -y
npm install --save-exact @modelcontextprotocol/sdk@1.32.0
npm install --save-dev --save-exact tsx@4.21.0
\`\`\`

Create \`lime-mcp-client.mts\`. The \`.mts\` extension makes this an ES module, so top-level \`await\` works without a package-level \`"type": "module"\` setting:

\`\`\`ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.env.LIME_MCP_URL;
const key = process.env.LIME_MCP_KEY;

if (!url || !key) {
  throw new Error("Set LIME_MCP_URL and LIME_MCP_KEY.");
}

const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: {
    headers: {
      Authorization: \`Bearer \${key}\`,
    },
  },
});

const client = new Client({
  name: "lime-integration-check",
  version: "0.1.0",
});

try {
  await client.connect(transport);
  console.log(JSON.stringify(await client.listTools(), null, 2));
  console.log(JSON.stringify(await client.callTool({
    name: "list_scans",
    arguments: { limit: 5, offset: 0 },
  }), null, 2));
} finally {
  await client.close();
}
\`\`\`

Run it:

\`\`\`bash
LIME_MCP_URL="https://lime.example.com/mcp" \\
LIME_MCP_KEY="lime_mcp_xxxxxxxxxxxxxxxxx" \\
npx --no-install tsx lime-mcp-client.mts
\`\`\`

This pins the SDK v1 generation for the 2025 contract; see the [official SDK v1 source](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x). For the separately pinned v2 client generation:

\`\`\`bash
npm install --save-exact @modelcontextprotocol/client@2.3.0
\`\`\`

Replace the imports and client constructor below, keeping the bearer transport and try/finally lifecycle:

\`\`\`ts
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const client = new Client(
  { name: "lime-integration-check", version: "0.1.0" },
  { versionNegotiation: { mode: "legacy" } },
);
\`\`\`

SDK generation is not server protocol version: this v2 example uses the \`2025-11-25\` initialize contract, not modern 2026 discovery/capabilities. LIME has not upgraded to the modern protocol. See the [official split-package SDK](https://github.com/modelcontextprotocol/typescript-sdk) and its [negotiation source](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/client/src/client/versionNegotiation.ts).

## Available read-only tools

The MCP endpoint exposes these tools:

- \`list_scans\`
- \`get_scan\`
- \`list_scan_issues\`
- \`get_issue_detail\`
- \`get_report_metadata\`
- \`get_settings\`

Use \`list_scan_issues\` first, then pass the returned \`kind\` and \`key\` into \`get_issue_detail\` when you need paginated occurrence details.

Scan arguments use \`scan_id\`, not \`scanId\`. \`kind\` is \`failed\` or \`needs_review\`. List limits default to 20; detail limits default to 25; all are capped at 100, with integer offsets from 0 to 100,000. Tool schemas reject unexpected fields or invalid values. Successful results include matching JSON text and \`structuredContent\`; a tool read failure sets \`isError\`, so HTTP 200 alone is not a success check.

Integer validation uses the exact JSON number rather than floating-point rounding. Optional \`arguments\` can be omitted or \`{}\`; explicit \`arguments: null\` is invalid.

Failed issue UUID keys are canonicalized to lowercase; review keys are rule IDs. Detail lookup works beyond the first 1,000 groups. Some older incomplete audits have a summary count but no stored node occurrences: detail then returns \`[]\` and \`has_more: false\`, without inventing screenshots/selectors. Stop occurrence pagination when \`has_more\` is false.

MCP occurrence details add \`screenshot_url\` and \`element_screenshot_url\` for saved images, relative to the dashboard origin, such as \`/api/screenshots/<scan-id>/<filename>\`. Resolve those URL fields on the dashboard to fetch evidence. Empty or absent stored paths omit the corresponding field; a URL does not guarantee a file still exists on disk. Raw \`screenshot_path\` and \`element_screenshot_path\` remain compatible storage metadata, but values such as \`/app/screenshots/...\` are filesystem locations, not HTTP addresses.

Dashboard \`get_scan\` returns scores refreshed through the UI's scorer, including after triage and on a cold cache. Direct API calls only use a valid saved score cache. \`get_report_metadata\` returns per-format \`availability\` and \`reports\` paths with \`report_paths_relative_to: "dashboard_origin"\`. Resolve paths on your dashboard, not the API port. Availability means the format is enabled, not that a file already exists or a download is guaranteed. This tool does not generate reports. \`get_settings\` excludes the raw key and hash, but includes non-secret integration metadata such as a key hint.

\`score_summary.excluded_count\` is a legacy/reserved compatibility field, not a false-positive count. The current scorer filters marked rules before summarizing, so the field remains zero in this pipeline. Use groups' \`is_false_positive\` for triage state and filtered \`failed_count\`/\`scored_audit_count\` for summary comparisons. A rule with no scoring weight does not necessarily change the numeric score when marked.

## Troubleshooting and boundaries

- **401:** verify MCP is enabled, the key has not been rotated, and the client sends its bearer header.
- **404:** use dashboard \`/mcp\`, not the docs website; verify the reverse proxy and \`SHOPKEEPER_URL\`.
- **403:** a remote browser \`Origin\` is not allowed. Do not strip origin validation to force a browser connector to work.
- **No tools:** use Streamable HTTP rather than legacy SSE, complete initialization, and send the negotiated protocol header. A GET 405 is expected.
- **Bridge failure:** check the explicit URL and complete \`LIME_MCP_AUTH_HEADER\`, process environment, network reachability, and proxies stripping authorization.
- **500/502/504:** inspect dashboard/backend logs, HTTP(S) \`SHOPKEEPER_URL\`, request size, and backend connectivity. The proxy returns controlled errors without exposing upstream URLs or private network errors.

Contributors can run \`npm --prefix lime run test:mcp-transport\` for controlled regressions of the actual proxy/route source, including deadline/cancellation, authentication forwarding, numeric IDs, and decoded gzip headers. It does not start LIME or change its settings/data, and does not replace the full isolated suite. The dashboard runtime requires Node 23+ independently of the client/bridge runtime.

Use HTTPS for remote access and keep keys out of URLs, logs, source control, and shared screenshots. There is no OAuth login, per-user key scoping, automatic expiry, or write/admin tool capability in the current integration.

## Example AI prompts

\`\`\`text
List the latest LIME scans and show me which ones are partial.
\`\`\`

\`\`\`text
For scan 66386d89-8564-40bb-93b3-c4a6fe70fcd4, summarize the top failed accessibility issues by severity and occurrence count.
\`\`\`

\`\`\`text
Show me the first 20 occurrences for the highest-impact issue, including affected URLs and selectors.
\`\`\`

`,
  },
  {
    slug: ["developer"],
    title: "Developer Docs",
    description: "Contribute to LIME across Shopkeeper, the dashboard, reports, docs, and release workflows.",
    category: "Developer Docs",
    sourceFiles: ["docs-site/content/product-docs.ts", "CONTRIBUTING.md"],
    markdown: `# Developer Docs

Use these docs when you are changing code, reviewing architecture, extending APIs, or preparing release-facing work. LIME is split between the Go Shopkeeper backend, the Next.js dashboard, PostgreSQL persistence, generated reports, and this static docs site.

## Recommended path

1. Read [Contributing](/docs/developer/contributing/) before changing code or opening a PR.
2. Read [Architecture](/docs/developer/architecture/) to understand Shopkeeper, Profiler, Juicer, Sweetner, UI, and PostgreSQL.
3. Read [Docs Site](/docs/developer/docs-site/) before changing public docs, screenshots, or GitHub Pages behavior.
4. Read [Performance](/docs/developer/performance/) before touching large-scan reads, reports, caching, or pagination.
5. Read [API](/docs/developer/api/) for how the public API reference is maintained.
6. Use the full [API Reference](/api/) when integrating with Shopkeeper endpoints.
7. Read [MCP For AI Tools](/docs/user/mcp/) when preparing AI-tool connectivity for the MCP endpoint.
8. Use [Verification And Handoff](/docs/reference/verification/) for the existing-feature matrix, isolated checks, and the current project baseline before adding features.

## Engineering rules

- Keep migrations forward-only and safe for existing self-hosted installs.
- Preserve large-scan behavior: first render should stay bounded, and details should load progressively.
- Prefer Postgres-first read models and indexes before adding new infrastructure.
- Keep report output deterministic and bounded unless a format explicitly promises full occurrence detail.
- Update docs and changelog entries for user-facing changes.
`,
  },
  {
    slug: ["developer", "contributing"],
    title: "Contributing",
    description: "Set up the repo, run checks, and submit safe changes.",
    category: "Developer Docs",
    sourceFiles: ["CONTRIBUTING.md", "Makefile"],
    markdown: `# Contributing

Start with a local Docker stack unless your change specifically targets native development.

## Local setup

\`\`\`bash
git clone https://github.com/sumanbasuli/lime.git
cd lime
cp .env.example .env
make start-all
\`\`\`

## Required checks

- Run \`make build\` before opening a release-facing PR.
- Run focused Go or frontend tests for the code you changed.
- Run \`make verify-app\` for dashboard, API, scan lifecycle, report, settings, or screenshot changes. It uses a disposable production stack and deterministic local pages.
- Run \`make docs-verify\` for marketing and documentation layout/navigation changes.
- Keep database migrations forward-only.
- Mirror schema changes in both Shopkeeper migrations and the dashboard Drizzle schema.
- Update docs for every user-facing change.

## Pull request expectations

Explain the user impact, data migration impact, and verification. If a change affects large scans or report generation, include before/after notes for first-load latency and export startup behavior.
`,
  },
  {
    slug: ["developer", "architecture"],
    title: "Architecture",
    description: "Understand Shopkeeper, Profiler, Juicer, Sweetner, UI, and PostgreSQL.",
    category: "Developer Docs",
    screenshots: ["scan-detail"],
    sourceFiles: ["assets/img/arch.png", "shopkeeper/internal/scanner/scanner.go"],
    markdown: `# Architecture

LIME has two runtime services and one database.

## Shopkeeper

Shopkeeper is the Go backend. It owns API routes, scan lifecycle, migrations, screenshots, PDF generation, and the scan pipeline.

## Profiler

Profiler expands sitemap and sitemap-index inputs, validates URLs, deduplicates them, verifies final host eligibility, and writes URL rows.

## Juicer

Juicer drives Chromium workers, runs axe-core, captures screenshots, and records page-level audit results.

## Sweetner

Sweetner normalizes raw audit output into issues, occurrences, needs-review rows, score inputs, and report-ready data.

## UI

The Next dashboard renders scan pages, issue pages, settings, and reports. It reads PostgreSQL for server-rendered pages and proxies runtime API requests to Shopkeeper.
`,
  },
  {
    slug: ["developer", "docs-site"],
    title: "Docs Site",
    description: "Maintain the product/docs site, screenshot pipeline, and GitHub Pages build.",
    category: "Developer Docs",
    screenshots: ["dashboard", "expanded-issue"],
    sourceFiles: ["docs/docs-site.md", "docs-site/", "scripts/docs-refresh.sh", ".github/workflows/docs-pages.yml"],
    markdown: `# Docs Site

The docs site lives in \`docs-site/\` and is a static Next export for GitHub Pages.

The canonical technical handoff doc is [Docs Site](/docs/reference/docs-site/). Use this page for the quick developer overview, and use the reference doc for full details on static export behavior, content sources, search, screenshots, custom domains, and GitHub Pages.

## Commands

\`\`\`bash
make docs-run    # build and serve static docs locally
make docs-dev    # docs hot reload server
make docs-build  # static docs build
make docs-verify # build and browser-check desktop/mobile docs and interactions
make docs        # isolated demo scans, screenshots, static build
\`\`\`

## Screenshot policy

\`make docs\` uses a separate Docker Compose project named \`lime-docs\`, separate PostgreSQL and screenshot volumes, non-default ports, and curated public demo targets. It must never discover or screenshot existing local scans. The partial retry screenshot uses one intentional failed URL in the isolated docs database so the retry card is always visible.

## GitHub Pages

The Pages workflow builds committed docs content and committed screenshots. CI does not run live scans because external scans are slower and less deterministic.
`,
  },
  {
    slug: ["developer", "performance"],
    title: "Performance And Caching",
    description: "Maintain fast large-scan pages and report generation.",
    category: "Developer Docs",
    sourceFiles: ["docs/performance.md", "lime/src/lib/scan-issues.ts", "lime/src/lib/scan-score-data.ts"],
    markdown: `# Performance And Caching

V1 keeps PostgreSQL as the required storage and cache dependency. Redis is intentionally deferred.

## Hot paths

- Dashboard recent scans and score summaries.
- Scan detail score and coverage summaries.
- Issue page first load.
- Issue detail pagination.
- PDF, CSV, and LLM report startup.

## Rules of thumb

Do not rebuild a full issue list in memory to render the first page. Keep occurrence detail live and paginated. Persist derived summaries where repeated aggregation would be expensive.

## Invalidation

Refresh or invalidate cached data after scan completion, same-scan retry completion, false-positive changes, scan deletion, and settings changes that alter report output shape.
`,
  },
  {
    slug: ["developer", "api"],
    title: "API Development",
    description: "Work with scan, issue, report, and settings endpoints.",
    category: "API",
    sourceFiles: ["docs-site/content/api.ts", "shopkeeper/internal/router/router.go", "lime/src/app/api"],
    markdown: `# API Development

The API reference is generated from \`docs-site/content/api.ts\`. Keep it explicit and typed; do not rely on route scraping for public docs.

## Surfaces

- Shopkeeper exposes scan lifecycle, health, version, and backend report routes.
- The dashboard exposes Next API routes for issue chunks, issue details, report exports, and settings.

## Compatibility

Treat v1 endpoint names as stable. Prefer additive response fields over breaking changes. If a route returns large data, add pagination or streaming instead of returning unbounded arrays.

## Examples

Use the main [API Reference](/api/) page for request bodies, response shapes, curl examples, and endpoint-specific notes. The sidebar API entry points there directly.
`,
  },
];
