# Docs Site

The public LIME website and docs live in `docs-site/` and are published at [lime.heysuman.com](https://lime.heysuman.com/) and [lime.heysuman.com/docs](https://lime.heysuman.com/docs/). They are a static Next export deployed through GitHub Pages. This app is separate from the dashboard in `lime/` and has no runtime database dependency after it is built.

## What It Publishes

The docs site combines four content sources:

1. Product pages in `docs-site/app`, such as the homepage, get-started page, screenshots page, roadmap page, and API reference page.
2. Curated user and developer docs in `docs-site/content/product-docs.ts`.
3. Repository Markdown docs from `docs/`, rendered under `/docs/reference/...`.
4. Committed product screenshots in `docs-site/public/product-screenshots/`.

The public docs build is a static export. CI builds the site and uploads `docs-site/out` to GitHub Pages. CI does not run scans or regenerate screenshots because external scan results are slower and less deterministic.

## Commands

From the repository root, install the locked dependencies with `npm --prefix docs-site ci`. The docs CI uses Node 24; use a supported Node version compatible with the lockfile. Keep Bash on `PATH`: every production build and `test:docs-content` run uses `bash -n` to syntax-check shell examples without executing them. Browser checks also need Playwright Chromium (`cd docs-site && npx playwright install chromium`). Screenshot refresh and product verification additionally need Docker with Compose and curl; ordinary content development/building does not need the scan stack.

```bash
make docs-dev      # hot-reload docs development server on LIME_DOCS_PORT, default 3001
make docs-build    # build the static docs site into docs-site/out
make docs-run      # build and serve docs-site/out locally
make docs-verify   # build, validate, and browser-check desktop/mobile routes and interactions
make docs          # refresh isolated demo screenshots, then build the static site
npm --prefix docs-site run test:docs-content  # navigation, reading order, and renderer regressions
```

Use `make docs` before release-facing docs changes when screenshots may be stale. Use `make docs-build` for fast validation when content or layout changed but screenshots did not. Use `make docs-verify` for the complete local static-export and browser verification pass. Use `make docs-run` for GitHub Pages parity: it builds the static export first, then serves `docs-site/out` instead of running the Next development server.

## Local Development Shape

The docs site is a normal Next app with static export enabled in `docs-site/next.config.ts`.

- `output: "export"` writes static HTML/assets to `docs-site/out`.
- `trailingSlash: true` keeps GitHub Pages routes predictable.
- `LIME_DOCS_BASE_PATH` can add a project-site base path such as `/lime`.
- `NEXT_PUBLIC_LIME_DOCS_URL` controls canonical metadata and public docs links.
- `docs-site/scripts/prepare-assets.mjs` copies shared brand assets into `docs-site/public/brand/` before build.
- `npm run dev` prepares shared brand assets before starting, so the local site does not render broken logos.
- `make docs-build` checks for untracked or ignored CSS/JavaScript/TypeScript sources under the docs app, components, content, library, and scripts before building. This catches local-only source files that could make `make docs-run` look correct while CI deploys a missing route; it is not a check that all documentation edits have been committed.
- Every production build runs `docs-site/scripts/verify-content.mjs` and `validate-static-export.mjs` after export. Content checks cover complete navigation, audience reading order, and renderer regressions; static-export checks cover required routes, internal links and section anchors, unique heading IDs/titles, assets, and product screenshot sizes.

For the custom domain, keep `LIME_DOCS_BASE_PATH` empty and publish `docs-site/public/CNAME`. For a GitHub Pages project URL such as `https://sumanbasuli.github.io/lime/`, set `LIME_DOCS_BASE_PATH=/lime`.

To preview a project-path export locally, run `LIME_DOCS_BASE_PATH=/lime make docs-run` and open `http://localhost:3001/lime/`. Use the same environment value for build, serve, and `make docs-verify`. Rebuild with the variable unset to return to the normal root-path preview.

## Content Model

Curated product docs live in `docs-site/content/product-docs.ts`. Use these for user-facing, screenshot-rich docs that should be carefully written and ordered.

Repo Markdown docs live in `docs/`. They are read by `docs-site/lib/docs.ts`, rendered with `docs-site/lib/markdown.ts`, and exposed under `/docs/reference/...`.

Examples:

- `docs/setup.md` becomes `/docs/reference/setup/`.
- `docs/deployment/docker.md` becomes `/docs/reference/deployment/docker/`.
- `docs/docs-site.md` becomes `/docs/reference/docs-site/`.

Keep `docs/index.md` as the source map for repository maintainers. Keep `docs-site/content/navigation.ts` as the public sidebar map.

## Add A New Docs Page

Choose the content path based on the audience:

1. Use `docs-site/content/product-docs.ts` for user-facing or developer-facing pages that need careful ordering, screenshots, source references, and product copy.
2. Use a Markdown file under `docs/` for repository reference material, architecture notes, deployment details, and contributor handoff docs.
3. Register every guide in `docs-site/content/navigation.ts` under the right audience. The build rejects guides missing from navigation.
4. Update `docs/index.md` when the page should appear in the repository documentation map.
5. Run `npm --prefix docs-site run lint`, `(cd docs-site && npx tsc --noEmit)`, and `make docs-build` for content-only changes. Use `make docs-verify` for rendered navigation, search, and responsive checks.

For curated pages in `docs-site/content/product-docs.ts`:

1. Add a `ProductDoc` entry with `slug`, `title`, `description`, `category`, optional `screenshots`, optional `sourceFiles`, and `markdown`.
2. Keep user workflow pages under `slug: ["user", "..."]`.
3. Keep contributor pages under `slug: ["developer", "..."]`.
4. Keep related screenshot IDs in the page's optional `screenshots` metadata. The current page renderer does not display this metadata in the right rail.
5. Add Markdown images directly in the body to display screenshots in the step-by-step instructions. The right rail displays headings and source references.

For repo Markdown pages under `docs/`:

1. Add the Markdown file in the correct folder.
2. Use a single `#` heading because the docs site uses it as the page title.
3. Register the page in `docs-site/content/navigation.ts` under the appropriate operator, developer, or technical-reference group.
4. Link it from `docs/index.md` so contributors can discover it without the static site.

Search is automatic for both curated docs and repo Markdown docs because `docs-site/lib/docs-search.ts` reads the full docs page list at build time.

The repository renderer supports headings, paragraphs, links, images, lists, tables, and fenced code blocks. It is not an MDX renderer: raw HTML is escaped rather than executed, so do not use HTML disclosure widgets or interactive components inside Markdown. Keep long implementation records after reader-facing instructions and link to their section headings.

## API Reference

The public API page is generated from the typed manifest in `docs-site/content/api.ts`. Do not scrape route files for API docs. The manifest is intentional because it forces each public endpoint to declare method, path, title, auth expectation, body shape, response summary, and notes.

When API behavior changes:

1. Update the owning route/handler: Shopkeeper owns scan actions and MCP tools; the dashboard owns settings, issue pagination, export controls, and the canonical MCP proxy.
2. Update any affected dashboard proxy or client code.
3. Update `docs-site/content/api.ts`.
4. Run `make docs-build`.

## Search

The `/docs/` layout includes a command-style search popup. It currently uses a static build-time index from `docs-site/lib/docs-search.ts`.

The search index includes:

- Curated product docs.
- Repository Markdown docs from `docs/`.
- The typed API manifest.

This keeps search fast, offline, static-export friendly, and custom-domain safe without requiring a separate indexing step. Pagefind can be introduced later if the docs corpus becomes large enough to need a dedicated static search index.

## Screenshot Pipeline

`make docs` is the canonical screenshot refresh command. It must never use the normal local development stack or existing local scans.

The command runs `scripts/docs-refresh.sh`, which:

1. Validates required commands, ports, and scan-target URLs.
2. Reinstalls docs-site dependencies from the lockfile and runs ESLint before starting Docker.
3. Verifies that Playwright Chromium is available.
4. Resets an isolated Docker Compose project named `lime-docs`.
5. Starts an isolated PostgreSQL database, Shopkeeper, and production-built dashboard UI from `docker-compose.docs.yml`.
6. Creates fresh docs-demo scans from public demo targets and skips scans that produce no completed page.
7. Selects the scan with the richest issue data for issue screenshots.
8. Seeds exactly one intentional failed URL into a completed docs-demo scan for partial-retry screenshots.
9. Captures screenshots with browser, framework-overlay, expected-element, response, and file-size checks.
10. Builds the static docs site and validates every required route, internal link, asset, and screenshot in the export.
11. Stops the isolated docs stack on success or failure unless `LIME_DOCS_KEEP_STACK=true`.

The default demo targets are:

```text
https://heysuman.com
https://www.fake-university.com/
https://overlaysdontwork.com/
```

Override them with:

```bash
LIME_DOCS_SCAN_TARGETS="https://example.com,https://another.example" make docs
```

## Partial Retry Screenshot

The retry screenshot must show actual retry UI, not just a generic scan detail page. To make this deterministic, `scripts/docs-refresh.sh` seeds one failed URL into the isolated docs scan after a real page has completed.

The seeded URL is derived from the scan target origin:

```text
<target-origin>/__lime-docs-intentional-failed-page
```

The script updates only the isolated `lime-docs` database. It does not touch the normal local database, screenshots, or user scans. It also clears derived read caches for that scan so the dashboard recomputes partial coverage before screenshots are captured.

`docs-site/scripts/capture-screenshots.mjs` receives two scan IDs:

- `--scan-id` for rich issue screenshots.
- `--partial-scan-id` for `partial-retry.png`.

The screenshot capture fails if the partial-retry page does not show `Partial scan recovery` and the `Retry failed pages` button. This makes broken retry screenshots visible during `make docs`.

## Screenshot Files

Screenshots are committed under `docs-site/public/product-screenshots/` so CI can build without running live scans.

Current screenshot IDs are defined in `docs-site/content/screenshots.ts`:

- `dashboard`
- `new-scan`
- `scan-detail`
- `partial-retry`
- `issues`
- `expanded-issue`
- `reports`
- `settings`
- `link-checker`

If you add a screenshot:

1. Add the capture step in `docs-site/scripts/capture-screenshots.mjs`.
2. Add metadata in `docs-site/content/screenshots.ts`.
3. Use it from `docs-site/content/product-docs.ts` or a public page.
4. Run `make docs`.

## Request A Screenshot From `make docs`

Screenshots should be requested through code, not captured manually from a developer's local dashboard. This keeps docs screenshots reproducible and prevents accidental capture of private scans.

To add a screenshot request:

1. Decide which isolated docs-demo scan should drive the screenshot. Use `--scan-id` for the rich issue scan and `--partial-scan-id` for partial retry UI.
2. Add a `capture(...)` call in `docs-site/scripts/capture-screenshots.mjs` with the exact dashboard route and output filename.
3. Add an `afterLoad` assertion for the important UI state, such as a heading, button, issue card, menu, or expanded panel. The capture runner also fails on blank pages, framework overlays, HTTP 5xx responses, browser errors, and unexpectedly small image files.
4. If the screenshot needs special data, add deterministic setup in `scripts/docs-refresh.sh` against only the `lime-docs` Compose project and isolated database.
5. Add screenshot metadata in `docs-site/content/screenshots.ts`.
6. Reference the screenshot from a curated doc's `screenshots` list and, when useful, as an inline Markdown image.
7. Run `make docs` to regenerate screenshots and rebuild the static site.

Do not add screenshot capture steps that browse the normal local dashboard, discover arbitrary scans, or depend on private customer data. `make docs` must only use the isolated docs stack and the public demo targets configured for docs generation.

## GitHub Pages Workflow

`.github/workflows/docs-pages.yml` builds and deploys the static docs site.

The workflow:

1. Checks out the repo.
2. Sets up Node.
3. Installs `docs-site` dependencies.
4. Builds the static site.
5. Uploads `docs-site/out`.
6. Deploys through GitHub Pages actions.

The build includes content and static-export validation. The workflow intentionally does not run `make docs` or the browser verification suite. Screenshots should be refreshed locally and committed; run lint/type checks and `make docs-verify` locally before handing off changes.

The local browser verifier enumerates exported documentation routes and the main website pages at desktop/mobile widths. It also checks user-guide reading order, search, mobile navigation/table of contents, and screenshot gallery interactions. Results and representative screenshots are written under the ignored `.artifacts/verification/` directory. A new route or guide changes the coverage count; record the count from a completed run rather than copying an older verification record.

## Handoff Checklist

Before handing off a docs-site change:

1. Run `npm --prefix docs-site run lint`.
2. Run `NEXT_PUBLIC_LIME_DOCS_URL=https://lime.heysuman.com/ npm --prefix docs-site run build`.
3. Run `make docs` when screenshot content changed.
4. Run `make docs-verify` for desktop/mobile routes plus search, navigation, and screenshot interaction checks.
5. Run `make docs-run` when debugging a GitHub Pages routing issue locally.
6. Confirm `docs-site/out/index.html` exists after build.
7. Confirm the post-build static-export validator reports all internal routes, assets, and screenshots as valid.
8. Confirm custom-domain builds do not include a stale `/lime` base path.
9. Update `CHANGELOG.md` for release-facing docs changes.
10. Do not push until the maintainer explicitly asks.
