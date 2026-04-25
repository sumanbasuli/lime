# Performance And Caching Strategy

LIME's `v1.0` performance strategy is PostgreSQL-first. The goal is to make large scans fast to inspect and export without adding another required service for self-hosted operators.

## Priorities

The first optimization pass targets read and report latency:

- dashboard recent scans and score summaries
- scan detail score and coverage summaries
- issue page first render
- issue chunk and detail endpoints
- PDF, CSV, and LLM report input loading

Scan throughput remains important, but it comes after the large-report read paths are bounded and measurable.

## Cache Model

Use PostgreSQL as the durable cache/read-model layer for `v1.0`.

Derived data:

- per-scan score and coverage summaries
- per-scan issue-card summaries for failed and needs-review checks
- report-input metadata keyed by scan, scope, format, and settings fingerprint

Use in-process caches only for low-churn shared data:

- ACT catalog
- axe rule metadata
- server-wide settings

Redis is intentionally deferred until profiling proves a concrete need that PostgreSQL read models and indexes cannot satisfy.

## Invalidation

Derived data must refresh or invalidate when:

- a scan completes
- a failed-page retry finishes
- false-positive state changes
- report-shaping settings change
- a scan is deleted

Occurrence detail queries should remain live and paginated. The UI should not rebuild a full issue list in memory just to serve the first page of issue cards.

## Settings

Performance settings should stay minimal:

- summary cache TTL
- report-data cache TTL
- report generation concurrency cap

Defaults should work for a small self-hosted server without operator tuning.

## Verification

Before and after optimization work, measure:

- dashboard load time
- scan detail score summary load time
- issue page initial render time
- issue chunk response time
- issue detail response time
- full PDF generation time
- scoped issue PDF generation time

Large-scan checks should use an existing scan with thousands of pages and high occurrence counts.

Set `LIME_PERF_LOG=true` on the UI process to log every instrumented hot-path timing. Without that flag, development builds log only slow hot-path operations above their route-specific threshold.
