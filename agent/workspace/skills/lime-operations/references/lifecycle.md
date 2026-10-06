# Existing job lifecycle and triage

Read the exact saved object and current capabilities before acting. Use discovered schemas; all scan/check/issue IDs are UUIDs. Business eligibility errors are evidence about current state, not permission to broaden the workflow.

## Accessibility jobs

| Tool | Arguments | Verify and preserve |
| --- | --- | --- |
| `pause_scan` | `scan_id` | Request cooperative pause; read `get_scan` until the requested/actual state is clear. In-flight pages may finish. |
| `resume_scan` | `scan_id` | Resume an eligible paused scan under the same ID; completed page work remains. Verify accepted state then bounded progress. |
| `retry_failed_pages` | `scan_id` | Retry failed pages on an eligible completed partial scan under the same ID. It contacts targets; authorization must include retrying work. Read coverage after completion. |
| `delete_scan` | `scan_id`, `confirm: true` | Destructive: eligible saved scan results, screenshots, and companion are removed. Active scans cannot be deleted; do not pause/cancel other work implicitly to force eligibility. A paused scan may be eligible, so do not treat pause as protection from deletion. Verify absence without re-creating anything. |

`rescan_scan` is a new job, not resume/retry; follow the request-ID workflow in [jobs.md](jobs.md). Preserve the original unless deletion is separately authorized.

## Link jobs

| Tool | Arguments | Verify and preserve |
| --- | --- | --- |
| `cancel_link_check` | `check_id` | Cooperatively cancel queued/running work and retain saved results. Poll `get_link_check`; accepted cancellation is not proof of immediate stop. |
| `delete_link_check` | `check_id`, `confirm: true` | Delete terminal check results/sources, not its parent accessibility scan. Active checks must be cancelled first, but cancellation needs its own scoped authorization. Verify absence; a scan's historical include-link selection can remain true with no current companion. |

`recheck_link_check` creates a fresh snapshot; follow [jobs.md](jobs.md), and do not substitute it for reading an existing export.

## False-positive triage

Read `list_scan_issues` and the relevant `get_issue_detail` in the owning scan. Only a failed issue UUID is eligible; needs-review rule IDs are not failed issue IDs. Require the user's decision to mark/restore, or clear scoped delegation of that triage decision with adequate evidence; an automated failure alone is not proof of a false positive.

Call `mark_issue_false_positive` with `scan_id`, `issue_id`, and explicit `false_positive: true` to mark or `false` to restore. Re-read issue state and canonical `get_scan` scoring after success. Report actual filtered counts; some rules have no scoring weight, so a mark need not change the numeric score. Do not infer affected counts from the reserved `excluded_count` field.

## Ambiguous responses

These lifecycle/triage writes do not have the durable new-job request ledger. After a timeout/lost response, reread the saved object and determine whether the requested state already holds before considering another call. For deletion, a confirmed not-found result can support absence; unavailable transport/data cannot. Never turn a failed read into a successful deletion claim.
