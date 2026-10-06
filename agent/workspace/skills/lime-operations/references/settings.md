# Scoped reporting and performance settings

Use canonical dashboard `/mcp`. Read `get_settings`, describe the specific proposed field change and instance-wide effect, and obtain explicit human authorization before sending `update_settings` with `confirm: true`. Change only approved flat snake_case fields; omitted fields stay unchanged.

| Fields | Values |
| --- | --- |
| `full_pdf_occurrence_limit`, `single_issue_pdf_occurrence_limit`, `small_csv_occurrence_limit`, `llm_occurrence_limit` | Integers 1–20,000. |
| `pdf_reports_enabled`, `csv_reports_enabled`, `llm_reports_enabled` | Booleans. |
| `summary_cache_ttl_seconds`, `report_data_cache_ttl_seconds` | Whole seconds 5–86,400. |
| `report_generation_concurrency` | Integer 1–10. |

Include at least one approved field. Do not send nested `reporting`/`performance` objects, key fields, `mcpAllowWrites`, integration settings, or browser preferences. Do not expand a request to fetch a disabled report into permission to enable that format. Report-data cache TTL is reserved infrastructure, not an active report cache; PDF concurrency is per dashboard process, not a universal export throttle.

Success uses `{ action: "update_settings", http_status: 200, settings }`, not the lifecycle action's `data` field. Read `get_settings` again and compare the intended values and unchanged fields. Do not change unrelated settings or promise a performance gain from a successful save alone.

The server awaits actual commit/rollback and uses transaction-local lock/statement timeouts. These do not bound every network/pool wait or the entire RPC. A lost response does not mean the write was cancelled: reread before retrying. Do not blindly send another patch or claim rollback without observed evidence.
