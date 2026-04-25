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
    screenshots: ["dashboard", "issues", "reports"],
    markdown: `# LIME Documentation

LIME is a self-hosted accessibility scanner for teams that need evidence, not just scores. It runs axe-core in Chromium, captures screenshots, groups issues, tracks review-required checks, and exports reports for humans, spreadsheets, and LLM review.

## What you can do here

- Learn how to create scans, read score and coverage, and triage issue groups.
- Understand same-scan failed-page retry for partial scans.
- Export PDF, CSV, and LLM reports without blocking large issue pages.
- Configure server-wide reporting and performance settings.
- Contribute to the backend, frontend, docs site, and release workflows.

## Docs structure

User docs explain the product workflow from first scan to report export. Developer docs explain the codebase, contribution process, architecture, and release pipeline. API docs document the HTTP surface exposed by Shopkeeper and the dashboard proxy routes.
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

![New scan form](/screenshots/new-scan.png "Start a scan from the New Scan page. The form captures the target URL, scan mode, and optional label.")

## Before you start

1. Make sure the target URL is public or reachable from the server running Shopkeeper.
2. Use a sitemap URL when you want broad site coverage.
3. Use a page URL when you want to verify one page or reproduce one issue quickly.
4. Add a label or tag when you need to identify the environment, client, release, or docs demo later.

## Create the scan

1. Open **Scans** from the dashboard sidebar.
2. Select **New Scan**.
3. Paste the sitemap URL or page URL.
4. Choose the scan mode that matches the target.
5. Submit the form.
6. Stay on the scan detail page if you want to watch progress, or return to the dashboard later.

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

![Dashboard scan list](/screenshots/dashboard.png "The dashboard shows scan targets, status, labels, score summaries, and actions.")

## Read a scan row

1. Check the target URL first. This tells you what host the scan belongs to.
2. Check the status. Running scans are still changing; completed scans are ready for review.
3. Check page coverage. A score is only meaningful when enough pages completed.
4. Open the scan detail page for lifecycle and URL-level progress.
5. Open **Issues** when you are ready to triage grouped findings.

## Statuses

- **Pending** means the scan has been created or reopened and is waiting for work.
- **Scanning** means Shopkeeper is actively processing pending URLs.
- **Paused** means the scan was stopped cooperatively and can be resumed.
- **Completed** means all eligible URLs reached a terminal result.
- **Partial** means some URLs completed and some URLs failed.
- **Failed** means no useful page coverage was produced.

## How to use score and coverage

1. Treat score and coverage as a pair.
2. Do not treat a partial scan score as final when failed pages remain.
3. Retry failed pages from the scan detail page before exporting the final report.
4. Use labels to compare the same site across release candidates, environments, or remediation passes.
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

![Scan detail page](/screenshots/scan-detail.png "The scan detail page combines score, coverage, lifecycle, failed URL counts, and report entry points.")

## Review progress

1. Open a scan from the dashboard.
2. Confirm the target and scan ID.
3. Read the completed, pending, and failed URL counts.
4. Review the score summary only after enough URLs have completed.
5. Use the URL table to identify whether failures are isolated or widespread.

## Same-scan failed-page retry

When a completed scan is partial, LIME can retry only the failed pages inside the existing scan. This avoids paying for a brand-new full scan and keeps the same scan ID, report, score history, completed URL rows, and issue grouping.

![Partial scan retry area](/screenshots/partial-retry.png "Partial scans show an in-place retry area at the top of the scan detail page.")

## Retry failed pages

1. Wait until the scan is completed and marked partial.
2. Use **Retry failed pages** from the top retry area.
3. LIME reopens the same scan and resets only failed URLs to pending.
4. The progress view resumes from the previous completed count.
5. Newly successful pages merge into the existing report.
6. Pages that fail again return to failed status.

## Full rescan versus retry

Use **Retry failed pages** when the scan is partial and you want the current report to become more complete. Use **Full rescan** only when you intentionally want a brand-new scan record for a fresh comparison.
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

![Issue details page](/screenshots/issues.png "The issues page lists failed and needs-review issue groups without loading every occurrence immediately.")

## Triage issue groups

1. Open **Issues** from a scan.
2. Start with critical and serious failures.
3. Check the occurrence count before expanding a group.
4. Expand one issue group when you need selectors, HTML, screenshots, and affected URLs.
5. Use issue-specific exports when one issue group is large enough to review separately.

## Expand an issue

![Expanded issue details](/screenshots/expanded-issue.png "Expanded issue details include occurrence URLs, selector, HTML context, guidance, and screenshots.")

When you expand a card, LIME loads the details for that issue group. The expanded view includes affected URLs, CSS selectors, HTML snippets, screenshot evidence, ACT guidance where available, and occurrence paging.

## Needs-review checks

Needs-review items are included in the UI and reports. These are axe incomplete outcomes that need human judgment instead of automatic failure. Review them alongside failures when you are preparing an accessibility remediation backlog.

## Mark false positives

1. Expand or inspect the issue group enough to confirm the finding.
2. Use **Mark false positive** only when the issue should be excluded from scoring.
3. LIME keeps the issue visible for audit history.
4. Score summaries update after the false-positive state changes.
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

LIME supports scan-level and issue-level exports. Use scan-level reports for stakeholder review and use issue-level reports when one rule needs focused remediation.

![Report download controls](/screenshots/reports.png "The issue page exposes PDF, CSV, and LLM report downloads, including full and small CSV choices.")

## Choose a format

- **PDF** is for human review. It includes issue summaries, affected URLs, screenshots, and bounded occurrence detail.
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

The settings page controls server-wide reporting, performance, and integration preferences. These settings apply to every user of the deployed instance.

![Settings page](/screenshots/settings.png "Settings are grouped into reporting, performance, and integration sections.")

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

## Integration settings

Integration settings are reserved for external interfaces such as MCP. MCP is part of the post-v1 roadmap and is documented separately from the v1 product workflow.
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
    sourceFiles: ["docs-site/", "scripts/docs-refresh.sh", ".github/workflows/docs-pages.yml"],
    markdown: `# Docs Site

The docs site lives in \`docs-site/\` and is a static Next export for GitHub Pages.

## Commands

\`\`\`bash
make docs-run    # build and serve static docs locally
make docs-dev    # docs hot reload server
make docs-build  # static docs build
make docs        # isolated demo scans, screenshots, static build
\`\`\`

## Screenshot policy

\`make docs\` uses a separate Docker Compose project named \`lime-docs\`, separate PostgreSQL and screenshot volumes, non-default ports, and curated public demo targets. It must never discover or screenshot existing local scans.

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
