# Retrieve the requested artifact

## Accessibility reports

Use `get_report_metadata` with `scan_id` to inspect availability and paths. An available flag does not guarantee runtime generation will succeed. Call `get_report` with the same scan UUID and `format` exactly `pdf`, `csv`, or `llm` only when the task calls for actual content.

Choose one scope:

- Scan-wide: omit `issue_id`, `kind`, and `key`.
- Failed issue: supply the `issue_id` UUID from that scan's failed groups, or the complete `kind: "failed"` and its UUID `key`.
- Manual-review group: supply `kind: "needs_review"` and the exact rule `key` from that scan's `list_scan_issues` result.

Never combine `issue_id` with `kind`/`key`, send only half that pair, use another scan's issue, or guess an unknown group. Unknown scope fails; do not broaden it to the whole scan as a workaround. For CSV, `csv_mode: "small"` (default) samples occurrences; `"full"` requests full CSV and may exceed the MCP byte cap. This option does not change audit scope. PDF/LLM occurrence limits remain configured limits, not proof that all retained occurrences are included.

## Saved screenshots

Read `get_issue_detail` for the owning scan/group. Choose the full-page or element screenshot explicitly supported by its saved occurrence fields. Extract only the saved basename from `screenshot_url`, `element_screenshot_url`, or a saved screenshot path; never treat a filesystem path as a URL or use a filename from another scan.

Call `get_screenshot` with `scan_id` and `filename`. A basename is at most 256 characters, starts with a letter/number, contains only letters/numbers/underscore/hyphen/period, and must not contain `..`. No URL, slash, traversal, arbitrary path, or file search is accepted. Missing metadata/file is unavailable evidence, not permission to fabricate a screenshot, crawl another site, or inspect the server filesystem.

## Saved link CSV

Read `get_link_check` or the scan's actual companion with `get_scan_link_check`, then call `get_link_check_export` with the observed `check_id`. Export reflects saved results and retained source coverage at that job's time, regardless of whether the job contains errors or truncation. It does not recheck destinations or affect accessibility scoring. Preserve raw categories/codes and keep inconclusive, blocked, or unchecked targets separate from confirmed broken outcomes.

## Failed or too-large materialization

Preserve `isError`, any `http_status`/`download_path`, and the distinction between unavailable artifact and failed audit result. Metadata alone is not downloaded content. A bounded transient read retry can be appropriate after checking connectivity/availability, but do not alter settings, manufacture a new job, or use a different target to make it pass. For an oversized export, offer an explicitly requested narrower scope/sampled format, or an operator-controlled full download; disclose the change in evidence scope.
