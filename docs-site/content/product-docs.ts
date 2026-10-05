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
    description: "Start a scan, review evidence, share results, or maintain your LIME instance.",
    category: "User Docs",
    screenshots: ["dashboard", "issues", "reports", "link-checker"],
    markdown: `# LIME Documentation

LIME is a self-hosted accessibility scanner. Audit a page or sitemap, review grouped findings and highlighted screenshots, then share PDF, CSV, or LLM-ready reports with the people fixing your site.

## Choose your starting point

- **Use an existing instance:** follow [Create Your First Scan](/docs/user/first-scan/), then [Review Issues And Screenshots](/docs/user/issues/).
- **Understand a result:** read [Dashboard And Scan List](/docs/user/dashboard/) for score and coverage, or [Scan Detail And Partial Retry](/docs/user/scan-detail/) for recovery actions.
- **Share results:** choose a format in [Export Reports](/docs/user/reports/), or connect a read-only AI client with [MCP For AI Tools](/docs/user/mcp/).
- **Install or operate LIME:** start with [Setup](/docs/reference/setup/). Operator guides cover deployment, backups, updates, and service troubleshooting.
- **Change LIME:** start with [Developer Docs](/docs/developer/) and the [API Reference](/api/).

## What a scan tells you

LIME runs automated accessibility checks in Chromium. A score summarizes scored checks on successfully audited pages; it does not replace manual accessibility testing. Always read coverage and needs-review findings alongside the score.

The [Link Checker](/docs/user/link-checker/) is currently a design preview, not a working crawl or broken-link check. For common questions about the working features, see [Troubleshooting And FAQ](/docs/user/troubleshooting/).
`,
  },
  {
    slug: ["user"],
    title: "User Docs",
    description: "Run an audit, understand its limits, review evidence, and share a useful report.",
    category: "User Docs",
    screenshots: ["dashboard", "scan-detail", "issues", "reports", "link-checker"],
    sourceFiles: ["docs-site/content/product-docs.ts"],
    markdown: `# User Docs

Use these guides when you have access to a LIME dashboard and want to audit a site or work through its results. If you still need to install LIME, use [Setup](/docs/reference/setup/) first.

## Recommended path

1. Start with [Create Your First Scan](/docs/user/first-scan/) to understand sitemap and single-page scans.
2. Use [Dashboard And Scan List](/docs/user/dashboard/) to read status, score, coverage, and scan actions.
3. Open [Scan Detail And Partial Retry](/docs/user/scan-detail/) when a scan is running, partial, or ready for failed-page retry.
4. Review [Issues And Screenshots](/docs/user/issues/) to triage failures and needs-review items.
5. Use [Export Reports](/docs/user/reports/) when you need PDF, CSV, or LLM-ready output.
6. Read [Settings](/docs/user/settings/) before changing shared report limits or integration controls.
7. Connect an external AI client with [MCP For AI Tools](/docs/user/mcp/) if you want read-only access to saved results.
8. Use [Troubleshooting And FAQ](/docs/user/troubleshooting/) when a result or control is confusing.

[Link Checker Preview](/docs/user/link-checker/) explains the separate preview screen and why its start button is disabled.

## What matters operationally

- Review **coverage before score**. Missing pages are missing evidence, not passes.
- Review **Needs review** as well as failures. A high score does not settle checks that need human judgment.
- Use **Retry failed pages** to complete an existing partial scan; use **Rescan** for a new comparison after changing the site.
- Keep the target, tag, screen size, and scan ID with any report you share.
- Choose a sampled export for a quick summary and a full CSV for all stored occurrences in the report scope.
`,
  },
  {
    slug: ["user", "first-scan"],
    title: "Create Your First Scan",
    description: "Create sitemap and single-page scans and understand what happens next.",
    category: "User Docs",
    screenshots: ["new-scan", "dashboard"],
    sourceFiles: ["lime/src/components/new-scan-form.tsx", "lime/src/lib/viewport-presets.ts", "shopkeeper/internal/profiler/profiler.go"],
    markdown: `# Create Your First Scan

Start with a **Single page** scan to learn the workflow or check one changed page. Choose **Sitemap** when you want to audit the eligible pages listed in a sitemap or sitemap index. Sitemap mode does not discover every page by following site links.

![New scan form](/product-screenshots/new-scan.png "Choose a scan mode, screen size, target URL, and optional tag.")

## Before you start

Use a complete HTTP or HTTPS URL, such as \`https://example.com/about\` or \`https://example.com/sitemap.xml\`. The target must be reachable from the LIME server, not just from your own browser. The form does not accept login credentials or your browser's signed-in session.

Have an optional **Tag** ready if you want to distinguish a project, environment, or release, for example \`staging-release-12\`.

## Create the scan

1. Select **New scan** in the dashboard header. On a narrow screen, the button is **New**.
2. Choose **Sitemap** or **Single page**. Sitemap is selected by default.
3. Choose **Screen size**: Desktop (1440×900), Laptop (1280×800), Tablet (768×1024), or Mobile (390×844). Desktop is the default.
4. Paste the target into **Sitemap URL** or **Page URL**, matching your chosen mode.
5. Enter **Tag — optional** if needed, then select **Start scan**.
6. The scan detail page opens. Watch progress there or return later; leaving the page does not stop the scan.

Each scan has its own ID and saved results. Its chosen screen size is reused for every page, same-scan retries, and rescans. Use Mobile to audit the site's narrow layout; resizing the dashboard does not change how the site was audited. Start a separate scan to compare another screen size.

## What LIME does next

For a sitemap, LIME first discovers and checks eligible URLs. It then visits pages in Chromium, runs automated checks, and saves findings and screenshot evidence. Status moves through profiling, scanning, and processing before the run settles.

When it settles, check coverage first and then open **View issue details**. If some pages failed to audit, follow [Scan Detail And Partial Retry](/docs/user/scan-detail/) before treating the report as complete.

## If the target redirects

For sitemap scans, LIME follows collected URLs to their final destination and retains eligible URLs on the entered sitemap's host and port. Off-host, unresolved, and duplicate destinations can be left out. For example, a sitemap on \`example.com\` whose pages redirect to \`www.example.com\` can produce less coverage than you expect. Submit the sitemap for the intended final host and compare the discovered count with your expected pages.
`,
  },
  {
    slug: ["user", "dashboard"],
    title: "Dashboard And Scan List",
    description: "Read recent scans, progress, status, scores, and available actions.",
    category: "User Docs",
    screenshots: ["dashboard"],
    sourceFiles: ["lime/src/app/page.tsx", "lime/src/app/scans/page.tsx", "lime/src/lib/scan-scoring.ts"],
    markdown: `# Dashboard And Scan List

**Overview** shows recent scans and workspace totals. **Scans** shows the full saved list. Open a target from either view to see its coverage, checks, findings, and available actions.

![Dashboard scan list](/product-screenshots/dashboard.png "Overview shows recent targets, tags, status, score, and coverage.")

## Read a scan row

1. Check the target URL first. This tells you what host the scan belongs to.
2. Check the status. Running scans are still changing; completed scans are ready for review.
3. Check coverage: how many pages were successfully audited out of the discovered total?
4. Open the scan detail page for coverage, check results, and lifecycle actions.
5. Select **View issue details** on the detail page when you are ready to review grouped findings.

## Find a scan

Use **Search scans** in the header and submit the search to match a target URL, tag, stored status, or scan type. Command-K or Control-K focuses the input. On the results page, select a tag chip to narrow that search; **All** removes the tag filter. Starting another header search resets the tag filter.

No results? Clear the search and tag filter before assuming a scan is missing. On mobile, use the menu button to open the sidebar; wide tables can be scrolled horizontally. Active progress and Overview's **Pages scanned** count represent processed page attempts, which can include failures; use completed coverage on a settled scan to identify successful audits.

## Statuses

- **Pending** means the scan has been created or reopened and is waiting for work.
- **Profiling** means LIME is discovering eligible URLs from the sitemap.
- **Scanning** means Shopkeeper is actively processing pending URLs.
- **Processing** means completed browser results are being grouped and stored.
- **Paused** means the scan was stopped cooperatively and can be resumed.
- **Completed** means the run finished with at least one successfully audited page. Other pages may still have failed.
- **Failed** means the run could not finish successfully, for example because no page was successfully audited or discovery/processing failed.

**Partial** describes incomplete coverage, not a separate stored status. A completed scan with failed pages can be partial. A paused scan can also have partial coverage because pages remain pending. Open the detail page to distinguish **Resume** from **Retry failed pages**; searching for the stored status \`completed\` can find a completed scan displayed as partial.

## How to use score and coverage

The score is a weighted summary of passed and failed rule checks across successfully audited pages. A rule that fails on any audited page is treated as failed for that scan. It is not a percentage of pages without issues or a count of individual affected elements.

- **Needs review** requires human judgment and does not count as an automatic pass or failure in the score.
- **Not applicable** checks do not contribute to the score.
- **Not scored** findings are still worth reviewing even though their rules have no scoring weight.
- A score appears only for a completed or paused scan with a successfully audited page and scored pass/fail data. A dash does not mean zero issues.
- A paused or partial result represents only its saved coverage. Resume or retry as appropriate before calling it final.

Even 100 does not mean the site has no accessibility barriers. Review needs-review findings and perform manual testing. Compare scans using the same target, scan type, and screen size; use tags to distinguish releases. Overview's **Average score** uses recent scored scans, not every historical scan, and **Open issue groups** counts unmarked failed groups, not individual occurrences or all needs-review checks.
`,
  },
  {
    slug: ["user", "link-checker"],
    title: "Link Checker Preview",
    description: "Know what the preview screen can do and why link-check execution is unavailable.",
    category: "User Docs",
    screenshots: ["link-checker"],
    sourceFiles: ["lime/src/app/links/page.tsx", "lime/src/components/link-checker-preview.tsx"],
    markdown: `# Link Checker Preview

**Link checker** is a design preview. It does not currently crawl a site, test HTTP link targets, or produce a broken-link report.

![Link checker preview](/product-screenshots/link-checker.png "The preview includes the target URL field, run action, and the result layout planned for link validation.")

## Current availability

- The page and navigation entry are available in the dashboard.
- You can switch between **Full crawl** and **Single page** and type a URL.
- **Start link check** is intentionally disabled.
- The page does not crawl or validate links yet.
- No link-check result is stored in PostgreSQL or included in scan reports.

The empty totals and history area are placeholders, not evidence that your site has no broken links. There are no working link-check runs, history, filters, or exports yet.

Use **New scan** for the existing accessibility audit. An accessibility finding about a link's name is different from checking whether that link's destination is broken. Planned work is described on the [Roadmap](/roadmap/); the preview does not promise a delivery date.
`,
  },
  {
    slug: ["user", "scan-detail"],
    title: "Scan Detail And Partial Retry",
    description: "Read page coverage and choose pause, resume, retry, rescan, or delete safely.",
    category: "User Docs",
    screenshots: ["scan-detail", "partial-retry"],
    sourceFiles: ["lime/src/app/scans/[id]/page.tsx", "shopkeeper/internal/handler/handler.go"],
    markdown: `# Scan Detail And Partial Retry

The scan detail page brings together one scan's target, tag, screen size, status, coverage, score, audit checks, and downloads. Check it before deciding whether a result is complete or starting another run. The scan ID is the identifier in its dashboard address, \`/scans/<scan-id>\`.

![Scan detail page](/product-screenshots/scan-detail.png "The scan detail page combines score, coverage, lifecycle, failed URL counts, and report entry points.")

## Review progress

1. Open a scan from the dashboard.
2. Confirm the target and scan ID.
3. Read completed coverage against the total, including any failed-page count. Progress while the run is active can include failed attempts.
4. Review **Audit results**. Its filters show rule-level checks; **Pages** shows their passed, failed, review, and not-applicable page counts, not a URL-status list.
5. Read [score and coverage](/docs/user/dashboard/#how-to-use-score-and-coverage) together, then select **View issue details** for affected elements and remediation guidance.

A **failed URL** means the page audit did not complete. A **failed check** means an audited page produced an accessibility finding. These require different follow-up: restore page coverage for the first, investigate the site's markup or behavior for the second.

This page does not currently list individual failed URL addresses. If you need to diagnose exactly which page audits failed, ask the operator to inspect the saved URL statuses or scanner logs using the scan ID. **View issue details** lists affected URLs for saved findings, not every failed page attempt. It appears when failed, marked, or needs-review groups are available.

## Same-scan failed-page retry

When a completed scan has both successful and failed pages, **Retry failed pages** reopens the existing scan and retries only its failed URLs. Successful pages and their evidence are kept. The score and reports change if retried pages produce new results.

![Partial scan retry area](/product-screenshots/partial-retry.png?v=retry-card "Partial scans show an in-place retry area at the top of the scan detail page.")

## Retry failed pages

1. Wait for the run to finish and the yellow partial-recovery area to appear.
2. Use **Retry failed pages** from the top retry area.
3. LIME reopens the same scan and resets only failed URLs to pending.
4. The progress view resumes from the previous completed count.
5. Newly successful pages merge into the existing report.
6. Pages that fail again return to failed status.

If a page fails again, address its reachability or audit error before retrying repeatedly. A fully failed scan does not offer this recovery card; use **Rescan** after addressing the cause.

## Pause and resume

1. Select **Pause** on an active scan.
2. Wait for **Pausing...** to settle to **Paused**. A pause is cooperative: pages already in flight may finish before it is saved.
3. Select **Resume** when you want to continue pending pages.
4. LIME keeps the same scan ID, screen size, completed pages, and saved findings. A paused scan stays paused if the backend restarts.

Closing the browser or changing pages does not pause a scan.

## Choose the right follow-up

| Action | When to use it | Result |
| --- | --- | --- |
| **Resume** | A paused scan has work left. | Continues pending work under the same scan ID. |
| **Retry failed pages** | A completed partial scan has failed pages. | Reattempts only failed pages under the same scan ID. |
| **Rescan** / **Full rescan** | A completed or failed scan needs a fresh comparison, such as after fixing the site. | Creates a new scan with the same target, type, tag, and screen size; keeps the original. |
| **Delete** | A completed, paused, or failed scan is no longer needed. | Removes that scan's saved results and screenshot files after confirmation. |

Retry does not re-audit successful pages, so use a rescan if their content changed. Deletion cannot be undone in the dashboard: save any needed reports first. It is not a pause control. See [Troubleshooting And FAQ](/docs/user/troubleshooting/) if an expected action is missing.
`,
  },
  {
    slug: ["user", "issues"],
    title: "Review Issues And Screenshots",
    description: "Review affected elements, inspect saved screenshots, and make deliberate triage decisions.",
    category: "User Docs",
    screenshots: ["issues", "expanded-issue"],
    sourceFiles: ["lime/src/app/scans/[id]/issues/page.tsx", "lime/src/components/issue-details-feed.tsx", "lime/src/components/issue-screenshot-lightbox.tsx", "lime/src/lib/scan-issues.ts"],
    markdown: `# Review Issues And Screenshots

Select **View issue details** from a scan to review its failed and needs-review checks. A card represents one rule; its **occurrences** are the affected elements or saved instances of that finding. One repeated problem can therefore be one issue group with many occurrences.

![Issue details page](/product-screenshots/issues.png "The issues page lists failed and needs-review issue groups without loading every occurrence immediately.")

## Triage issue groups

1. Check the scan's coverage so you know which pages are missing from the review.
2. Start with critical and serious failures, then work through the remaining failures and **Needs review** cards.
3. Read the rule title, severity, occurrence count, and **Weight** or **Not scored** badge. Not scored does not mean unimportant.
4. Select a card to expand its details. Open the rule's help link when you need background or guidance.
5. Use **Load more occurrences** within a card and **Load more issues** at the end of the list. The first visible batch is not the whole scan.
6. Download an [issue-specific report](/docs/user/reports/) if you want to assign that rule to someone separately.

## Expand an issue

![Expanded issue details](/product-screenshots/expanded-issue.png "Expanded issue details include occurrence URLs, selector, HTML context, guidance, and screenshots.")

The expanded view shows affected page URLs, CSS selectors, HTML snippets, and screenshot evidence where available. Guidance and ACT references help explain the check; they do not replace reviewing the actual page.

Use a selector and HTML snippet to locate an affected element in the site's code. These are evidence from the scan, so a page that has changed since the audit may no longer match. If loading fails, use **Retry loading details**; this reloads saved evidence and does not start a new scan.

## Inspect screenshot evidence

The small image is a focused preview of the affected element. Select it to open the saved full screenshot with the yellow spotlight and more surrounding context. The preview can be a separate, smaller image; it is not necessarily the full screenshot scaled down. Use **Close** or Escape to return to the issue.

If the focused image is unavailable but a page screenshot was saved, **Open page capture** opens that saved fallback. It does not capture the current page again. Some occurrences have no screenshot: use their URL, selector, and HTML evidence instead. A screenshot shows the page at audit time, not a live view of the site.

## Needs-review checks

**Needs review** means the automated check could not determine the result. Inspect the page and use the guidance to decide what needs fixing. It is not a confirmed failure and is not counted as an automatic pass or failure in the score.

If the same rule has both failed and incomplete outcomes in a scan, the failed group takes priority: LIME does not add a duplicate needs-review card for that rule. The underlying audit data is still saved. Rules with only incomplete outcomes appear as needs-review groups; reports and MCP use the same grouping.

## Mark false positives

Use **Mark false positive** on a failed issue only after checking the finding. It marks the whole rule group for this scan, not just one occurrence. It is not a way to record that you fixed the site: use a new scan to verify a fix.

Marked groups stay visible after active failures and needs-review cards, but are left out of scoring, Overview's open-issue count, and scan-wide reports. A rule with no scoring weight may change counts without changing the numeric score. Use **Unmark false positive** to include the group again. You can still download a marked group's issue-specific report when you need its saved evidence.

Each scan saves its own triage state. A new scan with the same target URL, scan type, and screen size inherits the latest completed, paused, or failed scan's mark or unmark decision for each matching rule, including through **Rescan**. Changing an older scan later does not change a new scan that already inherited its state. Recheck inherited decisions when the site changes.
`,
  },
  {
    slug: ["user", "reports"],
    title: "Export Reports",
    description: "Choose a report format and understand its scope, samples, and saved evidence.",
    category: "User Docs",
    screenshots: ["reports"],
    sourceFiles: ["lime/src/components/issue-report-download-button.tsx", "lime/src/components/issue-card-report-download-button.tsx", "lime/src/lib/issues-report-data.ts", "lime/src/lib/report-settings-config.ts"],
    markdown: `# Export Reports

Use a scan-wide report for an audit handoff or a card's download menu to share one issue. First check the scan's coverage and triage decisions: a report cannot include results for pages that were never successfully audited.

![Report download controls](/product-screenshots/reports.png "The issue page exposes PDF, CSV, and LLM report downloads, including full and small CSV choices.")

## Choose a format

| Format | Best for | What is limited |
| --- | --- | --- |
| **PDF** | A readable audit or issue handoff with summaries, guidance, and saved screenshots where available. | Occurrence detail is capped per issue. |
| **Small CSV** | A spreadsheet-friendly sample across reportable issue groups. | Occurrences are sampled per issue. |
| **Full CSV** | All stored occurrences for the report's issue scope, with URLs, selectors, and HTML. | Not capped by the small-CSV sample setting; large files may exceed your spreadsheet tool's limits. |
| **LLM text** | A compact text summary for AI-assisted review. | Occurrences are sampled, text is shortened, and screenshots are omitted. |

## Download a scan-level report

1. Open the scan detail page or its issue page.
2. Use the scan's report controls. Choices are **Download PDF report**, **Download small report** (CSV), **Download full report** (CSV), and **Download LLM report**, depending on enabled formats.
3. Keep the page open while the download is being prepared. Wait for the browser's download rather than starting the same request repeatedly.
4. Include the scan ID, screen size, coverage, and tag when sharing the file.

Scan-wide reports include active failed groups and needs-review groups; marked false-positive groups are omitted. A paused or partial scan can be exported, but its output represents only the evidence saved so far.

## Download an issue-specific report

1. Find the issue group you want to share or remediate.
2. Open the download menu on that card.
3. Choose **Download PDF**, **Download CSV**, or **Download LLM** for that group only.
4. The card's CSV includes all stored occurrences for that group, not the small-CSV sample.

An issue PDF shows **Generating issue PDF report** while it is prepared. A large request may take time. If it fails, read the error before retrying; hiding the progress message does not cancel work on the server.

## Report limits

The defaults are 30 occurrences per issue in a scan PDF, 2,000 in an issue PDF, 5 per issue in small CSV, and 3 per issue in LLM text. These are occurrence limits, not page-count limits, and an operator can change them in [Settings](/docs/user/settings/).

Use full CSV when you need unsampled stored occurrences. It still cannot recreate missing page audits, absent screenshots, or details that were not saved. Older needs-review data may contain only page-level information.

Disabled formats are unavailable in the UI and rejected by the export endpoint. If every format is disabled, the controls say **Report exports are disabled in dashboard settings**. Ask the instance operator before changing shared settings.

Before sharing a file with another person or an AI service, check whether its URLs, HTML snippets, and screenshots contain information you should not send outside your team. AI suggestions still need review and verification on the site.
`,
  },
  {
    slug: ["user", "settings"],
    title: "Settings",
    description: "Understand shared settings, report limits, MCP keys, and the browser-only update notice.",
    category: "User Docs",
    screenshots: ["settings"],
    sourceFiles: ["lime/src/app/settings/page.tsx", "lime/src/components/dashboard-settings-form.tsx"],
    markdown: `# Settings

Most **Settings** affect everyone using this LIME instance. Change shared limits or integrations with the instance operator's agreement. **Update notice** is the exception: it controls this browser's display preference.

![Settings page](/product-screenshots/settings.png "Settings are grouped into reporting, performance, and integration sections.")

## Reporting settings

- **Enable PDF generation**, **Enable CSV generation**, and **Enable LLM export** control which formats can be downloaded.
- **Full PDF occurrence cap** limits occurrences per issue in a scan-wide PDF; default 30.
- **Single-issue PDF cap** limits detail for an issue-card PDF; default 2,000.
- **Small CSV sample size** controls occurrences per issue in the small report; default 5.
- **LLM sample size** controls occurrences per issue in LLM text; default 3.

Occurrence limits accept whole numbers from 1 to 20,000. They do not cap full CSV exports. See [Export Reports](/docs/user/reports/) before increasing a limit on a large scan.

## Performance settings

- **Summary cache TTL** controls how long saved summaries can be reused; default 60 seconds.
- **Report data cache TTL** is a reserved setting. Its value is saved, but reports do not currently use it; changing it does not make repeated exports faster.
- **Report concurrency** limits PDF generation through each dashboard UI process; default 1. It does not limit CSV/LLM exports or direct backend PDF requests. Increasing it can increase server load.

Leave these at their defaults unless you are investigating a measured performance problem. The [Performance reference](/docs/reference/performance/) explains the current implementation and limits.

## Save or reset

Select **Save settings** and wait for **Settings saved**. Reload to confirm the values were persisted. Disabling a report format also disables its download action and makes new export requests reject that format.

**Reset to defaults** changes the form's reporting/performance values and turns off the MCP draft; select **Save settings** to apply those shared changes. It does not delete the configured MCP key. Reset also immediately turns this browser's update-notice preference back on. If you only want to discard unsaved shared edits, reload instead.

## Integration settings

MCP is off until configured. **Generate MCP key** immediately saves a new key and enables the integration; key rotation immediately revokes the previous key. These actions do not wait for **Save settings** and do not save unrelated report/performance drafts. Later changes to **Enable MCP** do require Save settings. Follow [MCP For AI Tools](/docs/user/mcp/) before generating or rotating a shared key.

## Browser update notice

**Update notice** defaults to on, takes effect immediately, and survives reload in this browser. It does not require **Save settings**. Turning it off hides this browser's card, not the server's release check.

The server checks GitHub releases on a best-effort basis and is enabled by default. A card appears only for a newer stable release when server checks and this browser's display preference are enabled. No card does not prove that an outbound check succeeded.

Use **View release** to read release notes. Dismiss hides that exact release in this browser; a different newer release can appear later. LIME does not install updates automatically. Operators can set \`LIME_UPDATE_CHECK=false\` on the UI service to stop outbound checks; see [Updating LIME](/docs/reference/deployment/updates/).
`,
  },
  {
    slug: ["user", "troubleshooting"],
    title: "Troubleshooting And FAQ",
    description: "Understand missing results, partial coverage, screenshot fallbacks, downloads, and shared settings.",
    category: "User Docs",
    sourceFiles: ["lime/src/lib/scan-scoring.ts", "lime/src/components/scan-actions.tsx", "lime/src/components/issue-details-feed.tsx", "lime/src/components/dashboard-settings-form.tsx"],
    markdown: `# Troubleshooting And FAQ

Start with the scan's target, ID, status, screen size, and coverage. Keep those details with any error message when asking your instance operator for help. Do not delete the only copy of a problematic scan just to clear an error.

## I cannot find my scan

Open **Scans**, clear the header search, and select **All** to remove the tag filter. Overview shows recent scans, not the full history. Make sure you are looking at the same LIME instance where you started the scan. If it was deleted, it cannot be restored from the dashboard.

## The scan failed or found fewer pages than I expected

A URL that opens on your laptop may be unreachable from LIME's server. Check the submitted URL and mode, then ask the operator about network access or the scan error. The scan form does not supply your browser's login session.

Sitemap mode audits eligible sitemap entries; it is not a whole-site link crawl. Duplicate destinations, unresolved URLs, and pages redirecting to a different host or port can be filtered during discovery. If the discovered count is unexpectedly small, compare the sitemap's host with the final host of its page URLs.

If the run completed with some failed pages, use **Retry failed pages** after addressing the cause. If the whole scan failed, use **Rescan** after investigating. See [Scan Detail And Partial Retry](/docs/user/scan-detail/) for the differences.

## The run looks stuck or Pause is taking time

Profiling and processing are real work, even when the completed-page count is not moving. A pause waits for in-flight work to settle. Closing the dashboard does not pause anything.

Reopen the detail page and check its status and update time. If it still appears stalled, send the operator the scan ID, target, status, time, and any displayed error. Service logs and restart/recovery behavior are covered in [Operational Troubleshooting](/docs/reference/deployment/troubleshooting/); do not assume that restarting an active backend is the same as Pause.

## Why is the score blank, partial, or still high?

A score needs a completed or paused run, at least one successfully audited page, and scored pass/fail results. A dash means a score is unavailable, not that the site has passed.

A partial score describes only successfully audited pages. Pending and failed pages have not earned a pass. **Needs review** and **Not scored** findings can remain even with a high score. Read [score and coverage](/docs/user/dashboard/#how-to-use-score-and-coverage) and review the actual findings rather than treating 100 as a complete accessibility assessment.

## Why did marking a false positive not change the score or Excluded count?

Marking applies to an entire failed rule group. A rule with no scoring weight can change issue counts without changing the score. Marked groups remain visible at the end of the issue list, and scan-wide reports omit them.

The score summary's **Excluded** value is a compatibility value and currently does not count marked groups. Use the **False positive** badges on issue cards to inspect triage state. Do not mark a real finding merely because you have fixed the site: run a new scan to verify the fix.

## An issue count is larger than the visible details

Cards and occurrences load in batches. Use **Load more issues** for more groups and **Load more occurrences** inside an expanded card. If a request fails, use **Retry loading details**; this reloads saved data, not the target page.

Some older needs-review results have counts without saved element-level occurrences. LIME cannot invent the missing selector or screenshot. Review the page manually or run a new scan if you need current evidence.

## A screenshot is small, missing, or no longer matches the site

Select a focused preview to open the saved full image and yellow spotlight. If only a page screenshot exists, use **Open page capture**. These are saved audit-time images, not a fresh capture. Missing image files cannot be recovered by opening the lightbox; ask the operator about screenshot storage or backups.

If the page changed after the scan, use its saved URL/selector/HTML for historical review and start a new scan for current evidence. Resizing the dashboard does not change the scan's recorded screen size.

## A report is sampled, unavailable, or slow

PDF, small CSV, and LLM text have per-issue limits. Full CSV includes all stored occurrences for the selected report scope, but does not recover missing audits. LLM text omits screenshots and shortens text. Check [Export Reports](/docs/user/reports/) before comparing formats.

A disabled format cannot be downloaded. Ask the operator to check reporting settings. Large PDFs may queue or take time to generate; keep the page open and read any error before retrying. Include the scan ID, format, and error when reporting a download problem.

## Settings changed, but nothing happened

Most shared settings require **Save settings** and its confirmation. Reload to check persisted values. **Report data cache TTL** is reserved and currently has no report-caching effect.

Browser **Update notice** changes immediately without Save settings. Generating or rotating an MCP key also applies immediately, independently of unrelated settings drafts. See [Settings](/docs/user/settings/) before resetting defaults or rotating a shared key.

## Why is there no update card?

The current release may already be up to date, this browser may have hidden or dismissed the card, the operator may have disabled server checks, or the best-effort GitHub check may be unavailable. No card is not proof that a check succeeded. The card never installs updates.

## My AI client cannot connect, or Link checker will not start

For AI clients, use your dashboard's \`/mcp\` endpoint, an enabled MCP integration, and the current bearer key. A cloud client cannot reach your computer's localhost. Follow [MCP For AI Tools](/docs/user/mcp/) for client-specific configuration and connection troubleshooting.

**Start link check** is deliberately disabled. [Link Checker Preview](/docs/user/link-checker/) is not a working broken-link checker yet.
`,
  },
  {
    slug: ["user", "mcp"],
    title: "MCP For AI Tools",
    description: "Connect external AI clients to LIME through the read-only MCP interface.",
    category: "User Docs",
    sourceFiles: ["docs/mcp.md", "docs-site/content/product-docs.ts"],
    markdown: `# MCP For AI Tools

Connect a compatible AI client to an existing LIME instance so it can read saved scans, scores, issue groups, affected elements, report availability, and relevant settings. For example, ask it to summarize the highest-impact findings in a known scan and include affected URLs and selectors.

MCP is read-only. AI tools can analyze LIME data, but they cannot create scans, retry scans, delete scans, change settings, or mark false positives.

## What you will need

1. A LIME instance that includes MCP support.
2. Access to **Settings** in the LIME dashboard.
3. MCP enabled under **Settings > Integrations**.
4. A generated MCP key.
5. An AI client that supports **Streamable HTTP with a custom bearer header**, or a supported local stdio connection using a bridge.

The key is shared across this instance, not scoped to a user or scan. Connect only clients you intend to give read access to the instance's scan data. LIME does not configure AI accounts automatically and does not offer OAuth or write tools. OAuth-only connectors and remote browser-origin clients are not supported; do not assume a ChatGPT or Claude web connector can use this static key.

## Endpoint

Production endpoint:

\`\`\`text
https://<your-lime-host>/mcp
\`\`\`

Local development endpoint:

\`\`\`text
http://localhost:3000/mcp
\`\`\`

Use the dashboard host, not the static docs/marketing host on port 3001. The dashboard endpoint provides fresh scores and the correct host for report and screenshot links. A remote machine or cloud client cannot reach your computer's localhost; ask the operator for a reachable HTTPS dashboard endpoint.

## Generate a key

1. Open **Settings**.
2. Open **Integrations**.
3. Select **Generate MCP key**; generation saves the key and immediately enables MCP.
4. Copy the key immediately. LIME only shows the raw key once.
5. Store the key in your AI tool or local environment.
6. Use **Enable MCP** and **Save settings** for later enable/disable changes.

The connection card lets you copy the endpoint, generic HTTP connection details, or optional Codex config. Copy actions do not install or configure a client. If clipboard access fails, select the displayed text manually.

Generating or rotating a key does not save unrelated report/performance edits; use **Save settings** for those. Rotation asks for confirmation because connected clients immediately need the replacement key.

The raw key is shown only when generated. If you lose it, rotate the key and update every connected client; you cannot retrieve it again. Rotation revokes the old key immediately, disabling MCP rejects new requests, and keys do not expire automatically. Keep real keys out of source control, shared screenshots, logs, and URLs.

Use environment variables when your AI tool supports them:

\`\`\`bash
export LIME_MCP_URL="https://lime.example.com/mcp"
export LIME_MCP_KEY="lime_mcp_xxxxxxxxxxxxxxxxx"
\`\`\`

## Choose a client connection

Use native HTTP when your client supports it. Choose one example below and replace the URL with your dashboard endpoint if it is not local. Native HTTP configuration does not require Node.js; a stdio-only client needs the [local bridge](#local-bridge-config) and its runtime prerequisites.

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

For VS Code's extension-host workflow, use \`.vscode/mcp.json\` with \`servers\`, not \`mcpServers\`. A secret prompt avoids embedding the key:

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

Start the server through VS Code's MCP controls and verify its tools. Servers requiring interactive \`\${input:...}\` are not forwarded to Agent Host sessions. If you use Agent Host, follow its non-interactive/portable configuration instructions instead; the portable format uses \`mcpServers\`. See [VS Code's MCP reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration).

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

This pins the bridge release tested with LIME. Use a supported Node.js release, at least 20.18.1, with npm and npx on the launching client's \`PATH\`. Check \`node --version\`, \`npm --version\`, and \`npx --version\` in that environment. A desktop app may not inherit the same PATH or variables as your terminal. The isolated bridge check used Node 24.18.0; it did not configure a desktop client or use OAuth. Pinning a third-party bridge is not a security audit.

The URL is explicit: subprocess arguments do not expand \`\${LIME_MCP_URL}\` as a shell would. This bridge substitutes environment placeholders in headers; the no-space argument avoids launcher quoting problems. Protect the private config/environment. For remote access use HTTPS; non-localhost HTTP requires \`--allow-http\` and a trusted private network. The bridge is not a LIME application dependency. See the [bridge's configuration guide](https://github.com/punkpeye/mcp-remote#custom-headers).

The bridge expects an MCP client to exchange messages over stdin/stdout. Launching it alone in a terminal can wait quietly and is not a complete connection test. Add it to your client's stdio server configuration, restart/reconnect, and inspect the client's tool list.

## Verify your client

1. Restart or reconnect the server using your client's MCP controls.
2. Confirm the client lists LIME's six tools below.
3. Ask it to list saved scans, then read one whose ID you can confirm in the dashboard.
4. Compare its coverage and a known issue with that scan before relying on its summary.

An empty instance can connect successfully but has no scan evidence to summarize. AI tools cannot create the missing scan for you; start it in the dashboard first.

For SDK smoke tests, curl requests, and standalone TypeScript integrations, use the [MCP Protocol Reference](/docs/reference/mcp/). The [Verification And Handoff](/docs/reference/verification/) distinguishes the tested SDK/bridge paths from individual client apps and live deployments.

## Available read-only tools

| Tool | What the client can read |
| --- | --- |
| \`list_scans\` | Saved scans, including target and status. |
| \`get_scan\` | One scan's metadata, coverage, and score summary. |
| \`list_scan_issues\` | Grouped failed and needs-review findings. |
| \`get_issue_detail\` | A group's paginated occurrences and saved evidence links. |
| \`get_report_metadata\` | Enabled report formats and download paths; it does not generate a report. |
| \`get_settings\` | Relevant reporting/performance settings and non-secret integration metadata, not the raw key or hash. |

Reports and screenshot links belong to the dashboard host. An available report format is not a pre-generated file or a promise that every download will succeed. AI clients should not turn incomplete coverage or sampled occurrences into a claim about the whole site.

The MCP key protects MCP calls only; ordinary dashboard, report, and screenshot links do not inherit its authorization. The operator must protect remote access separately.

## Troubleshooting and boundaries

- **401:** verify MCP is enabled, the key has not been rotated, and the client sends its bearer header.
- **404:** use your dashboard's \`/mcp\`, not the docs website. Ask the operator to check routing if that endpoint is missing.
- **403:** a remote browser \`Origin\` is not allowed. Do not strip origin validation to force a browser connector to work.
- **No tools:** choose Streamable HTTP rather than a legacy SSE connection, restart/reconnect, and inspect the client logs. Opening the endpoint in a browser sends GET and can show 405; that alone is not a failed MCP connection.
- **Bridge failure:** check the explicit URL and complete \`LIME_MCP_AUTH_HEADER\`, process environment, network reachability, and proxies stripping authorization.
- **500/502/504:** share the HTTP status, time, and non-secret client error with the operator. Do not paste the key or authorization header into an issue or screenshot. Server diagnostics are in the [MCP Protocol Reference](/docs/reference/mcp/).

Use HTTPS for remote access and keep keys out of URLs, logs, source control, and shared screenshots. There is no OAuth login, per-user key scoping, automatic expiry, or write/admin tool capability in the current integration.

## Example AI prompts

\`\`\`text
List the latest LIME scans and show me which ones are partial.
\`\`\`

\`\`\`text
For my saved scan <scan-id>, summarize the top failed accessibility issues by severity and occurrence count. Include coverage and any needs-review findings.
\`\`\`

\`\`\`text
Show me the first 20 occurrences for the highest-impact issue, including affected URLs and selectors. Tell me whether more occurrences remain.
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

Use these guides to find the owning code, choose relevant checks, and document a change. LIME's running product is the Go Shopkeeper backend and Next.js dashboard sharing PostgreSQL and saved screenshot storage. The marketing/docs website is a separate static export.

## Recommended path

1. Read [Contributing](/docs/developer/contributing/) before changing code or opening a PR.
2. Read [Architecture](/docs/developer/architecture/) to understand Shopkeeper, Profiler, Juicer, Sweetner, UI, and PostgreSQL.
3. Read [Docs Site](/docs/developer/docs-site/) before changing public docs, screenshots, or GitHub Pages behavior.
4. Read [Performance](/docs/developer/performance/) before touching large-scan reads, reports, caching, or pagination.
5. Read [API](/docs/developer/api/) for how the public API reference is maintained.
6. Use the full [API Reference](/api/) when integrating with Shopkeeper endpoints.
7. Use [MCP Protocol Reference](/docs/reference/mcp/) for transport, schemas, curl/SDK examples, and controlled integration checks. [MCP For AI Tools](/docs/user/mcp/) is the end-user setup guide.
8. Use [Verification And Handoff](/docs/reference/verification/) for the existing-feature matrix, isolated checks, and the current project baseline before adding features.

## Engineering rules

- Keep migrations forward-only and safe for existing self-hosted installs.
- Preserve large-scan behavior: first render should stay bounded, and details should load progressively.
- Prefer Postgres-first read models and indexes before adding new infrastructure.
- Keep report ordering and scope explicit. PDF, small CSV, and LLM text sample occurrences; full CSV streams the full stored scope.
- Update docs and changelog entries for user-facing changes.

Read the dated handoff record before claiming a regression has been verified. A passing local fixture suite is not a security audit, production load test, or proof of a live deployment. The current dependency backlog and untested boundaries are recorded there; do not turn those into a readiness claim.
`,
  },
  {
    slug: ["developer", "contributing"],
    title: "Contributing",
    description: "Set up the repo, run checks, and submit safe changes.",
    category: "Developer Docs",
    sourceFiles: ["CONTRIBUTING.md", "Makefile"],
    markdown: `# Contributing

Use Docker for a stable scan runtime, or native development when you need to debug a service directly. Use the docs app independently for content/layout changes. Detailed prerequisites and environment handling are in [Setup](/docs/reference/setup/).

## Local setup

\`\`\`bash
git clone https://github.com/sumanbasuli/lime.git
cd lime
cp .env.example .env  # new checkout only; do not overwrite an existing .env
make start-all
\`\`\`

The dashboard defaults to \`http://localhost:3000\`; the backend defaults to \`http://localhost:8080\`. \`make start-dev\` enables dashboard hot reload. Updating source does not require deleting normal database or screenshot volumes.

## Choose checks by changed area

Native checks need Go 1.25.1+ for Shopkeeper and a supported Node release satisfying the dashboard's Node 23+ requirement. Install locked frontend dependencies with \`npm --prefix lime ci\` or \`npm --prefix docs-site ci\` for the app you are checking. Docker-only startup supplies the application runtimes.

| Change | Checks from the repository root |
| --- | --- |
| Go backend | \`(cd shopkeeper && go test ./...)\`, plus focused race/regression tests for changed concurrency paths. |
| Dashboard | \`npm --prefix lime run lint\` and \`(cd lime && npx --no-install tsc --noEmit)\`. |
| MCP proxy | Dashboard checks and \`npm --prefix lime run test:mcp-transport\`. |
| Update notice | Dashboard checks and \`npm --prefix lime run test:update-notice\`. |
| Marketing/docs | \`npm --prefix docs-site run lint\`, \`(cd docs-site && npx --no-install tsc --noEmit)\`, and \`make docs-verify\`. |
| Cross-stack product behavior | \`make verify-app\` in addition to focused source checks. |
| Release/build/migration | \`make build\` and the release/deployment checks relevant to the change. |

Browser checks need Playwright Chromium: \`(cd docs-site && npx playwright install chromium)\`. The isolated product suite additionally needs Docker Compose, free verification ports, and first-run network access for builds and the pinned stdio bridge. [Verification And Handoff](/docs/reference/verification/) documents overrides, fixture ownership, cleanup, and coverage.

## Database and documentation changes

Add a new numbered migration rather than editing a released migration. Mirror schema changes in the dashboard's Drizzle schema. A down migration is not a recovery plan for deleted data; consult [Backup And Restore](/docs/reference/deployment/backup-restore/) before operator-facing changes.

Update the user guide, repository reference, API manifest, and changelog that own the behavior. The linked \`CONTRIBUTING.md\` source contains the complete repository checklist.

## Pull request expectations

Explain the user impact, data/migration impact, checks actually run, and remaining limits. For performance changes, include scan/page/group/occurrence counts, warm/cold state, and measured before/after timings rather than an unsupported claim that large scans are fast.
`,
  },
  {
    slug: ["developer", "architecture"],
    title: "Architecture",
    description: "Understand Shopkeeper, Profiler, Juicer, Sweetner, UI, and PostgreSQL.",
    category: "Developer Docs",
    screenshots: ["scan-detail"],
    sourceFiles: ["shopkeeper/internal/scanner/scanner.go", "shopkeeper/internal/sweetner/sweetner.go", "lime/src/lib/scan-score-data.ts", "lime/src/app/mcp/route.ts"],
    markdown: `# Architecture

The product has two runtime services—Shopkeeper and the Next.js dashboard—sharing PostgreSQL. Screenshot files are stored separately from database rows. Profiler, Juicer, and Sweetner are Go pipeline packages, not separately deployed services. The docs website is a static export and is not the dashboard runtime.

## Shopkeeper

Shopkeeper owns migrations, scan/result writes, lifecycle actions, Chromium workers, screenshot storage, PDF rendering, and direct MCP authentication/read tools. The dashboard is not the owner of scan/audit writes.

## Profiler

Profiler expands sitemap and sitemap-index inputs, resolves and validates eligible URLs, and deduplicates final destinations. The scanner persists the resulting URL rows. Single-page scans skip sitemap discovery.

## Juicer

Juicer visits pages in Chromium, runs axe-core, and captures page/focused/preview screenshots. It returns raw page results to the scanner. Interrupted work is distinguished from genuine page failures so pause/resume can continue pending URLs.

## Sweetner

Sweetner persists rule outcomes and incomplete occurrences, groups failures into one issue per rule per scan, and appends affected-node occurrences. Resume and failed-page retry can append to existing groups. Failed groups take priority over duplicate needs-review cards; raw audit data remains saved.

## UI

The dashboard reads PostgreSQL for server-rendered pages and owns settings, derived score/issue caches, issue pagination, CSV/LLM generation, and export controls. It proxies lifecycle/screenshot/PDF requests to Shopkeeper. The TypeScript scorer derives weighted rule-level results and coverage from saved audit data; it is not a browser-side count of visible cards.

Canonical dashboard \`/mcp\` forwards authentication/tools to Go, then enriches authenticated \`get_scan\` results using the existing scorer. Direct Go MCP returns only a valid saved score cache, or null when it is cold/stale. The protocol reference explains this deliberate endpoint distinction.

## Lifecycle and persistence boundaries

Pause/resume and failed-page retry keep a scan ID; rescan creates another ID. Cooperative pauses preserve completed work, whereas startup recovery of an interrupted active scan resets its partial results before rerunning under the same ID. Persisted paused scans remain paused. Do not use backend restarts as a substitute for Pause.

Scan progress callbacks are serialized to preserve monotonic counters. Concurrent issue-summary cache replacement locks the parent scan row and checks its source timestamp before replacing rows; obsolete or deleted snapshots do not persist cache rows. Keep these guards when changing the paths.

Use the [architecture references](/docs/reference/architecture/ui/) for route/data ownership, [Database](/docs/reference/database/) for schema/migrations, and [Verification And Handoff](/docs/reference/verification/) for regression evidence and limitations.
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

The marketing/docs website lives in \`docs-site/\`. It exports static HTML/assets for GitHub Pages; it does not connect to the normal application database when serving the exported site. Local default: \`http://localhost:3001\`, separate from the dashboard on port 3000.

The canonical technical handoff doc is [Docs Site](/docs/reference/docs-site/). Use this page for the quick developer overview, and use the reference doc for full details on static export behavior, content sources, search, screenshots, custom domains, and GitHub Pages.

## Start content work

Install locked dependencies once with \`npm --prefix docs-site ci\`. Use \`make docs-dev\` for hot reload or \`make docs-run\` for static-export parity. Ordinary content builds do not require Docker or a new scan.

## Commands

\`\`\`bash
make docs-run    # build and serve static docs locally
make docs-dev    # docs hot reload server
make docs-build  # static docs build
make docs-verify # build and browser-check desktop/mobile docs and interactions
make docs        # isolated demo scans, screenshots, static build
npm --prefix docs-site run test:docs-content # navigation, ordering, renderer checks
\`\`\`

## Edit the owning content

- \`docs-site/content/product-docs.ts\`: curated user/developer guides and screenshot references.
- \`docs/\`: operator and technical Markdown, published under \`/docs/reference/...\`.
- \`docs-site/content/api.ts\`: explicit typed endpoint manifest for \`/api/\`.
- \`docs-site/content/navigation.ts\`: audience navigation and reading order.
- \`docs-site/public/product-screenshots/\`: committed product evidence images.

Keep user workflows reader-facing and link detailed protocol/implementation material from technical references. The renderer supports Markdown, not executable HTML or MDX. Use a single page title, unique headings, complete fenced examples, and working internal links/anchors.

## Check the export

Run docs lint/type checks and \`make docs-verify\`. Each production build checks content and static routes, links, anchors, assets, and screenshot files. The source guard rejects untracked or ignored docs code files that would be missing in CI; track intended new sources instead of suppressing the guard. Search is rebuilt from all guides and API entries.

Browser verification is a rendered navigation/layout check, not proof the product scans or reports work. Use \`make verify-app\` for product behavior.

## Screenshot refresh

\`make docs\` uses a separate Compose project named \`lime-docs\`, separate PostgreSQL/screenshot volumes, non-default ports, and fresh scans of public demo targets. It must never discover or screenshot normal local scans. It intentionally seeds one failed URL in its own database for the partial-retry screenshot. Unlike ordinary content work, refresh needs Docker, Chromium, network access, and available ports.

Do not replace this with screenshots of private operator scans. The [Docs Site reference](/docs/reference/docs-site/) documents target overrides, capture assertions, cleanup, and how to add an image.

## GitHub Pages

The Pages workflow builds committed docs content and committed screenshots. CI does not run live scans because external scans are slower and less deterministic.
`,
  },
  {
    slug: ["developer", "performance"],
    title: "Performance And Caching",
    description: "Understand implemented read caches, pagination limits, and PDF concurrency before optimizing.",
    category: "Developer Docs",
    sourceFiles: ["docs/performance.md", "lime/src/lib/scan-issues.ts", "lime/src/lib/scan-score-data.ts"],
    markdown: `# Performance And Caching

LIME uses PostgreSQL-backed score and issue summaries to reduce repeated aggregation. It has no required Redis service. Use this overview to identify a path, then consult the [Performance reference](/docs/reference/performance/) for source locations and measurement guidance.

## Hot paths

- Dashboard recent scans and score summaries.
- Scan detail score and coverage summaries.
- Issue page first load.
- Issue detail pagination.
- PDF, CSV, and LLM report startup.

## Implemented versus reserved behavior

- Score/issue cache reads validate the current scan timestamp and configured summary TTL.
- Issue cards load progressively (default 12 groups); occurrences are queried live in pages (default 25).
- Group summary loading still assembles or reads the scan's summary list before slicing it. It is not fully SQL-paginated and should not be advertised as constant-cost for arbitrary scan sizes.
- Full CSV streams keyset-paged batches of 5,000 stored occurrences. It avoids one giant occurrence array but still does work proportional to the full export.
- \`scan_report_data_cache\` is schema-only reserved infrastructure. \`reportDataCacheTtlSeconds\` persists a value, but no report loader consumes that cache today.
- \`reportGenerationConcurrency\` bounds PDF upstream generation per UI process only. CSV/LLM do not use it, and direct Go PDF requests bypass it. It is not a database-wide semaphore.

## Invalidation

Lifecycle/progress updates touch the scan timestamp; false-positive changes also delete score/issue caches; scan deletion cascades cache rows. Report settings are read by the relevant loaders/routes, not an active saved-file cache.

Issue cache replacements lock the parent scan row with \`FOR UPDATE\` and compare the source timestamp before \`DELETE\`/\`INSERT\`. This serializes concurrent empty-cache replacements and prevents an obsolete snapshot from persisting after an update or deletion. Keep both guards and test concurrent misses after triage.

## Measure before changing defaults

Record representative page/group/occurrence counts, hardware, runtime versions, warm/cold cache state, and concurrency alongside timings. Use isolated fixtures or an authorized read-only sample, not destructive work in the operator database. \`make verify-app\` checks correctness; it is not a public-site or thousands-of-pages load benchmark.

\`LIME_PERF_LOG=true\` enables instrumented UI timing logs. See the reference for thresholds and process-local settings/catalog caching. Avoid describing reserved tables or settings as implemented optimizations.
`,
  },
  {
    slug: ["developer", "api"],
    title: "API Development",
    description: "Choose the correct service origin and maintain explicit endpoint and MCP contracts.",
    category: "API",
    sourceFiles: ["docs-site/content/api.ts", "shopkeeper/internal/router/router.go", "lime/src/app/api"],
    markdown: `# API Development

Start with the main [API Reference](/api/) for executable requests and endpoint-specific responses. This page explains ownership and compatibility when you change the API. The public manifest lives in \`docs-site/content/api.ts\`; it is explicit and typed, not generated by scraping route files.

## Surfaces

| Origin (local defaults) | Owned surface |
| --- | --- |
| Dashboard: \`http://localhost:3000\` | Next settings, issue chunk/detail reads, CSV/LLM reports, export controls, and canonical \`/mcp\`; proxy routes for lifecycle, screenshots, and PDF. |
| Shopkeeper: \`http://localhost:8080\` | Direct Go lifecycle, health/version, screenshots, PDF generation, and authenticated read-only MCP tools. |
| Static website: \`http://localhost:3001\` | Marketing/docs only; not an application API or MCP endpoint. |

Do not send a Next-owned request to the Go port merely because its path starts with \`/api\`. Resolve report/screenshot URLs returned by canonical MCP against the dashboard origin. The MCP bearer key protects MCP requests only; it is not dashboard login or authorization for ordinary report/screenshot/API routes. Operator access controls remain a separate deployment concern.

## Compatibility

Prefer additive response fields and preserve existing endpoint names, parameter validation, scope, status codes, and format gates. Scoped exports require both \`kind\` and \`key\`; CSV supports \`mode=small\` or \`mode=full\` (full by default). Disabled dashboard report formats return 403. A full report means the stored report scope, not every page that a failed scan could not audit.

## MCP integrations and tests

The [MCP Protocol Reference](/docs/reference/mcp/) contains curl lifecycle requests, schemas, paging, screenshot URL fields, and the standalone \`lime-mcp-client.mts\` SDK example. LIME supports the three 2025 Streamable HTTP protocol revisions, not modern 2026 discovery/capabilities. The direct Go endpoint returns null for a cold/stale score cache; canonical dashboard \`/mcp\` refreshes authenticated \`get_scan\` results through the existing scorer.

From a checkout with installed docs dependencies, \`LIME_MCP_URL\` and \`LIME_MCP_KEY\`, run \`npm --prefix docs-site run verify:mcp\`. Optional \`LIME_MCP_SCAN_ID\` chooses a saved scan; otherwise it uses the latest returned scan. \`LIME_MCP_SDK=v2\` selects the pinned split-package client in legacy negotiation mode. The tool list and \`checked\` output differ: an empty instance can list six tools but only exercise scan-list/settings data. The command is read-only and does not generate or rotate keys.

Use \`npm --prefix lime run test:mcp-transport\` for controlled regressions against the actual proxy source, and \`make verify-app\` for the isolated browser/API/data/SDK/stdio-bridge flow. The proxy's body-size/deadline/controlled-error behavior does not promise a total report or score-computation deadline. Inspect HTTP errors and MCP tool \`isError\` results rather than treating HTTP 200 alone as a successful read.

Update the manifest, protocol reference, user workflow, and regression tests together. Record what actually connected and which data paths were checked; neither SDK success nor a pinned bridge proves every user client, live deployment, or dependency tree is safe.
`,
  },
];
