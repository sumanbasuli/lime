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

LIME is a self-hosted accessibility scanner and link checker. Audit a page or sitemap, review grouped findings and highlighted screenshots, then share PDF, CSV, or LLM-ready reports. Check link destinations separately or include a link check with an accessibility scan.

## Choose your starting point

- **Use an existing instance:** follow [Create Your First Scan](/docs/user/first-scan/), then [Review Issues and Screenshots](/docs/user/issues/).
- **Understand a result:** read [Dashboard and Scan List](/docs/user/dashboard/) for score and coverage, or [Scan Detail and Partial Retry](/docs/user/scan-detail/) for recovery actions.
- **Share results or use an AI assistant:** choose a format in [Export Reports](/docs/user/reports/) or connect your assistant with [MCP for AI tools](/docs/user/mcp/).
- **Try the LIME agent:** follow [LIME agent and OpenClaw](/docs/user/agent/) to review results and manage scans from OpenClaw.
- **Find broken links:** use [Link Checker](/docs/user/link-checker/) to check a page, crawl a site, or add link checking to an accessibility scan.
- **Install or operate LIME:** start with [Setup](/docs/reference/setup/). Operator guides cover deployment, backups, updates, and service troubleshooting.
- **Change LIME:** start with [Developer Docs](/docs/developer/) and the [API Reference](/api/).

## What a scan tells you

LIME runs automated accessibility checks in Chromium. A score summarizes scored checks on successfully audited pages; it does not replace manual accessibility testing. Always read coverage and needs-review findings alongside the score.

Link results show whether a destination responded when it was checked. They are separate from the accessibility score. See [Link Checker](/docs/user/link-checker/) for how to interpret them.
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
2. Use [Dashboard and Scan List](/docs/user/dashboard/) to read status, score, coverage, and scan actions.
3. Open [Scan Detail and Partial Retry](/docs/user/scan-detail/) when a scan is running, partial, or ready for failed-page retry.
4. Review [Issues and Screenshots](/docs/user/issues/) to triage failures and needs-review items.
5. Use [Export Reports](/docs/user/reports/) when you need PDF, CSV, or LLM-ready output.
6. Read [Settings](/docs/user/settings/) before changing shared report limits or integration controls.
7. Connect an external AI client with [MCP for AI tools](/docs/user/mcp/) for saved evidence and, when authorized by the operator, workflow actions.
   For a packaged assistant, use [LIME agent and OpenClaw](/docs/user/agent/).
8. Use [Troubleshooting and FAQ](/docs/user/troubleshooting/) when a result or control is confusing.

[Link Checker](/docs/user/link-checker/) explains standalone checks and the optional **Include link check** checkbox when creating an accessibility scan.

## Getting useful results

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

![New scan form](/product-screenshots/new-scan.png "Choose a scan mode, screen size, target URL, optional tag, and optional companion link check.")

## Before you start

