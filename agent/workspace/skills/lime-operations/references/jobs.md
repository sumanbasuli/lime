# New jobs and durable response recovery

## Plan the bounded job

| Canonical tool | Required fields | Relevant choices |
| --- | --- | --- |
| `create_scan` | `request_id`, `sitemap_url` | `scan_type`: `sitemap` or `single`; `viewport_preset`: `desktop`, `laptop`, `tablet`, `mobile`; optional `tag`; `include_link_check` defaults false. |
| `rescan_scan` | `scan_id`, `request_id` | Fresh scan copies the original target/type/viewport/tag/companion choice; original evidence remains and normal false-positive inheritance applies. |
| `create_link_check` | `request_id`, `url` | `check_type`: `crawl` or `single`; `max_pages` 1–500, default 100; single mode uses 1. |
| `recheck_link_check` | `check_id`, `request_id` | Fresh check from an eligible completed/failed/cancelled snapshot; companion checks reuse saved scan-page inventory. |

Generate a fresh UUID with an available trusted client UUID generator for an intentionally new action; do not invent a malformed ID or copy a documentation example. If no generator is exposed, ask the operator to supply a fresh UUID, for example by running `node agent/scripts/request-id.mjs` from the LIME checkout. Do not attempt shell execution when the host denies it. Before submission retain the ID, tool, and exact arguments in approved private task state so a lost response is recoverable. Do not include a key in that state. If durable task state is unavailable, retain the ID in the current conversation and make the recovery limitation clear before long-running work.

URLs must be absolute HTTP(S), at most 4,096 characters, without userinfo, fragments, or surrounding whitespace. Tags are nonempty and at most 256 characters. Use the user's requested single page versus sitemap/crawl choice; do not expand a page request into a site-wide scan. Add a companion only when requested; it is an independent link workflow, not an accessibility scoring feature.

For normal action success, inspect `{ action, http_status, data, request_id, replayed }`, retain the actual returned job UUID, and read `get_scan`/`get_link_check`. Poll with a budget until completion/failure or report the last observed state. For scan companions, use `get_scan_link_check` and inspect its separate status/coverage; accessibility completion does not prove the companion completed.

## Lost or uncertain response

1. Do not assume failure means no job exists, and do not generate a replacement UUID.
2. Recover the recorded original UUID/arguments and inspect saved history/state with `list_scans`/`list_link_checks` plus exact-ID reads when an ID was observed. Compare target, timestamps, type, tag, viewport, and companion choice; a merely similar target is not proof of identity.
3. When the original operation and all exact arguments are available, one same-ID recovery call can retrieve a lost completed result. A completed identical request replays the stored response with `replayed: true`. Never switch tools or alter arguments under that ID; a conflict is not permission to start again. This is response recovery, not a new action or an indefinite retry loop.
4. If that recovery returns an in-progress/uncertain reservation, unavailable saved response, or `idempotency_warning`, execution may already have happened. Preserve the warning and any returned ID. The server will not automatically re-execute that reservation. Stop repeat submissions, reconcile saved evidence, and ask for direction if identity/outcome remains unclear.
5. Only use a new UUID for a deliberately new, human-authorized job after reconciliation. Do not claim exactly-once completion after arbitrary crashes; the durable ledger prevents blind duplicate re-execution but cannot prove every crash outcome.

No internal ledger administration or SQL repair is exposed via these skills. Escalate unresolved state to the operator rather than deleting reservations or bypassing the endpoint.
