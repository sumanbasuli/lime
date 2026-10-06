# Saved accessibility evidence

## Locate and inspect a scan

Use the user-specified scan UUID when supplied. Otherwise call `list_scans` with a bounded page and select by the requested target/status/time; do not silently equate the latest scan with the latest completed scan. `list_scans` returns `scans`, `limit`, and `offset`, without `total` or `has_more`. For a broader search, advance by the returned number of scans and stop at a short/empty page or the task budget. Concurrent changes can shift offset pages; disclose that when an exhaustive inventory matters.

Call `get_scan` for the selected UUID. Read `scan.status`, target/type, viewport, progress, timestamps, and `score_summary`. The canonical endpoint enriches scoring using the dashboard scorer. A null/unavailable summary is not score zero. Inspect `is_partial_scan`, `has_full_coverage`, failed/completed page counts, and audit-data flags before interpreting scores. Completed work can still be partial; automated scanning is not a complete accessibility-conformance assessment.

## Groups, occurrences, and comparisons

1. Call `list_scan_issues` with the same `scan_id`. It returns `issues`, `total`, `limit`, and `offset`. Advance by the returned group count until the offset reaches `total`, an empty page occurs, or the task budget is reached; report inconsistent totals rather than loop indefinitely.
2. Keep each group's `kind`, `key`, severity, occurrence count, rule, and `is_false_positive`. `failed` keys are issue UUIDs; `needs_review` keys are rule IDs. Do not substitute a rule ID for a failed issue UUID.
3. Call `get_issue_detail` using the group's exact `kind` and `key`. The result is under `detail`; use `detail.has_more`, `occurrence_offset`, and `occurrence_limit`. Stop immediately when `has_more` is false, even if a historical summary count is larger than the retained occurrence list. If `has_more` is true but no occurrences are returned, report inconsistent/incomplete evidence rather than retry forever.
4. Attribute occurrences to their saved `page_url`, selector, and captured snippet. Summaries with no saved node evidence remain count-only findings; do not fabricate selectors, HTML, or screenshots.

For comparisons, align target, scan type, viewport, coverage, timestamps, and triage state before describing a trend. Marking a false positive can change filtered counts without changing the numeric score. `score_summary.excluded_count` is a reserved compatibility field, not a count of false-positive groups; use `is_false_positive` and filtered audit counts instead.

## Images and companion checks

Occurrence `screenshot_url` and `element_screenshot_url` resolve on the dashboard. Their existence in metadata does not prove a saved file is readable. Server paths such as `/app/screenshots/...` are not HTTP URLs. The `lime-evidence` skill uses a saved basename and the owning scan UUID with `get_screenshot`.

Call `get_scan_link_check` when companion evidence is relevant. The original `include_link_check` selection can remain true after a companion is deleted. Successful `check: null` means this existing scan currently has no companion; it is not a failed lookup and does not authorize creation. A nonexistent scan returns an error. A companion has its own progress/coverage/outcomes and does not change the accessibility score.
