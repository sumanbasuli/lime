# Docs Site

The public LIME docs site lives in `docs-site/`. It is a static Next export designed for GitHub Pages and for the future `lime.heysuman.com` custom domain. It is separate from the dashboard app in `lime/` and has no runtime database dependency after it is built.

## What It Publishes

The docs site combines four content sources:

1. Product pages in `docs-site/app`, such as the homepage, get-started page, screenshots page, roadmap page, and API reference page.
2. Curated user and developer docs in `docs-site/content/product-docs.ts`.
3. Repository Markdown docs from `docs/`, rendered under `/docs/reference/...`.
4. Committed product screenshots in `docs-site/public/product-screenshots/`.

The public docs build is a static export. CI builds the site and uploads `docs-site/out` to GitHub Pages. CI does not run scans or regenerate screenshots because external scan results are slower and less deterministic.

## Commands

```bash
make docs-dev      # hot-reload docs development server on LIME_DOCS_PORT, default 3001
make docs-build    # build the static docs site into docs-site/out
make docs-run      # build and serve docs-site/out locally
make docs          # refresh isolated demo screenshots, then build the static site
```

Use `make docs` before release-facing docs changes when screenshots may be stale. Use `make docs-build` for fast validation when content or layout changed but screenshots did not.

## Local Development Shape

The docs site is a normal Next app with static export enabled in `docs-site/next.config.ts`.

- `output: "export"` writes static HTML/assets to `docs-site/out`.
- `trailingSlash: true` keeps GitHub Pages routes predictable.
- `LIME_DOCS_BASE_PATH` can add a project-site base path such as `/lime`.
- `NEXT_PUBLIC_LIME_DOCS_URL` controls canonical metadata and public docs links.
- `docs-site/scripts/prepare-assets.mjs` copies shared brand assets into `docs-site/public/brand/` before build.

For the custom domain, keep `LIME_DOCS_BASE_PATH` empty and publish `docs-site/public/CNAME`. For a GitHub Pages project URL such as `https://sumanbasuli.github.io/lime/`, set `LIME_DOCS_BASE_PATH=/lime`.

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
3. Update `docs-site/content/navigation.ts` when the page should appear explicitly in the public sidebar.
4. Update `docs/index.md` when the page should appear in the repository documentation map.
5. Run `npm --prefix docs-site run lint` and `make docs-build` for content-only changes.

For curated pages in `docs-site/content/product-docs.ts`:

1. Add a `ProductDoc` entry with `slug`, `title`, `description`, `category`, optional `screenshots`, optional `sourceFiles`, and `markdown`.
2. Keep user workflow pages under `slug: ["user", "..."]`.
3. Keep contributor pages under `slug: ["developer", "..."]`.
4. Add screenshot IDs to the page's `screenshots` field when the right rail should reference them.
5. Add Markdown images directly in the body when the screenshot is part of the step-by-step instructions.

For repo Markdown pages under `docs/`:

1. Add the Markdown file in the correct folder.
2. Use a single `#` heading because the docs site uses it as the page title.
3. Add the page to `docs-site/content/navigation.ts` if it belongs in the public reference sidebar.
4. Link it from `docs/index.md` so contributors can discover it without the static site.

Search is automatic for both curated docs and repo Markdown docs because `docs-site/lib/docs-search.ts` reads the full docs page list at build time.

## API Reference

The public API page is generated from the typed manifest in `docs-site/content/api.ts`. Do not scrape route files for API docs. The manifest is intentional because it forces each public endpoint to declare method, path, title, auth expectation, body shape, response summary, and notes.

When API behavior changes:

1. Update the Shopkeeper route/handler.
2. Update any dashboard proxy or client code.
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

1. Installs docs-site dependencies if needed.
2. Installs Playwright Chromium for screenshot capture.
3. Resets an isolated Docker Compose project named `lime-docs`.
4. Starts an isolated PostgreSQL database, Shopkeeper, and production-built dashboard UI from `docker-compose.docs.yml`.
5. Creates fresh docs-demo scans from public demo targets.
6. Selects the scan with the richest issue data for issue screenshots.
7. Seeds exactly one intentional failed URL into a completed docs-demo scan for partial-retry screenshots.
8. Captures screenshots with `docs-site/scripts/capture-screenshots.mjs`.
9. Builds the static docs site.
10. Stops the isolated docs stack unless `LIME_DOCS_KEEP_STACK=true`.

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
3. Add an `afterLoad` assertion for the important UI state, such as a heading, button, issue card, menu, or expanded panel. The script should fail when the expected state is missing.
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

The workflow intentionally does not run `make docs`. Screenshots should be refreshed locally and committed.

## Handoff Checklist

Before handing off a docs-site change:

1. Run `npm --prefix docs-site run lint`.
2. Run `NEXT_PUBLIC_LIME_DOCS_URL=https://lime.heysuman.com/ npm --prefix docs-site run build`.
3. Run `make docs` when screenshot content changed.
4. Confirm `docs-site/out/index.html` exists after build.
5. Confirm custom-domain builds do not include a stale `/lime` base path.
6. Update `CHANGELOG.md` for release-facing docs changes.
7. Do not push until the maintainer explicitly asks.