Use a complete HTTP or HTTPS URL, such as \`https://example.com/about\` or \`https://example.com/sitemap.xml\`. The target must be reachable from the LIME server, not just from your own browser. The form does not accept login credentials or your browser's signed-in session.

Avoid putting access tokens or passwords in a URL. LIME hides credentials, queries, and fragments when it shows a saved URL in the dashboard, API, MCP, or reports. It still keeps the exact address privately so scans and retries work; protect database backups and remember that page content or screenshots may reveal sensitive data. A displayed link without its query may not reopen a token-protected page.

Have an optional **Tag** ready if you want to distinguish a project, environment, or release, for example \`staging-release-12\`.

## Create the scan

1. Select **New scan** in the dashboard header. On a narrow screen, the button is **New**.
2. Choose **Sitemap** or **Single page**. Sitemap is selected by default.
3. Choose **Screen size**: Desktop (1440×900), Laptop (1280×800), Tablet (768×1024), or Mobile (390×844). Desktop is the default.
4. Paste the target into **Sitemap URL** or **Page URL**, matching your chosen mode.
5. Enter **Tag — optional** if needed. Optionally select **Include link check** to check links from the pages discovered for this scan after the accessibility work completes. This is off by default.
6. Select **Start scan**. The scan detail page opens. Watch progress there or return later; leaving the page does not stop the scan.

Each scan has its own ID and saved results. Its chosen screen size is reused for every page, same-scan retries, and rescans. Use Mobile to audit the site's narrow layout; resizing the dashboard does not change how the site was audited. Start a separate scan to compare another screen size.

If LIME says the queue is full, it has not created the scan. Wait for active work to finish, then select **Start scan** again. The same limit applies to **Resume**, **Retry failed pages**, and **Rescan**; a rejected action leaves the saved scan unchanged.

## What LIME does next

For a sitemap, LIME first discovers and checks eligible URLs. It then visits pages in Chromium, runs automated checks, and saves each finished page's findings and screenshot evidence. The scan shows **Profiling** during discovery and **Scanning** while pages are audited; it settles as completed or failed when the work is done.

On a large sitemap, LIME lets other waiting scans use a worker slot about every ten minutes during discovery and page auditing. The scan may briefly show **Pending** while it waits for its next turn. Completed sitemap work, page checks, and audited pages are saved, and it continues automatically. An in-flight network request or saved checkpoint can make one turn last a little longer.

Sitemap discovery is bounded to 20,000 HTTP requests, 128 MiB of sitemap XML in total, 50 MiB per sitemap, 10,000 distinct page candidates, and ten nested-sitemap levels. LIME fails discovery if a limit is exceeded; it does not present the pages found so far as a complete scan. These limits mean sitemap mode cannot promise every URL in a larger sitemap. There is no overall 30-minute discovery cutoff after the checkpointed discovery upgrade.

When it settles, check coverage first and then open **View issue details**. If some pages failed to audit, follow [Scan Detail and Partial Retry](/docs/user/scan-detail/) before treating the report as complete.

LIME checks embedded frames as part of the page audit. A frame that changes while checks are running can cause that page to fail so its saved results do not leave out the new content. Review important embedded content yourself as well; automated checks do not cover every accessibility barrier.

If you selected **Include link check**, the scan detail page also shows a **Link check** card. The companion check has its own progress and result status; use **View link results** to inspect destinations and source references. Accessibility can finish before link checking does. Link results do not change the accessibility score, issue groups, screenshot evidence, or existing accessibility exports. See [Link Checker](/docs/user/link-checker/) for limits and CSV export.

## If the target redirects

During sitemap discovery and profiling, LIME checks pages on the entered sitemap's host and follows redirects only while they stay on that host. Custom ports must also match; switching between HTTP and HTTPS on their usual ports is allowed. At this stage, LIME skips off-host page URLs and redirects without requesting their destinations. For example, a sitemap on \`example.com\` whose pages redirect to \`www.example.com\` can produce less coverage than you expect. An off-host nested sitemap stops profiling so the scan does not silently use an incomplete page list. Submit the sitemap for the intended final host and compare the discovered count with your expected pages.

During the browser audit, LIME blocks redirects and page resources that lead to private or localhost addresses outside the entered site. Public assets from other sites can still load. If the page itself lands on a different host or an unsupported port, LIME marks it as failed rather than saving another site's results. For a private site entered on the usual HTTP or HTTPS port, LIME allows that same host on both usual ports. This lets the site switch between HTTP and HTTPS, but it also lets the page request the other port, even if a separate service is listening there. Only scan private sites you trust; operators should keep the LIME server away from sensitive internal services. If the site's layout depends on another private host, the saved screenshot may differ from what you see in your browser. If a hostname has already resolved to a public address during a scan, a later private address is blocked. After upgrading, start a fresh scan from **New scan** if an older saved hostname scan needs to reach an intentionally private site; **Rescan** keeps the older scan's network policy.
`,
  },
  {
    slug: ["user", "dashboard"],
    title: "Dashboard and Scan List",
    description: "Read recent scans, progress, status, scores, and available actions.",
    category: "User Docs",
    screenshots: ["dashboard"],
    sourceFiles: ["lime/src/app/page.tsx", "lime/src/app/scans/page.tsx", "lime/src/lib/scan-scoring.ts"],
    markdown: `# Dashboard and Scan List

**Overview** shows recent scans and workspace totals. **Scans** lets you browse the full saved history, 50 scans at a time. Use **Previous** and **Next** to move between pages. Open a target from either view to see its coverage, checks, findings, and available actions.

![Dashboard scan list](/product-screenshots/dashboard.png "Overview shows recent targets, tags, status, score, and coverage.")

## Read a scan row

1. Check the target URL first. This tells you what host the scan belongs to.
2. Check the status. Running scans are still changing; completed scans are ready for review.
3. Check coverage: how many pages were successfully audited out of the discovered total?
4. Open the scan detail page for coverage, check results, and lifecycle actions.
5. Select **View issue details** on the detail page when you are ready to review grouped findings.

## Find a scan

Use **Search scans** in the header and submit the search to match a target URL, tag, stored status, or scan type. Command-K or Control-K focuses the input. On the results page, select a tag chip to narrow that search; **All** removes the tag filter. Starting another header search resets the tag filter.

Search matches the target as shown in the list; credentials embedded in a saved URL are not displayed or searchable. Search terms and exact tag filters can be up to 256 characters long. Results remain paged, including when you search or select a tag.

No results? Clear the search and tag filter before assuming a scan is missing. On mobile, use the menu button to open the sidebar; wide tables can be scrolled horizontally. Active progress and Overview's **Pages scanned** count represent processed page attempts, which can include failures; use completed coverage on a settled scan to identify successful audits.

## Statuses

- **Pending** means the scan is waiting for work. A large scan can return to pending between discovery or page batches without losing committed work; it continues automatically.
- **Profiling** means LIME is discovering eligible URLs from the sitemap. The audited-page count stays at zero until the complete eligible list is ready.
- **Scanning** means LIME is visiting pages and running accessibility checks.
- **Processing** means completed browser results are being grouped and stored.
- **Paused** means the scan has stopped and can be resumed.
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
    title: "Link Checker",
    description: "Check destinations, review source references, export CSV, or include a link check with an accessibility scan.",
    category: "User Docs",
    screenshots: ["link-checker", "link-check-results"],
    sourceFiles: ["lime/src/app/links/page.tsx", "lime/src/app/links/[id]/page.tsx", "lime/src/components/link-checker-dashboard.tsx", "lime/src/components/link-check-detail.tsx", "lime/src/components/scan-link-check.tsx"],
    markdown: `# Link Checker

Use **Link checker** to find broken links on a page or crawl up to your chosen page limit. Each result shows where the link appears, so you can find and fix the original reference. You can export the results as CSV or include a link check with an accessibility scan.

Link checking is available in LIME 2.0. If your dashboard is missing these controls, check your installed version.

![Link checker](/product-screenshots/link-checker.png "The Link checker page starts checks and lists saved runs.")

## Start a standalone check

1. Open **Link checker** in the sidebar.
2. Under **Check a site**, choose **Single page** to extract links from one page, or **Full crawl** to follow eligible same-origin pages.
3. Enter a complete HTTP or HTTPS **Page URL** or **Website URL**. Submit a webpage, not a sitemap XML file. The server must be able to reach it; your browser's login session is not supplied.

Avoid URLs with access tokens or passwords after \`?\`. LIME hides queries in displayed link addresses, CSV, and MCP results, but retains full targets privately for checking and rechecking. Captured page text and database backups may still contain secrets; use a secret-free test URL when possible.
4. For **Full crawl**, choose **Maximum pages**. The default is 100 and the maximum is 500. A limit is a ceiling, not a promise that this many pages exist or will succeed.
5. Select **Start link check** and review the detail page. Leaving the dashboard does not stop the backend job.

**Full crawl** follows same-origin page destinations: scheme, hostname, and effective port must match the entered root. External destinations and linked documents/media can be checked, but are not recursively crawled. **Single page** extracts references from only the submitted source page; checking a destination is not the same as crawling it for more links.

Use the site's final canonical URL, including the correct HTTPS scheme and \`www\` hostname if applicable. A root that redirects to another origin can be checked for reachability, but LIME will not extract that other origin's links; the run shows a warning when this limits its coverage.

**All checks** is saved history, including companions. The **All saved checks** totals add counts across those jobs, not distinct destinations across time. Checking the same site twice contributes two sets of results. Use a run's detail page for its own coverage and counts.

If the queue is full, no link check is created. Wait for active checks to finish, then try again. A rejected **Recheck** leaves the original result intact.

## Include a link check with an accessibility scan

1. Open **New scan** and configure the usual target, screen size, and optional tag.
2. Select **Include link check**. The checkbox is off by default, so ordinary scans keep their existing behavior.
3. Select **Start scan**. The accessibility scan runs first; its companion link check waits in **Queued**.
4. After accessibility completes, the link check examines links on the pages found by the scan. It does not crawl additional pages beyond that list.
5. On scan detail, open **View link results** in the **Link check** card.

A failed page audit is not proof that its links are broken: the companion makes separate HTTP requests. A completed accessibility scan can have a queued or running link check. **Pause** keeps a waiting companion queued; it can start after the scan is resumed and completes. An accessibility failure is reflected on the waiting companion rather than reported as a clean link result. **Retry failed pages** can retry the failed companion after the accessibility retry completes.

A companion that already completed or was explicitly cancelled is preserved when accessibility pages are retried. Use **Recheck** for fresh link evidence rather than assuming the accessibility retry refreshes a completed link snapshot.

Link checks follow pages within the entered URL's scheme, host, and port. Use the site's final URL, including HTTPS and any www prefix, to avoid losing coverage when pages redirect.

Link checking is independent of axe checks, scoring, false-positive triage, screenshots, and accessibility PDF/CSV/LLM reports. **Rescan** preserves the include-link selection and creates a fresh companion with the new scan. Deleting the parent scan also deletes its attached link data.

## Read progress and results

Checks move through **Queued**, **Running**, and then **Completed**, **Failed**, or **Cancelled**. Results can change while the check is running. Once it completes, review coverage and any warnings alongside the link statuses.

![Link check results](/product-screenshots/link-check-results.png "Saved target status, HTTP response, final destination, and source references help you trace a problem.")

Use the **Link targets** filters to focus on a result category:

| Result | Meaning | Follow-up |
| --- | --- | --- |
| Healthy | The destination returned a successful HTTP response without a redirect. | Still review whether it is the intended content. |
| Redirected | The destination reached a successful response through a redirect. | Consider updating the source to the final URL, if appropriate. |
| Broken | The destination returned an HTTP error such as 404 or 500. | Inspect the status and destination; restore it or change the reference. |
| Errors | A timeout, network/redirect problem, access denial, or rate limit made availability inconclusive. | Read the error and retry after addressing the cause. |
| Blocked | Network restrictions prevented LIME from checking the destination or a redirect. | Ask the operator to review the address and network access. |
| Unchecked | A retained target was not checked before a budget or interruption stopped further work. | Check the warning and rerun with a suitable scope. |

One destination is grouped into one target row even when many pages reference it. Source pages themselves are also represented by a **page / url** reference, so totals are not a count of anchor elements alone. HTTP 401, 403, and 429 are **Errors**, not automatically **Broken**, because authentication, access rules, or rate limits can prevent a reliable availability verdict.

The outcome tiles show healthy, redirected, broken, error, blocked and unchecked totals for this saved run. Select a tile or use **Status** to filter targets. **Run details** shows scope, start/finish timestamps and elapsed time, including any time spent queued. Familiar brand icons help you recognize destinations; check the result status to see whether each link works.

Expand **Show sources** to see the destination's origin and path and numbered **Referenced from** cards. LIME hides the URL's query and fragment here, although it keeps the full address privately for checks and rechecks. Each occurrence includes **Found on**, its HTML **Element** and **Attribute**, and **Captured text**. Long paths remain available without stretching the collapsed card. **No text captured** describes the saved extraction only; it is not a missing-accessible-name finding. A source-page inventory entry is explicitly distinguished from an extracted HTML link. Repeated occurrences are retained, not deduplicated away.

Source references load in batches. Use the pagination controls to see all the places a link appears. Use the source address and context to locate the original markup rather than changing only the final destination. If a page of sources cannot load, select **Retry sources**; outdated rows are hidden until the requested page loads successfully.

A non-standard HTTP response such as **999** keeps its saved result category and raw code. Open that destination to verify it manually before changing a reference; the response alone does not establish that a social profile or page is missing.

## Limits and interpretation

- A run is bounded by source-page, target, reference, request, redirect, body, and time budgets. Current ceilings are 500 source pages, 2,000 unique targets, 10,000 retained references, 5,000 HTTP requests, five redirect hops, 2 MiB of HTML per source page, ten seconds per request, and ten minutes per job. Companions use the 500-source-page ceiling. **Truncated** means the saved result does not cover the entire discovered scope.
- Extraction reads returned HTML; it does not run Chromium, execute JavaScript, authenticate, or wait for client-side links. Links created only by JavaScript can be absent. Running a link check does not change the accessibility findings or saved screenshots.
- Fragment-only references such as \`#section\` are skipped. Fragment identifiers on other destinations are removed before checking: a healthy \`/guide#missing-section\` result does not prove that the section exists. Query strings remain significant, so \`?page=1\` and \`?page=2\` can be separate targets.
- Non-HTTP(S) schemes such as \`mailto:\`, \`tel:\`, and \`javascript:\` are not tested as HTTP destinations.
- Connection hints such as \`preconnect\` and \`dns-prefetch\` are skipped. They prepare a server connection or DNS lookup; they do not point to a file that must return a successful HTTP response. Stylesheets, preloads, and other resource links are still checked.
- The entered root origin may be private for local/staging use. Once its hostname resolves publicly, the same check and any recheck will block a later private address. Older saved hostname checks may need a fresh check to reach an intentionally private site after an upgrade. Discovered external origins and redirects outside the root remain restricted to globally routable addresses. A **Blocked** result is a policy outcome, not a site-quality verdict. Only submit origins you are authorized to access.
- Status codes are point-in-time evidence. Rate limits, bot protection, temporary failures, login requirements, or changes after the run can affect results. A healthy response does not verify fragment anchors, content correctness, accessibility, malware safety, or security conformance.

## Export and repeat a check

Select **Export CSV** for saved link targets and their source references. This is a separate link-check export, not the accessibility report CSV. It includes the available saved scope; it does not fill gaps from a truncated, failed, or cancelled run.

CSV has a row per retained source reference with repeated destination details. Prefer a settled run before sharing final evidence; results can change while a job is active. If another export is running, try again shortly. An exceptionally large export over 512 MiB returns an error rather than a partial file.

Use **Cancel check** to stop a queued or running link job without cancelling the parent accessibility scan. **Recheck** is available after the run settles; it creates a new detached run and preserves the old run for comparison. Rechecking a companion reuses its saved page inventory, not a newly expanded sitemap. If it never started and no inventory was saved, start a new accessibility scan with link checking selected instead.

**Delete check** removes a settled check's saved result and source-reference data after confirmation. Cancel an active check before deleting it. Deleting only a companion keeps the accessibility scan and its original include-link selection, so a future **Rescan** still creates a fresh companion. Export evidence you need before deleting it.

## Read saved links through an AI client

Connect an AI assistant through [MCP](/docs/user/mcp/) to summarize saved link checks, find broken destinations, show where they appear, and retrieve CSV exports. If you enable write actions in Settings, the assistant can also start, cancel, repeat, or delete checks with your permission.

Ask for the check date, coverage, and all pages where a broken link appears. Keep errors, blocked requests, and unchecked links separate from confirmed broken destinations. See [MCP for AI tools](/docs/user/mcp/#example-ai-prompts) for example requests.

## If results look incomplete

Read any job error, failed-source count, and truncation warning first. Reduce the crawl scope or check an affected page directly. A source HTML fetch failure can mean there were no extracted references from that page, not that the page contained no links. Restore reachability or fix the destination, then use **Recheck** for new evidence.

For backend, network policy, schema, API, and recovery details, see [Link Checker Architecture](/docs/reference/architecture/link-checker/). General service diagnostics are in [Operational Troubleshooting](/docs/reference/deployment/troubleshooting/).
`,
  },
  {
    slug: ["user", "scan-detail"],
    title: "Scan Detail and Partial Retry",
    description: "Read page coverage and choose pause, resume, retry, rescan, or delete safely.",
    category: "User Docs",
    screenshots: ["scan-detail", "partial-retry"],
    sourceFiles: ["lime/src/app/scans/[id]/page.tsx", "shopkeeper/internal/handler/handler.go"],
    markdown: `# Scan Detail and Partial Retry

The scan detail page brings together one scan's target, tag, screen size, status, coverage, score, audit checks, and downloads. Check it before deciding whether a result is complete or starting another run. The scan ID is the identifier in its dashboard address, \`/scans/<scan-id>\`.

If **Include link check** was selected when the scan was created, a separate **Link check** card shows its companion's status and progress. Accessibility completes before that companion starts; use **View link results** to inspect destinations and export link CSV. A link error does not change the accessibility score. Read [Link Checker](/docs/user/link-checker/) for companion lifecycle and limits.

![Scan detail page](/product-screenshots/scan-detail.png "The scan detail page combines score, coverage, lifecycle, failed URL counts, and report entry points.")

## Review progress

1. Open a scan from the dashboard.
2. Confirm the target and scan ID.
3. Read completed coverage against the total, including any failed-page count. Progress while the run is active can include failed attempts.
4. Review **Audit results**. Its filters show rule-level checks; **Pages** shows their passed, failed, review, and not-applicable page counts, not a URL-status list.
5. Read [score and coverage](/docs/user/dashboard/#how-to-use-score-and-coverage) together, then select **View issue details** for affected elements and remediation guidance.

A **failed URL** means the page audit did not complete. A **failed check** means an audited page produced an accessibility finding. These require different follow-up: restore page coverage for the first, investigate the site's markup or behavior for the second.

On a large sitemap, the status can move from **Profiling** or **Scanning** back to **Pending** while other queued scans take a turn. You do not need to select **Resume**: LIME keeps committed discovery work or completed pages and picks up the remaining work automatically. A manual **Pause** is different and stays paused until you resume it.

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
2. Wait for **Pausing...** to settle to **Paused**. A pause is cooperative: an in-flight discovery request, XML checkpoint, or page audit may settle before it is saved.
3. Select **Resume** when you want to continue pending pages.
4. LIME keeps the same scan ID, screen size, completed discovery work, completed pages, and saved findings. A paused scan stays paused if the backend restarts.

Closing the browser or changing pages does not pause a scan.

## Choose the right follow-up

| Action | When to use it | Result |
| --- | --- | --- |
| **Resume** | A paused scan has work left. | Continues pending work under the same scan ID. |
| **Retry failed pages** | A completed partial scan has failed pages. | Reattempts only failed pages under the same scan ID. |
| **Rescan** / **Full rescan** | A completed or failed scan needs a fresh comparison, such as after fixing the site. | Creates a new scan with the same target, type, tag, and screen size; keeps the original. |
| **Delete** | A completed, paused, or failed scan is no longer needed. | Removes that scan's saved results and screenshot files after confirmation. |

Retry does not re-audit successful pages, so use a rescan if their content changed. Deletion cannot be undone in the dashboard: save any needed reports first. It is not a pause control. See [Troubleshooting and FAQ](/docs/user/troubleshooting/) if an expected action is missing.
`,
  },
  {
    slug: ["user", "issues"],
    title: "Review Issues and Screenshots",
    description: "Review affected elements, inspect saved screenshots, and make deliberate triage decisions.",
    category: "User Docs",
    screenshots: ["issues", "expanded-issue"],
    sourceFiles: ["lime/src/app/scans/[id]/issues/page.tsx", "lime/src/components/issue-details-feed.tsx", "lime/src/components/issue-screenshot-lightbox.tsx", "lime/src/lib/scan-issues.ts"],
    markdown: `# Review Issues and Screenshots

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

For an issue inside an embedded frame, LIME shows the finding and its selector but omits the focused element image. The page capture remains available when saved. This avoids highlighting the whole frame as though it were the affected element; open the page and inspect that selector inside the frame.

On unusually large or changing pages, LIME may omit a screenshot to keep capture resources bounded. Check the saved HTML for an evidence warning when available, then review the affected page and selector manually; a missing image does not mean the issue passed.

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
| **PDF** | A readable audit or issue handoff with summaries, guidance, and saved screenshots where available. | Occurrence detail is capped per issue; reports too large to prepare safely are rejected, not shortened. |
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

If a PDF is too large to prepare safely, LIME stops and shows an error instead of downloading a shortened report. If CSV exports are enabled, choose **Full CSV** for the same scan or issue card to get its complete saved occurrence data. This does not add pages that were never audited or evidence that was never saved.

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

Increasing a PDF occurrence limit can make a large report too big to render. If that happens, use **Full CSV** for the complete saved data in the selected scope, if CSV exports are enabled.

## Performance settings

- **Summary cache TTL** controls how long saved summaries can be reused; default 60 seconds.
- **Report data cache TTL** is a reserved setting. Its value is saved, but reports do not currently use it; changing it does not make repeated exports faster.
- **Report concurrency** limits in-flight PDF requests through download completion in the backend and each dashboard process; default 1. Extra dashboard requests enter a bounded queue, while a busy backend asks direct callers to retry. CSV and LLM exports use separate paths. Increasing the limit can increase server load.

Leave these at their defaults unless you are investigating a measured performance problem. The [Performance reference](/docs/reference/performance/) explains the current implementation and limits.

## Save or reset

Select **Save settings** and wait for **Settings saved**. Reload to confirm the values were persisted. Disabling a report format also disables its download action and makes new export requests reject that format.

**Reset to defaults** changes the form's reporting/performance values and turns off the MCP enablement/write-access draft; select **Save settings** to apply those shared changes. It does not delete the configured MCP key. Reset also immediately turns this browser's update-notice preference back on. If you only want to discard unsaved shared edits, reload instead.

## Integration settings

MCP is off until configured. **Generate MCP key** immediately saves a new key and enables the integration; key rotation immediately revokes the previous key. These actions do not wait for **Save settings** and do not save unrelated report/performance drafts. Later changes to **Enable MCP** do require Save settings. Follow [MCP for AI tools](/docs/user/mcp/) before generating or rotating a shared key.

**Allow MCP write actions** defaults off, including for existing keys after upgrade. Save this separate setting only when every client using the shared key should be allowed to manage scans/link checks, triage failed issues, and change reporting/performance values. Key generation does not turn it on. MCP cannot enable its own write access, change integration permissions, or rotate keys. Turning writes off rejects subsequent action calls; it does not cancel work already accepted.

## Browser update notice

**Update notice** defaults to on, takes effect immediately, and survives reload in this browser. It does not require **Save settings**. Turning it off hides this browser's card, not the server's release check.

LIME checks GitHub for releases by default and shows a card when a newer stable version is available. The card also depends on this browser's display preference and whether the server can reach GitHub.

Use **View release** to read release notes. Dismiss hides that exact release in this browser; a different newer release can appear later. LIME does not install updates automatically. Operators can set \`LIME_UPDATE_CHECK=false\` on the UI service to stop outbound checks; see [Updating LIME](/docs/reference/deployment/updates/).
`,
  },
  {
    slug: ["user", "troubleshooting"],
    title: "Troubleshooting and FAQ",
    description: "Understand missing results, partial coverage, screenshot fallbacks, downloads, and shared settings.",
    category: "User Docs",
    sourceFiles: ["lime/src/lib/scan-scoring.ts", "lime/src/components/scan-actions.tsx", "lime/src/components/issue-details-feed.tsx", "lime/src/components/dashboard-settings-form.tsx"],
    markdown: `# Troubleshooting and FAQ

Start with the scan's target, ID, status, screen size, and coverage. Keep those details with any error message when asking your instance operator for help. Do not delete the only copy of a problematic scan just to clear an error.

## I cannot find my scan

Open **Scans**, clear the header search, and select **All** to remove the tag filter. Overview shows recent scans, not the full history. Make sure you are looking at the same LIME instance where you started the scan. If it was deleted, it cannot be restored from the dashboard.

## The scan failed or found fewer pages than I expected

A URL that opens on your laptop may be unreachable from LIME's server. Check the submitted URL and mode, then ask the operator about network access or the scan error. The scan form does not supply your browser's login session.

If a page opens unusually many browser connections or transfers an exceptionally large amount of data, LIME marks that page as failed instead of presenting an incomplete audit as a success. Check large media and background requests, then use **Retry failed pages** once the cause is addressed.

Sitemap mode audits eligible sitemap entries within its discovery caps; it is not a whole-site link crawl. Duplicate destinations, unresolved URLs, and pages redirecting to a different host or port can be filtered during discovery. A request, XML, candidate, per-document, or depth limit fails discovery instead of publishing partial results. If the discovered count is unexpectedly small, compare the sitemap's host with the final host of its page URLs.

If the run completed with some failed pages, use **Retry failed pages** after addressing the cause. If the whole scan failed, use **Rescan** after investigating. See [Scan Detail and Partial Retry](/docs/user/scan-detail/) for the differences.

## The run looks stuck or Pause is taking time

Profiling and processing are real work, even when the completed-page count is not moving. Long discovery can return to **Pending** about every ten minutes and resume automatically from saved progress. A pause waits for in-flight work to settle. Closing the dashboard does not pause anything.

Reopen the detail page and check its status and update time. If it still appears stalled, send the operator the scan ID, target, status, time, and any displayed error. Service logs and restart/recovery behavior are covered in [Operational Troubleshooting](/docs/reference/deployment/troubleshooting/); do not assume that restarting an active backend is the same as Pause.

## Why is the score blank, partial, or still high?

A score needs a completed or paused run, at least one successfully audited page, and scored pass/fail results. A dash means a score is unavailable, not that the site has passed.

A partial score describes only successfully audited pages. Pending and failed pages have not earned a pass. **Needs review** and **Not scored** findings can remain even with a high score. Read [score and coverage](/docs/user/dashboard/#how-to-use-score-and-coverage) and review the actual findings rather than treating 100 as a complete accessibility assessment.

## Why did marking a false positive not change the score or Excluded count?

Marking applies to an entire failed rule group. A rule with no scoring weight can change issue counts without changing the score. Marked groups remain visible at the end of the issue list, and scan-wide reports omit them.

The score summary's **Excluded** value does not currently count marked groups. Use the **False positive** badges on issue cards to inspect triage state. Do not mark a real finding merely because you have fixed the site: run a new scan to verify the fix.

## An issue count is larger than the visible details

Cards and occurrences load in batches. Use **Load more issues** for more groups and **Load more occurrences** inside an expanded card. If a request fails, use **Retry loading details**; this reloads saved data, not the target page.

Some older needs-review results include counts without element details or screenshots. Review the page manually or run a new scan if you need current evidence.

## A screenshot is small, missing, or no longer matches the site

Select a focused preview to open the saved full image and yellow spotlight. If only a page screenshot exists, use **Open page capture**. These are saved audit-time images, not a fresh capture. Missing image files cannot be recovered by opening the lightbox; ask the operator about screenshot storage or backups.

If the page changed after the scan, use its saved URL/selector/HTML for historical review and start a new scan for current evidence. Resizing the dashboard does not change the scan's recorded screen size.

## A report is sampled, unavailable, or slow

PDF, small CSV, and LLM text have per-issue limits. Full CSV includes all stored occurrences for the selected report scope, but does not recover missing audits. LLM text omits screenshots and shortens text. Check [Export Reports](/docs/user/reports/) before comparing formats.

A disabled format cannot be downloaded. Ask the operator to check reporting settings. Large PDFs may queue or take time to generate; keep the page open and read any error before retrying. Include the scan ID, format, and error when reporting a download problem.

If the error says the PDF is too large, download **Full CSV** for the same scan or issue if CSV exports are enabled. Retrying an unchanged report will not make it fit.

## Settings changed, but nothing happened

Most shared settings require **Save settings** and its confirmation. Reload to check persisted values. **Report data cache TTL** is reserved and currently has no report-caching effect.

Browser **Update notice** changes immediately without Save settings. Generating or rotating an MCP key also applies immediately, independently of unrelated settings drafts. See [Settings](/docs/user/settings/) before resetting defaults or rotating a shared key.

## Why is there no update card?

You may already be up to date, the card may be hidden or dismissed in this browser, or the server may be unable to check GitHub. You can also check the Releases page directly. Update cards do not install updates.

## My AI client cannot connect

For AI clients, use your dashboard's \`/mcp\` endpoint, an enabled MCP integration, and the current bearer key. A cloud client cannot reach your computer's localhost. Follow [MCP for AI tools](/docs/user/mcp/) for client-specific configuration and connection troubleshooting.

## Link checker looks incomplete or will not start

Check that you are using LIME 2.0 or later. Submit a complete HTTP(S) webpage URL and use **Single page** to narrow a problem. A companion remains queued until its parent accessibility scan completes; pausing that scan does not start the link check.

Read **Blocked**, **Errors**, failed-source counts, and truncation warnings separately from **Broken**. Private external destinations may be refused by network policy, while timeouts and bot protection can prevent a definitive result. Extraction does not execute JavaScript or verify fragment anchors. Use [Link Checker](/docs/user/link-checker/) for workflows and [Link Checker Architecture](/docs/reference/architecture/link-checker/) for operator diagnostics.
`,
  },
  {
    slug: ["user", "mcp"],
    title: "MCP for AI tools",
    description: "Connect your AI assistant to review results, retrieve reports, and manage scans and link checks.",
    category: "User Docs",
    sourceFiles: ["docs/mcp.md", "docs-site/content/product-docs.ts"],
    markdown: `# MCP for AI tools

Connect your AI assistant to LIME to review scans, explain findings, check links, and retrieve reports. You can also allow it to start and manage scans, mark false positives, and update reporting settings.

Read-only access is the default, including after an upgrade. LIME provides 17 read tools, or 29 tools when you enable write actions in Settings. Your assistant can check its current access with \`get_capabilities\`.

## What you will need

1. A LIME instance that includes MCP support.
2. Access to **Settings** in the LIME dashboard.
3. MCP enabled under **Settings > Integrations**.
4. A generated MCP key.
5. An AI client that supports **Streamable HTTP with a custom bearer header**, or a supported local stdio connection using a bridge.

All clients using the same MCP key share the same access. Enable writes only for clients you trust. LIME uses a bearer key rather than an OAuth login, so your client must support a custom authorization header. The examples below cover compatible desktop and command-line clients.

## Endpoint

Production endpoint:

\`\`\`text
https://<your-lime-host>/mcp
\`\`\`

Local development endpoint:

\`\`\`text
http://localhost:3000/mcp
\`\`\`

Use your LIME dashboard's address followed by \`/mcp\`. If the AI client runs on another machine, it needs a reachable HTTPS address; your computer's localhost address will not work remotely.

Before exposing LIME remotely, protect the dashboard and ordinary API with external authentication or a restricted network. The MCP key protects \`/mcp\` only; it does not secure the dashboard, API, or download links.

## Generate a key

1. Open **Settings**.
2. Open **Integrations**.
3. Select **Generate MCP key**; generation saves the key and immediately enables MCP.
4. Copy the key immediately. LIME only shows the raw key once.
5. Store the key in your AI tool or local environment.
6. Use **Enable MCP** and **Save settings** for later enable/disable changes.

Leave **Allow MCP write actions** off for evidence-only clients. If workflow actions are wanted, the operator separately enables this setting and selects **Save settings**. Generating a key does not grant writes. After a permission change, refresh/reconnect your client's tool discovery; the server also checks current permission on every action. Turning writes off does not cancel jobs already accepted.

The connection card lets you copy the endpoint and generic HTTP connection details, then choose an optional configuration example for **Codex**, **Claude Code**, **OpenCode 2.x**, or **OpenCode 1.x (legacy)**. Choose the format that matches your installed client. Copy actions do not install or configure a client; examples containing a generated key must be kept private. If clipboard access fails, select the displayed text manually.

Generating or rotating a key does not save unrelated report/performance edits; use **Save settings** for those. Rotation asks for confirmation because connected clients immediately need the replacement key.

The raw key is shown only when generated. If you lose it, rotate the key and update every connected client; you cannot retrieve it again. Rotation revokes the old key immediately, disabling MCP rejects new requests, and keys do not expire automatically. Keep real keys out of source control, shared screenshots, logs, and URLs.

Use environment variables when your AI tool supports them:

\`\`\`bash
export LIME_MCP_URL="https://lime.example.com/mcp"
export LIME_MCP_KEY="lime_mcp_xxxxxxxxxxxxxxxxx"
\`\`\`

## Choose a client connection

Use native HTTP when your client supports it. Choose one example below and replace the URL with your dashboard endpoint if it is not local. Native HTTP configuration does not require Node.js; a stdio-only client needs the [local bridge](#local-bridge-config) and its runtime prerequisites.

Environment-variable syntax differs between clients. Use the example for your client and check the connection after saving it.

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

### OpenCode 2.x

Merge this server into \`opencode.jsonc\`. Version 2 places servers under \`mcp.servers\` and uses \`disabled\`, not the legacy \`enabled\` field:

\`\`\`json
{
  "mcp": {
    "servers": {
      "lime": {
        "type": "remote",
        "url": "http://localhost:3000/mcp",
        "headers": { "Authorization": "Bearer {env:LIME_MCP_KEY}" },
        "oauth": false,
        "disabled": false
      }
    }
  }
}
\`\`\`

Set \`LIME_MCP_KEY\` in OpenCode's process environment. Restart/reconnect and check \`opencode mcp list\` or \`/mcps\`. LIME uses a static bearer key, so OAuth is disabled. Keep the default legacy protocol handshake for LIME; do not force a newer protocol revision. See [OpenCode 2.x MCP documentation](https://opencode.ai/v2/docs/mcp-servers).

### OpenCode 1.x (legacy)

Older OpenCode versions place \`lime\` directly under \`mcp\`:

\`\`\`json
{
  "mcp": {
    "lime": {
      "type": "remote",
      "url": "http://localhost:3000/mcp",
      "headers": { "Authorization": "Bearer {env:LIME_MCP_KEY}" },
      "oauth": false,
      "enabled": true
    }
  }
}
\`\`\`

Use this shape only for the legacy client, with \`LIME_MCP_KEY\` available to its process. Check the installed version before copying an example; the two shapes are not interchangeable. See [OpenCode 1.x MCP documentation](https://opencode.ai/docs/mcp-servers/).

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

The bridge needs Node.js 20.18.1 or later, with npm and npx available to your AI client. Check \`node --version\`, \`npm --version\`, and \`npx --version\` in that environment. A desktop app may need its own PATH and environment-variable setup.

The URL is explicit: subprocess arguments do not expand \`\${LIME_MCP_URL}\` as a shell would. This bridge substitutes environment placeholders in headers; the no-space argument avoids launcher quoting problems. Protect the private config/environment. For remote access use HTTPS; non-localhost HTTP requires \`--allow-http\` and a trusted private network. The bridge is not a LIME application dependency. See the [bridge's configuration guide](https://github.com/punkpeye/mcp-remote#custom-headers).

The bridge expects an MCP client to exchange messages over stdin/stdout. Launching it alone in a terminal can wait quietly and is not a complete connection test. Add it to your client's stdio server configuration, restart/reconnect, and inspect the client's tool list.

## Verify your client

1. Restart or reconnect the server using your client's MCP controls.
2. Call \`get_capabilities\` and confirm discovery matches your mode: 17 read tools, or 29 with operator-enabled writes.
3. Ask it to list saved scans, then read one whose ID you can confirm in the dashboard.
4. Compare its coverage and a known issue with that scan before relying on its summary.
5. Ask it to list saved link checks and read a known check's destinations and sources. Compare the job ID, raw HTTP outcome and source references with the dashboard.

If your instance has no saved results, start a scan or link check in the dashboard, then ask your assistant to summarize it.

For curl requests, SDK examples, and custom integrations, see the [MCP Protocol Reference](/docs/reference/mcp/).

For a ready-made workspace and skills, follow [LIME agent and OpenClaw](/docs/user/agent/).

## Read saved results

| Tool | What the client can read |
| --- | --- |
| \`list_scans\` | Saved scans, including target and status. |
| \`get_scan\` | One scan's metadata, coverage, and score summary. |
| \`list_scan_issues\` | Grouped failed and needs-review findings. |
| \`get_issue_detail\` | A group's paginated occurrences and saved evidence links. |
| \`get_report_metadata\` | Enabled report formats and download paths; it does not generate a report. |
| \`get_settings\` | Relevant reporting/performance settings and non-secret integration metadata, not the raw key or hash. |
| \`list_link_checks\` | Paginated saved standalone and companion checks. |
| \`get_link_check\` | One job's mode, status, coverage, limits, summary, timestamps, and dashboard/CSV paths. |
| \`get_link_check_stats\` | Aggregate totals across all saved checks, not distinct sites or destinations across runs. |
| \`get_scan_link_check\` | A scan's historical include-link selection and optional companion with its own status. |
| \`list_link_check_results\` | Paginated unique destinations, optionally filtered by the six saved outcome categories. |
| \`list_link_check_sources\` | Paginated retained source references, including repeated occurrences and captured context. |

If selected saved data is too large, LIME returns an error without partial results. Ask for fewer results per page or open the dashboard.

## Capabilities, reports, and screenshots

These tools check access and retrieve reports and images:

| Tool | What it provides |
| --- | --- |
| \`get_capabilities\` | Current access mode, available operations, confirmation/request-ID requirements, and dashboard-only boundaries. |
| \`get_workspace_stats\` | Workspace scan/issue/page totals and running backend version. |
| \`get_report\` | A scan-wide, failed-issue, or needs-review scoped PDF, CSV, or LLM export with existing report flags and occurrence limits. |
| \`get_screenshot\` | A saved evidence image using its scan ID and filename, not an arbitrary URL/path. |
| \`get_link_check_export\` | Saved-link CSV, separate from accessibility report toggles. |

Use the dashboard's \`/mcp\` endpoint to retrieve reports, screenshots, and link CSV files. Files can be up to 4 MiB. Very large reports may also be too large to prepare through MCP; download the complete file from the dashboard instead. LIME won't present a shortened report as complete. How images and PDFs appear depends on your AI client.

If LIME is busy calculating scores, preparing reports, or sending files, wait a moment and ask again. You can also retry a file if its transfer is interrupted. A failed score read does not mean the scan scored zero; LIME returns an error rather than an incomplete score.

If a response from an older backend is too large, ask for fewer results at a time or open the dashboard. After any failed action response, check whether the change was saved before trying again. For actions that use a request ID, keep the original ID so you don't accidentally create a second job.

You can request a whole-scan report or a report for one issue. Small CSV and text reports include samples; full CSV includes all saved occurrences for the selected report. See [Export Reports](/docs/user/reports/) for format details.

## Allow your assistant to make changes

Enable **Allow MCP write actions** in Settings and save. This gives all clients using your key access to the following actions. Key management and MCP permissions remain in the dashboard.

| Tools | Workflow |
| --- | --- |
| \`create_scan\`, \`pause_scan\`, \`resume_scan\` | Create a sitemap/single-page scan with a chosen viewport and optional link companion; pause/resume eligible work under normal lifecycle rules. |
| \`retry_failed_pages\`, \`rescan_scan\` | Retry an eligible completed partial scan under its ID, or create a fresh scan while preserving the original. |
| \`delete_scan\` | Delete an eligible scan, its saved evidence/screenshots, and companion, after explicit confirmation. |
| \`mark_issue_false_positive\` | Set \`false_positive: true\` to mark, or false to restore a failed issue UUID. Needs-review rule IDs are not eligible. |
| \`create_link_check\`, \`cancel_link_check\` | Start a bounded HTTP/HTML check or cancel queued/running work while retaining results. |
| \`recheck_link_check\`, \`delete_link_check\` | Create a fresh point-in-time check, or delete terminal saved data after confirmation. Deleting a companion does not delete its scan. |
| \`update_settings\` | Change selected reporting/performance values with \`confirm: true\`; no integration permissions or keys. |

New scans, standalone link checks, rescans, and rechecks use a UUID \`request_id\` to identify the request. If the connection drops, your client should reuse that ID with the same arguments and check the saved job before trying again. A new ID can create a duplicate. If LIME reports that the outcome is uncertain, inspect scan or link-check history before starting another job.

The instance accepts at most 1,000 new MCP action request IDs per UTC day. If it returns a rate denial (\`http_status: 429\`, \`retry_with_same_request_id: true\`), no request was reserved and no job started. Wait until \`retry_after_utc\`, then retry the same UUID and arguments. Saved results and unfinished requests still replay or report their prior state during the limit.

If an action returns **capacity busy**, no action was started. Wait briefly and retry with the same request ID and arguments. This is different from a confirmed queue-full result below.

An unusually large saved action result may return **result too large**. Your request record stays saved, and LIME will not run the action again to recreate the response. Open the scan or link check in the dashboard to inspect its current state; do not switch to a new request ID just to retrieve a result.

If LIME confirms the queue is full while creating a scan, rescan, standalone link check, or recheck, no job was created. Wait, then use a new request ID. Reusing the old ID repeats the queue-full response. For **Resume scan** or **Retry failed pages**, wait, check the scan's current status, then retry the same scan ID if it is still eligible.

Deleting results or changing shared settings requires your approval and \`confirm: true\`. Keep your client's approval prompts enabled. Pausing or cancelling may take a moment while work already in progress finishes.

When a scan includes a link check, the two jobs have separate progress and results. Ask your assistant to wait for both and include any failed pages or incomplete coverage in its summary.

Link results can span several pages. Ask for all matching results and source references when you need a complete list. Errors, blocked requests, and unchecked destinations need follow-up; they do not necessarily mean a link is broken.

Treat text captured from a scanned site as report content. Your assistant should not follow instructions embedded in page text, screenshots, or reports.

For exact arguments, result fields, and retry behavior, see the [MCP Protocol Reference](/docs/reference/mcp/).
## Troubleshooting

- **401:** verify MCP is enabled, the key has not been rotated, and the client sends its bearer header.
- **404:** use your dashboard's \`/mcp\`, not the docs website. Ask the operator to check routing if that endpoint is missing.
- **403:** a remote browser \`Origin\` is not allowed. Do not strip origin validation to force a browser connector to work.
- **No tools:** choose Streamable HTTP rather than a legacy SSE connection, restart/reconnect, and inspect the client logs. Opening the endpoint in a browser sends GET and can show 405; that alone is not a failed MCP connection.
- **Bridge failure:** check the explicit URL and complete \`LIME_MCP_AUTH_HEADER\`, process environment, network reachability, and proxies stripping authorization.
- **500/502/504:** share the HTTP status, time, and non-secret client error with the operator. Do not paste the key or authorization header into an issue or screenshot. Server diagnostics are in the [MCP Protocol Reference](/docs/reference/mcp/).

Use HTTPS for remote access and keep your key private. Keys stay valid until rotated. The MCP key protects MCP requests; dashboard pages and ordinary download links need separate access controls.

- **Action unavailable:** check **Allow MCP write actions** in Settings, then reconnect the client.
- **Action failed:** read the error and check the scan or link check's current status before retrying.
- **Queue full:** when creating a new job, wait for capacity and try again with a new request ID. For resume or failed-page retry, check the scan's status and retry its scan ID if still eligible. Keep the original request ID when a new-job outcome is uncertain.
- **Request timed out:** check saved history for the job and keep its original request ID.
- **Report too large:** download it from the dashboard. MCP transfers files up to 4 MiB.
- **Connection or read busy:** wait briefly and retry. Capacity may remain busy briefly after a canceled database request.
- **Response too large:** ask for fewer results per page, or open the dashboard. LIME returns an error instead of partial saved results.
- **Response delivery unavailable:** restart the dashboard. If this followed an action, check its saved state before trying again and keep the original request ID.

## Example AI prompts

Start with saved results. Enable writes in Settings when you want the assistant to create or change something.

\`\`\`text
Summarize my latest scan. Show the most serious issues, affected pages, and anything that still needs manual review.
\`\`\`

\`\`\`text
Which scans have failed pages? Explain whether I should resume, retry failed pages, or run a new scan.
\`\`\`

\`\`\`text
Find broken links in my latest completed link check and show every page where they appear.
\`\`\`

\`\`\`text
Get the CSV and text reports for scan <scan-id>, along with a screenshot of the highest-priority issue.
\`\`\`

\`\`\`text
Run a single-page Mobile scan of https://example.com and include a link check. Show me both results when they finish.
\`\`\`

\`\`\`text
Compare scans <first-id> and <second-id>. Explain which issues improved and which still need attention.
\`\`\`

\`\`\`text
Show me the current report limits and suggest settings for a shorter PDF. Ask before saving changes.
\`\`\`

`,
  },
  {
    slug: ["user", "agent"],
    title: "LIME agent and OpenClaw",
    description: "Review results, run scans, and check links with the LIME agent in OpenClaw.",
    category: "User Docs",
    sourceFiles: ["agent/README.md", "agent/openclaw.example.json", "agent/workspace/AGENTS.md", "docs/agent.md"],
    markdown: `# LIME agent and OpenClaw

Use the LIME agent to review accessibility findings, check links, and manage scans from OpenClaw. It includes three skills that help your assistant choose the right tools and explain the results.

The agent connects to your LIME instance through [MCP](/docs/user/mcp/). It starts with read-only access. You can enable actions when you want it to run scans or make changes.

## What you can do

- **Review results:** summarize scans, compare coverage and scores, and find the pages affected by an issue.
- **Manage scans and links:** start scans, include link checks, pause or resume work, and retry failed pages.
- **Work through findings:** review false positives and update reporting settings with your approval.
- **Share evidence:** retrieve PDF, CSV, and text reports, screenshots, and link-check exports.

## Before you start

You will need LIME 2.0, OpenClaw 2026.7.1 with native MCP support, and an OpenAI subscription model available to your account. The included configuration uses OpenClaw's built-in agent and OpenAI sign-in.

In LIME, open **Settings > Integrations**, enable MCP, and have your MCP key ready. If you need to generate a key, copy it when it appears; LIME shows it only once. Leave **Allow MCP write actions** off while trying the read-only setup.

## Connect OpenClaw

Run these commands from your LIME checkout in Bash or Zsh. Replace \`openai/<your-model>\` with a model available in OpenClaw. If LIME runs on another machine, replace the URL with its HTTPS dashboard address followed by \`/mcp\`.

\`\`\`bash
export LIME_AGENT_PROFILE="$(pwd -P)/.artifacts/lime-agent-demo"
export LIME_MCP_URL="http://localhost:3000/mcp"
export LIME_AGENT_MODEL="openai/<your-model>"

node agent/scripts/openclaw-config.mjs \\
  --directory "$LIME_AGENT_PROFILE" \\
  --url "$LIME_MCP_URL" --model "$LIME_AGENT_MODEL"

export OPENCLAW_STATE_DIR="$LIME_AGENT_PROFILE/state"
export OPENCLAW_CONFIG_PATH="$LIME_AGENT_PROFILE/openclaw.json"
export LIME_AGENT_WORKSPACE="$LIME_AGENT_PROFILE/workspace"
printf 'LIME MCP key: '
read -r -s LIME_MCP_KEY
printf '\\n'
export LIME_MCP_KEY
\`\`\`

This creates a separate profile with its own workspace and settings. Use an empty directory; the generator will not overwrite an existing profile. Keep using the same terminal for the commands below.

If OpenClaw needs you to sign in, run:

\`\`\`bash
openclaw models auth login --provider openai --profile-id openai:default
\`\`\`

Check the connection, then ask the agent to read your saved results:

\`\`\`bash
openclaw config validate
openclaw mcp doctor lime --probe
openclaw agent --local --agent lime --json --timeout 180 \\
  --message "Summarize my recent LIME scans and link checks. Highlight incomplete scans and the issues I should review first."
\`\`\`

The response should refer to results you can find in your dashboard. If the instance has no saved scans, create one in LIME first.

The profile is limited to LIME tools and reading its own skill instructions. Your MCP key stays in the terminal environment. Keep the generated profile private because its conversation history may contain scanned URLs and reports.

## Enable scan and editing actions

To let the agent make changes, create a new profile with \`--allow-writes\`:

\`\`\`bash
export LIME_AGENT_PROFILE="$(pwd -P)/.artifacts/lime-agent-operations"
node agent/scripts/openclaw-config.mjs \\
  --directory "$LIME_AGENT_PROFILE" \\
  --url "$LIME_MCP_URL" --model "$LIME_AGENT_MODEL" --allow-writes
export OPENCLAW_STATE_DIR="$LIME_AGENT_PROFILE/state"
export OPENCLAW_CONFIG_PATH="$LIME_AGENT_PROFILE/openclaw.json"
export LIME_AGENT_WORKSPACE="$LIME_AGENT_PROFILE/workspace"
\`\`\`

In LIME, enable **Allow MCP write actions** under **Settings > Integrations** and save. This permission applies to every client using the instance's MCP key. If OpenClaw asks you to sign in for this new profile, repeat the login command above in the same terminal.

Tell the agent which site or saved result to work on and what you want changed. It asks for approval before deleting results or changing shared settings.

New scans, standalone link checks, rescans, and link rechecks need a request ID. Generate one with:

\`\`\`bash
node agent/scripts/request-id.mjs
\`\`\`

Include it in your request:

\`\`\`text
Scan https://example.com on Mobile and include a link check. Use request ID <paste-the-generated-UUID>. When both checks finish, summarize the results and get the text report.
\`\`\`

If a request times out, keep the same ID while the agent checks whether the job was created. A new ID can start a duplicate job.

## Useful requests

\`\`\`text
Which of my recent scans have incomplete coverage?
\`\`\`

\`\`\`text
Summarize the most serious issues in scan <scan-id> and show the affected pages.
\`\`\`

\`\`\`text
Find broken links in check <check-id> and show where each link appears.
\`\`\`

\`\`\`text
Compare these two scans and explain what improved and what still needs attention.
\`\`\`

## Troubleshooting

| Problem | What to check |
| --- | --- |
| Connection rejected or 401 | MCP must be enabled and the key must match the current key in LIME. |
| Tools are missing | Check the MCP connection and restart the OpenClaw session. For actions, check both the profile's \`--allow-writes\` option and LIME's write setting. |
| Model or sign-in error | Check your OpenClaw account and model selection. |
| No saved results | Create a scan or link check in LIME, then ask again. |
| Export is too large | MCP transfers files up to 4 MiB. Download larger reports from the dashboard. |

Use the dashboard's \`/mcp\` address for the connection. For remote access, use HTTPS and protect the dashboard with your usual access controls; the MCP key only protects MCP requests.

Close the terminal when you finish, or unset the demo variables before using another OpenClaw profile. For configuration details and maintenance, see the [agent reference](/docs/reference/agent/).
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
7. Use [MCP Protocol Reference](/docs/reference/mcp/) for transport, schemas, curl/SDK examples, and controlled integration checks. [MCP for AI tools](/docs/user/mcp/) is the end-user setup guide.
8. Use [Testing LIME](/docs/reference/verification/) to choose and run checks for your changes.

## Engineering rules

- Keep migrations forward-only and safe for existing self-hosted installs.
- Preserve large-scan behavior: first render should stay bounded, and details should load progressively.
- Prefer Postgres-first read models and indexes before adding new infrastructure.
- Keep report ordering and scope explicit. PDF, small CSV, and LLM text sample occurrences; full CSV streams the full stored scope.
- Update docs and changelog entries for user-facing changes.

Include the checks you ran and any remaining limitations in your pull request. Keep dated test logs and local environment notes in the repository's internal documentation.
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
make init-env  # new checkout and database only; refuses an existing .env
make start-all
\`\`\`

The dashboard defaults to \`http://localhost:3000\`; the backend defaults to \`http://localhost:8080\`. \`make start-dev\` enables dashboard hot reload. Updating source does not require deleting normal database or screenshot volumes.

## Choose checks by changed area

Native checks need Go 1.27.3+ for Shopkeeper and Node 24.22.1+ on the 24.x LTS line, or a newer maintained release with current security patches, for the dashboard. Install locked frontend dependencies with \`npm --prefix lime ci\` or \`npm --prefix docs-site ci\` for the app you are checking. Docker-only startup supplies the application runtimes.

| Change | Checks from the repository root |
| --- | --- |
| Go backend | \`(cd shopkeeper && go test ./...)\`, plus focused race/regression tests for changed concurrency paths. |
| Dashboard | \`npm --prefix lime run lint\` and \`(cd lime && npx --no-install tsc --noEmit)\`. |
| MCP proxy | Dashboard checks and \`npm --prefix lime run test:mcp-transport\`. |
| Update notice | Dashboard checks and \`npm --prefix lime run test:update-notice\`. |
| Marketing/docs | \`npm --prefix docs-site run lint\`, \`(cd docs-site && npx --no-install tsc --noEmit)\`, and \`make docs-verify\`. |
| Cross-stack product behavior | \`make verify-app\` in addition to focused source checks. |
| Release/build/migration | \`make build\` and the release/deployment checks relevant to the change. |

Browser checks need Playwright Chromium: \`(cd docs-site && npx playwright install chromium)\`. The isolated product suite additionally needs Docker Compose, free verification ports, and first-run network access for builds and the pinned stdio bridge. [Testing LIME](/docs/reference/verification/) documents overrides, fixture ownership, cleanup, and coverage.

## Database and documentation changes

Add a new numbered migration rather than editing a released migration. Mirror schema changes in the dashboard's Drizzle schema. A down migration is not a recovery plan for deleted data; consult [Backup and Restore](/docs/reference/deployment/backup-restore/) before operator-facing changes.

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

Shopkeeper owns migrations, scan/result writes, lifecycle actions, Chromium workers, screenshot storage, PDF rendering, and direct MCP authentication/read/action tools. MCP actions reuse those existing lifecycle handlers. The dashboard is not the owner of scan/audit writes.

Shopkeeper also owns the separate link-check job runner, HTTP extraction/validation, target/source-reference persistence, lifecycle actions, and link CSV exports. Standalone jobs and optional scan companions use this runner without changing the accessibility score or screenshot pipeline. See [Link Checker Architecture](/docs/reference/architecture/link-checker/).

## Profiler

Profiler expands sitemap and sitemap-index inputs, resolves and validates eligible URLs, and deduplicates final destinations. Migration \`000020\` saves the sitemap frontier, candidate probe outcomes, and cumulative discovery budgets across ten-minute admissions, pause, and restart. The scanner publishes the complete eligible URL list atomically; no partial list becomes available to Juicer or a companion link check. Historical scans with saved URLs but no discovery row continue normally. Single-page scans skip sitemap discovery.

## Juicer

Juicer visits pages in Chromium, runs axe-core, and captures page/focused/preview screenshots. Each finished page is handed to the scanner for a saved checkpoint before its URL is marked complete. Its page-local network proxy limits simultaneous and total browser connections, plus relayed data (256 MiB per page and 1 GiB across active page proxies). A page that exceeds a limit fails without publishing partial audit evidence. Interrupted work is distinguished from genuine page failures so pause/resume can continue pending URLs.

## Sweetner

Sweetner persists rule outcomes and incomplete occurrences, groups failures into one issue per rule per scan, and appends affected-node occurrences. Resume and failed-page retry can append to existing groups. Failed groups take priority over duplicate needs-review cards; raw audit data remains saved.

## UI

The dashboard reads PostgreSQL for server-rendered pages and owns settings, derived score/issue caches, issue pagination, CSV/LLM generation, and export controls. It proxies lifecycle/screenshot/PDF requests to Shopkeeper. The TypeScript scorer derives weighted rule-level results and coverage from saved audit data; it is not a browser-side count of visible cards.

The dashboard's \`/mcp\` endpoint checks authentication with Shopkeeper, calculates current scores for \`get_scan\`, and serves reports, screenshots, link CSV files, and permitted settings changes. Direct Shopkeeper MCP uses the saved score cache and returns null when that cache is missing or stale. It returns \`requires_dashboard\` for tools provided by the dashboard. Both endpoints default to read-only access; write access is enabled in Settings.

## Lifecycle and persistence boundaries

Pause/resume and failed-page retry keep a scan ID; rescan creates another ID. Large scans yield to other queued scans between discovery or page batches without discarding committed work. Startup recovery keeps saved discovery checkpoints, completed pages, and their evidence, clears only unfinished-page artifacts, and continues under the same ID. Discovery has no cumulative 30-minute stop after migration \`000020\`, though its request, XML, candidate, depth, and per-document caps remain. Persisted paused scans remain paused. Do not use backend restarts as a substitute for Pause.

Scan progress callbacks are serialized to preserve monotonic counters. Concurrent issue-summary cache replacement locks the parent scan row and checks its source timestamp before replacing rows; obsolete or deleted snapshots do not persist cache rows. Keep these guards when changing the paths.

Use the [architecture references](/docs/reference/architecture/ui/) for route/data ownership, [Database](/docs/reference/database/) for schema/migrations, and [Testing LIME](/docs/reference/verification/) for regression evidence and limitations.
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

This guide covers the main editing workflow. The [Docs Site reference](/docs/reference/docs-site/) explains static exports, search, screenshots, custom domains, and GitHub Pages in more detail.

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
- \`docs/\`: operator and technical Markdown, published under \`/docs/reference/...\`. The \`docs/internal/\` directory holds unpublished test logs and contributor notes.
- \`docs-site/content/api.ts\`: explicit typed endpoint manifest for \`/api/\`.
- \`docs-site/content/navigation.ts\`: audience navigation and reading order.
- \`docs-site/public/product-screenshots/\`: committed product evidence images.

Keep user workflows reader-facing and link detailed protocol/implementation material from technical references. The renderer supports Markdown, not executable HTML or MDX. Use a single page title, unique headings, complete fenced examples, and working internal links/anchors.

## Check the export

Run docs lint/type checks and \`make docs-verify\`. Each production build checks content and static routes, links, anchors, assets, and screenshot files. The source guard rejects untracked or ignored docs code files that would be missing in CI; track intended new sources instead of suppressing the guard. Search is rebuilt from all guides and API entries.

Browser verification checks navigation, layout, and site interactions. Use \`make verify-app\` to check the application's scan and report workflows.

## Screenshot refresh

\`make docs\` uses a separate Compose project named \`lime-docs\`, separate PostgreSQL/screenshot volumes, non-default ports, and fresh scans of public demo targets. It must never discover or screenshot normal local scans. It intentionally seeds one failed URL in its own database for the partial-retry screenshot, then creates a fresh standalone single-page link job and waits for completion before capturing checker history/details. The runner receives an explicit \`--link-check-id\` and the export validates all ten product images. Unlike ordinary content work, refresh needs Docker, Chromium, network access, and available ports.

Do not replace this with screenshots of private operator scans. The [Docs Site reference](/docs/reference/docs-site/) documents target overrides, capture assertions, cleanup, and how to add an image.

## GitHub Pages

The Pages workflow builds committed docs content and committed screenshots. CI does not run live scans because external scans are slower and less deterministic.
`,
  },
  {
    slug: ["developer", "performance"],
    title: "Performance and Caching",
    description: "Understand implemented read caches, pagination limits, and PDF concurrency before optimizing.",
    category: "Developer Docs",
    sourceFiles: ["docs/performance.md", "lime/src/lib/scan-issues.ts", "lime/src/lib/scan-score-data.ts"],
    markdown: `# Performance and Caching

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
- Group summary loading still assembles or reads the scan's summary list before slicing it. Its cost therefore grows with the number of issue groups.
- Full CSV streams keyset-paged batches of 5,000 stored occurrences. It avoids one giant occurrence array but still does work proportional to the full export.
- PDF report data is measured before it is loaded into the dashboard. An oversized report stops with a clear error; Full CSV remains available for the same saved-data scope when CSV exports are enabled. This is a data-read limit, not a guarantee about Chromium's memory use.
- \`scan_report_data_cache\` is schema-only reserved infrastructure. \`reportDataCacheTtlSeconds\` persists a value, but no report loader consumes that cache today.
- \`reportGenerationConcurrency\` bounds in-flight PDF requests through response completion per backend process and requests admitted by each UI process. The dashboard queue is bounded and removes cancelled requests. Direct backend PDF requests obey the saved enablement and concurrency settings too; when PDF capacity is busy, they return HTTP 503 with \`Retry-After\`. CSV/LLM exports do not use this limit. It is not a database-wide semaphore.

## Invalidation

Lifecycle/progress updates touch the scan timestamp; false-positive changes also delete score/issue caches; scan deletion cascades cache rows. Report settings are read by the relevant loaders/routes, not an active saved-file cache.

Issue cache replacements lock the parent scan row with \`FOR UPDATE\` and compare the source timestamp before \`DELETE\`/\`INSERT\`. This serializes concurrent empty-cache replacements and prevents an obsolete snapshot from persisting after an update or deletion. Keep both guards and test concurrent misses after triage.

## Measure before changing defaults

Record representative page/group/occurrence counts, hardware, runtime versions, warm/cold cache state, and concurrency alongside timings. Use isolated fixtures or an authorized read-only sample, not destructive work in the operator database. \`make verify-app\` checks correctness; it is not a public-site or thousands-of-pages load benchmark.

\`LIME_PERF_LOG=true\` enables instrumented UI timing logs. See the reference for thresholds and process-local settings/catalog caching. Reserved tables and settings are listed separately above.
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

## Service addresses

| Service (local defaults) | Responsibilities |
| --- | --- |
| Dashboard: \`http://localhost:3000\` | Next settings, issue chunk/detail reads, CSV/LLM accessibility reports, export controls, and canonical \`/mcp\`; proxy routes for scan/link lifecycle, link CSV, screenshots, and PDF. |
| Shopkeeper: \`http://localhost:8080\` | Direct Go scan/link lifecycle, link targets/source paging/CSV, health/version, screenshots, PDF generation, and authenticated MCP reads/actions. Dashboard-owned evidence/settings tools require canonical MCP. |
| Static website: \`http://localhost:3001\` | Marketing/docs only; not an application API or MCP endpoint. |

Do not send a Next-owned request to the Go port merely because its path starts with \`/api\`. Resolve report/screenshot URLs returned by canonical MCP against the dashboard origin. The MCP bearer key protects MCP requests only; it is not dashboard login or authorization for ordinary report/screenshot/API routes. Operator access controls remain a separate deployment concern.

## Compatibility

Prefer additive response fields and preserve existing endpoint names, parameter validation, scope, status codes, and format gates. Scoped exports require both \`kind\` and \`key\`; CSV supports \`mode=small\` or \`mode=full\` (full by default). Disabled dashboard report formats return 403. A full report means the stored report scope, not every page that a failed scan could not audit.

Link checks are a separate \`/api/link-checks\` surface, not new accessibility issue groups. Existing scan payloads remain default-off; \`include_link_check: true\` creates a companion. Link CSV is separate from the accessibility export format gates. Preserve destination/source paging, budget/truncation visibility, and the trusted-root/external-network boundary; see [Link Checker Architecture](/docs/reference/architecture/link-checker/).

## MCP integrations and tests

The [MCP Protocol Reference](/docs/reference/mcp/) contains curl lifecycle requests, schemas, paging, screenshot URL fields, and the standalone \`lime-mcp-client.mts\` SDK example. LIME supports the three 2025 Streamable HTTP protocol revisions, not modern 2026 discovery/capabilities. The direct Go endpoint returns null for a cold/stale score cache; canonical dashboard \`/mcp\` refreshes authenticated \`get_scan\` results through the existing scorer.

With the docs-site dependencies installed, set \`LIME_MCP_URL\` and \`LIME_MCP_KEY\`, then run \`npm --prefix docs-site run verify:mcp\`. This reads existing results without changing settings or creating jobs. Set \`LIME_MCP_SCAN_ID\` or \`LIME_MCP_LINK_CHECK_ID\` to check particular records; otherwise the latest available records are used.

Use \`LIME_MCP_SDK=v2\` to check the split-package SDK in legacy negotiation mode. The output lists the tools actually called, which depends on the saved data available in the instance.

Run \`npm --prefix lime run test:mcp-transport\` and \`npm --prefix lime run test:mcp-dashboard-tools\` for changes to the dashboard MCP route. Use \`make verify-app\` for a complete test with the browser, backend, database, and MCP clients. [Testing LIME](/docs/reference/verification/#mcp-and-ai-client-checks) also covers focused client and settings-lock checks.

## Errors and retries

Inspect both HTTP errors and the MCP tool's \`isError\` field. A successful HTTP response can still contain a tool error. Keep the original request ID when recovering a create, rescan, or recheck request, and read saved state before retrying an uncertain action. A new-ID rate denial includes \`http_status: 429\`, \`retry_with_same_request_id: true\`, and \`retry_after_utc\`; no reservation or job exists, so retry the same ID and arguments after the UTC day resets. A confirmed queue-full response for a new-job action includes \`retry_with_new_request_id: true\` and \`retry_after_seconds: 30\`; no job started, so wait and use a new ID. Resume and failed-page retry use the existing scan ID instead.

Native saved-data reads share two Shopkeeper slots per process through database reads, encoding, and HTTP delivery. They preflight selected stored TEXT/JSONB under one read-only repeatable-read snapshot, using a conservative weighted 32 MiB budget across a call rather than an exact wire-size cap. Oversized selections return HTTP 200 with \`isError: true\` and \`structuredContent.http_status: 413\`, without partial results; request fewer results or use the dashboard. Busy native reads return plain JSON HTTP 503 with \`Retry-After: 1\` and no JSON-RPC ID.

Every MCP authentication settings read uses a separate process-wide two-slot gate and a fresh read-only READ COMMITTED transaction, never the saved-data snapshot, preserving live key revocation and permission checks after timeout setup. Busy or unavailable authentication before dispatch returns plain JSON HTTP 503 with \`Retry-After: 1\` and no JSON-RPC ID; no action has been dispatched. These checks run separately from action execution and permanent replay.

Native scan, link-check, and issue-triage actions, including replay, use a separate two-slot process gate. Busy admission returns plain JSON HTTP 503 with \`Retry-After: 1\` and no RPC ID before any reservation or action; retry with the same ID and arguments. Action database reads share a conservative 32 MiB selected-data estimate and use READ COMMITTED transactions. Saved replay responses above 2 MiB are not fetched into the application. Action tool results above 4 MiB, including text and structured content but excluding the separately bounded RPC ID, return a tool error with \`http_status: 413\`. The permanent request record stays unchanged and the action is not rerun. Inspect saved state in the dashboard. Malformed historical responses also fail without rerunning the action. Dashboard-owned settings changes have their own limits.

Saved-data, authentication, and native action database phases use 30-second contexts and shrinking SQL timeouts. Interrupted queries or uncertain cleanup retain the respective slot for the last configured SQL interval, at most another 30 seconds after cleanup. Actions keep a detached five-second attempt to save an observed result after disconnection. Native saved-data and action delivery then have a separate 30-second HTTP write deadline. These phases are not a total request limit. An interrupted action may already have completed; inspect its saved state and keep the original request ID. Ordinary API reads and worker execution are unchanged by these MCP limits.

Dashboard score queries and artifact reads have separate deadlines and capacity. Score calculations and CSV/text report preparation share a two-request database limit; a busy tool returns a one-second retry hint. Successful score calculations keep the saved cache up to date. Settings writes use PostgreSQL lock and statement timeouts and wait for commit or rollback. If a settings response is lost, reread the settings before retrying. See the [MCP Protocol Reference](/docs/reference/mcp/) for timeout behavior and response fields.

Update the API manifest, protocol reference, user guide, and relevant tests when changing an endpoint.
`,
  },
];
