# Durable sitemap discovery checkpoint plan

Status: implemented in this branch with migration `000020`. This is the original design and acceptance record; the Go code, migration, and deployment guide describe the current behavior. No production deployment is claimed here.

## Contract and former behavior

Before migration `000020`, Profiler performed a complete recursive sitemap walk and then probed page URLs in one in-memory call. The scanner treated any row in `urls` as completed discovery. Its ten-minute slices applied only after discovery, and a restart of `profiling` reset the scan. The new implementation makes discovery resumable while preserving the external scan API, the `urls` meaning, the 10,000 distinct raw page cap, 20,000 request cap, 128 MiB aggregate XML cap, 50 MiB per XML response cap, maximum nesting depth 10, same-authority rules, and retry/fallback behavior. Ten-minute fair slices replace the former 30-minute cumulative discovery stop; a job can requeue until it finishes or reaches a non-time safety budget. This follows the user's choice to preserve eligible pages within those existing caps.

`urls` remains the scan-ready list. No candidate or partially probed URL enters it. The persisted discovery phase, rather than `len(urls)`, decides whether a new sitemap scan can proceed. Historical scans have no discovery row: if they already have `urls`, they remain scan-ready, including paused or failed-page-retry scans. A historical unfinished profiling scan with no `urls` starts discovery afresh. Single-page scans bypass this state.

## Migration `000020`

Use additive tables; do not alter `scans`, `urls`, their public SELECT column lists, or the dashboard read model. The SQL below is the intended schema shape. Adapt names to repository conventions but keep the constraints and foreign keys. The `active_*` columns belong only to the current admission, and the next startup clears them while retaining their reserved charge.

```sql
CREATE TABLE scan_discoveries (
  scan_id UUID PRIMARY KEY REFERENCES scans(id) ON DELETE CASCADE,
  phase TEXT NOT NULL DEFAULT 'fetch'
    CHECK (phase IN ('fetch', 'probe', 'complete')),
  requests_used INTEGER NOT NULL DEFAULT 0
    CHECK (requests_used BETWEEN 0 AND 20000),
  xml_bytes_used BIGINT NOT NULL DEFAULT 0
    CHECK (xml_bytes_used BETWEEN 0 AND 134217729),
  next_candidate_ordinal INTEGER NOT NULL DEFAULT 0
    CHECK (next_candidate_ordinal BETWEEN 0 AND 10000),
  active_ms_used BIGINT NOT NULL DEFAULT 0
    CHECK (active_ms_used >= 0),
  admission_epoch BIGINT NOT NULL DEFAULT 0
    CHECK (admission_epoch >= 0),
  active_started_at TIMESTAMPTZ,
  active_reserved_ms BIGINT NOT NULL DEFAULT 0
    CHECK (active_reserved_ms >= 0),
  active_heartbeat_at TIMESTAMPTZ,
  CHECK (
    (active_started_at IS NULL AND active_reserved_ms = 0 AND active_heartbeat_at IS NULL)
    OR (active_started_at IS NOT NULL AND active_reserved_ms > 0
        AND active_heartbeat_at IS NOT NULL)
  )
);

CREATE TABLE scan_discovery_sitemaps (
  scan_id UUID NOT NULL REFERENCES scan_discoveries(scan_id) ON DELETE CASCADE,
  canonical_url TEXT NOT NULL,
  canonical_hash BYTEA NOT NULL CHECK (octet_length(canonical_hash) = 32),
  fetch_url TEXT NOT NULL,
  dfs_path INTEGER[] NOT NULL,
  depth SMALLINT NOT NULL CHECK (depth BETWEEN 0 AND 11),
  state TEXT NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'done', 'failed')),
  failure_kind TEXT CHECK (failure_kind IS NULL OR
    failure_kind IN ('invalid_url', 'authority', 'depth', 'fetch', 'xml')),
  PRIMARY KEY (scan_id, dfs_path),
  CHECK (cardinality(dfs_path) = depth),
  CHECK (array_position(dfs_path, NULL) IS NULL),
  CHECK (failure_kind IS NULL OR state = 'failed')
);
CREATE INDEX idx_discovery_sitemaps_next
  ON scan_discovery_sitemaps(scan_id, dfs_path)
  WHERE state = 'queued';
CREATE INDEX idx_discovery_sitemaps_hash
  ON scan_discovery_sitemaps(scan_id, canonical_hash);

CREATE TABLE scan_discovery_candidates (
  scan_id UUID NOT NULL REFERENCES scan_discoveries(scan_id) ON DELETE CASCADE,
  raw_url TEXT NOT NULL,
  raw_hash BYTEA NOT NULL CHECK (octet_length(raw_hash) = 32),
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 9999),
  outcome TEXT NOT NULL DEFAULT 'pending'
    CHECK (outcome IN ('pending', 'eligible', 'external', 'unresolved')),
  final_url TEXT,
  redirected BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (scan_id, ordinal),
  CHECK ((outcome = 'eligible') = (final_url IS NOT NULL))
);
CREATE INDEX idx_discovery_candidates_next
  ON scan_discovery_candidates(scan_id, ordinal)
  WHERE outcome = 'pending';
CREATE INDEX idx_discovery_candidates_hash
  ON scan_discovery_candidates(scan_id, raw_hash);
```

PostgreSQL `integer[]` B-tree comparison is lexicographic; `[0, 1]` precedes `[1]`, and `[0]` precedes `[0, 1]`. Confirm this in the SQL fixture before relying on it. Root path is an empty array and depth 0. Children get `parent_path || zero_based_xml_entry_index`; check each index is nonnegative and below 20,000 in repository code (the current per-index distinct sitemap limit). The `depth=11` row represents an invalid over-depth reference and is marked failed when selected, preserving the current `depth > 10` check after duplicate detection. If a validation constraint for nonnegative array elements is desired, add an immutable SQL helper; do not use a fragile text regex against an array rendering.

Do not index full sitemap or page URLs as unique `TEXT` keys: a valid large `<loc>` can exceed PostgreSQL's B-tree entry size. Compute SHA-256 in Go and look up rows through the small hash index, then compare the complete stored string before treating a row as a duplicate. Hash collisions remain distinct rows. The discovery row lock serializes candidate and frontier insertion; `dfs_path` and `ordinal` are the stable primary keys. A queued duplicate sitemap found at an earlier DFS path moves its `dfs_path`, `depth`, and `fetch_url` to that earlier occurrence; never rewrite a `done` or `failed` row. This matters when the root index lists A then B, and A also lists B: B must be visited under A before the root's later B reference. Duplicate/cycle references already processed are skipped. The sitemap URL key uses the existing `canonicalizeURLString`; raw page uniqueness uses the existing exact trimmed string. Validate authority before marking a sitemap as visited, as current code does.

The `134217729` XML upper bound admits the one-byte overflow probe used to distinguish an exact 128 MiB document from an oversized one. Once bytes exceed `134217728`, discovery fails immediately. A read may never persist more than that one extra byte. Per-document 50 MiB + one-byte overflow remains local to a single fetch attempt; successful parsed content is committed only at document completion. A durable `failure_kind` is bounded and safe for storage; do not persist raw Go error strings or full URLs in an error column. Existing safe logging can provide redacted diagnostics.

Rollback for `000020.down.sql`: drop `scan_discovery_candidates`, then `scan_discovery_sitemaps`, then `scan_discoveries`. This discards only incomplete checkpoint state; it does not delete historical `urls` or scans. **Do not run that rollback against active discovery**. The supported rollback is restoring the matching pre-migration binary and database backup after all Shopkeepers are stopped; a down migration followed by the new binary is unsupported. Migrations through `000019` remain intact.

## Repository and Profiler boundary

Keep the current direct `profiler.Discover`/`DiscoverWithRootPolicy` for existing standalone tests and callers if needed. Add a checkpoint-capable entry point that depends on a narrow interface, implemented in the repository package without importing Profiler types into repository:

```go
type DiscoveryStore interface {
    LoadOrCreate(ctx context.Context, scanID, rootURL string) (Snapshot, error)
    StartAdmission(ctx context.Context, scanID string) (epoch int64, err error)
    RenewAdmission(ctx context.Context, scanID string, epoch int64, elapsed time.Duration) error
    EndAdmission(ctx context.Context, scanID string, epoch int64, elapsed time.Duration) error
    ReserveRequest(ctx context.Context, scanID string, epoch int64) error
    ChargeXMLBytes(ctx context.Context, scanID string, epoch int64, n int64) error
    NextSitemap(ctx context.Context, scanID string, epoch int64) (*SitemapTask, error)
    CommitSitemap(ctx context.Context, scanID string, epoch int64, task SitemapTask, doc ParsedDocument) error
    FailSitemap(ctx context.Context, scanID string, epoch int64, task SitemapTask, kind FailureKind) error
    BeginProbes(ctx context.Context, scanID string, epoch int64) (bool, error)
    PendingCandidates(ctx context.Context, scanID string, epoch int64, limit int) ([]Candidate, error)
    SaveProbe(ctx context.Context, scanID string, epoch int64, result ProbeOutcome) error
    PublishComplete(ctx context.Context, scanID string, epoch int64) ([]models.URL, error)
}

type DiscoveryResult int // Yielded, Complete; real errors are fatal
func DiscoverCheckpointed(ctx context.Context, scanID, rootURL string,
    store DiscoveryStore, policy rootdns.Policy) (DiscoveryResult, error)
```

This is an interface sketch, not a requirement to expose every method publicly. Repository methods should own the transactions and validate database state. Avoid a transaction across network I/O. The store must distinguish a budget error, fatal nested failure, request cancellation, and recoverable persistence error. A failed persistence call stops discovery without publishing or issuing subsequent network requests. `Yielded` means a normal slice boundary and must not be interpreted as scan failure.

`LoadOrCreate` atomically creates the state plus one queued root sitemap task, only for a sitemap scan with no saved `urls`. It must reject a discovery row whose `phase=complete` disagrees with `urls` count, rather than silently rediscover. For historical scans, the scanner checks existing `urls` first; no discovery row is created if they exist. New complete scans should retain `phase=complete` as an unambiguous marker. A zero-eligible result fails the scan without creating `urls`, matching current behavior.

## XML checkpoint and DFS traversal

One sitemap worker selects the smallest queued `dfs_path`. It fetches/parses the complete XML document using the existing parser and browser fallback, with up to three transient attempts per profile. Parsing remains streaming and capped, but the parsed document's entries are held only until the document transaction commits. No child or candidate row from a failed parse or read attempt is published. Request and actual read-byte charges from that attempt remain charged. A large valid document has at most 20,000 distinct child entries or 10,000 remaining candidate entries, so the transaction is bounded. If a transaction fails, leave its sitemap queued; a later admission can fetch it again, with the earlier network work still charged.

After a complete XML parse, give its atomic document checkpoint a separate bounded five-minute context. Stop new network work at the ten-minute slice deadline, but allow this already completed document to commit before requeueing; otherwise a deadline just after a large fetch can force another fetch and exhaust the request/XML budgets without making progress. Keep the heartbeat and admission lease alive through this bounded commit tail, then settle the full elapsed active time. A storage failure in the checkpoint remains an error, even if the network slice context has expired.

For an index transaction: lock the discovery row, require `phase=fetch` and task queued, mark the task done, and insert each new child in XML order at the computed path after hash lookup and full-string comparison. A later/duplicate queued canonical URL moves to the earlier path; processed duplicates stay processed. Invalid nested URLs are saved as tasks and fail on dequeue, allowing other siblings to run. For a urlset transaction: lock state, require queued task, insert distinct raw candidates in XML order with consecutive ordinals after the same hash-plus-string duplicate check, then mark the task done. `next_candidate_ordinal` advances only for new rows. If a new distinct raw URL would be ordinal 10,000, abort the transaction with the same page-budget error; no partial document candidates become visible. Keep the existing behavior of skipping empty and invalid page `<loc>` values.

The first nested failure is durable, but the walk keeps visiting siblings; when no queued sitemap remains, any failed sitemap makes discovery terminal, with an aggregated bounded diagnostic. This preserves the rule that one failed nested sitemap invalidates the whole discovery and that page probes do not start after a nested failure. A budget error or caller cancellation stops the walk immediately. The parent/child relationship is implicit in `dfs_path`; no recursive SQL expansion or unbounded in-memory frontier is needed. A single `SELECT ... ORDER BY dfs_path LIMIT 1` drives each step.

When every sitemap task is `done`, `BeginProbes` moves `fetch -> probe` in a transaction only if no failed/queued task remains. Probe candidates in `ordinal` order, with at most 12 concurrent workers and the existing ten-second per-candidate timeout. Each completed eligible/external/unresolved result is persisted by `(scan_id, raw_url)`; `SaveProbe` is idempotent and does not replace a terminal outcome. In-flight probes that never reached `SaveProbe` repeat after pause or crash, and their earlier request charges stay counted. Probe workers may finish out of order, but ordinals preserve XML discovery order. The final eligible list is `eligible` candidates ordered by ordinal, with canonical `final_url` deduped by first occurrence. Redirected/external/unresolved counts can be queried from the candidate table for logs. DNS and page failures remain per-candidate filters as today; only a global budget or storage failure stops all probes.

## Exact durable budgets

Every initial sitemap GET, retry/fallback GET, page GET, and followed same-authority redirect calls `ReserveRequest` **before** `client.Do` or its redirect request. Use one atomic SQL update with `requests_used < 20000` and `RETURNING`; a denied reservation returns the existing budget error. Do not refund a reservation after cancellation, timeout, or crash. The current redirect callback also enforces same authority before reserving. Do not reuse a pooled request transport that can bypass the per-request reservation path. This counts conservatively when a process stops after reservation but before a packet leaves; it never lets replay exceed the budget.

Wrap the XML response reader. On each `source.Read`, restrict the read to the lesser of the remaining per-document and aggregate allowance plus one sentinel byte. Persist the **actual returned `n`** with `ChargeXMLBytes` before returning those bytes to the XML decoder. A database failure aborts the fetch without exposing uncharged bytes. Keep network/read retry classification separate from persistence and budget errors, so a failed database charge does not become a fallback GET. The aggregate update locks the discovery row, increments by `n`, rejects any value above `128 MiB + 1`, and returns a budget error if above `128 MiB`. The per-document counter includes its one sentinel byte and returns a per-document budget error when above 50 MiB. Do not charge Content-Length, preallocate 50 MiB, or reset aggregate bytes for retries or later admissions. An exact-boundary document may complete. A failed attempt's read bytes remain charged.

`ReserveRequest` and `ChargeXMLBytes` use short, bounded persistence contexts even if the HTTP context has just been canceled, because already initiated work must be accounted. A database outage stops the scan's discovery work and leaves it recoverable; it cannot silently reset counters. Probe HTTP bodies are not read by Profiler, so they do not consume the sitemap XML budget. The 10,000 cap is on distinct raw page candidates before probes, as it is now, not on final deduped eligible URLs.

### Ten-minute admission lease and active-time accounting

Record active Profiler time across admissions for diagnosis, but do not stop a job after a cumulative time limit. Each admission has a ten-minute fairness deadline; queue wait and pause do not count toward the recorded active time. Exact process-death time cannot be known after a hard crash. Use a durable 60-second rolling reservation and a 30-second heartbeat to bound conservative overcount to about 60 seconds per crash:

1. `StartAdmission` locks the scan row first and the discovery row second, requires `pending` with no pause request, atomically sets `profiling`, increments `admission_epoch`, and clears stale `active_*` lease fields from a prior crashed admission **without refunding** `active_ms_used`. It reserves the first 60 seconds, adds that reservation to `active_ms_used`, and returns the new epoch. The scanner supplies the ten-minute context deadline.
2. Every 30 seconds, independently of network completion, `RenewAdmission` extends the reservation to `elapsed + 60000` milliseconds by adding only the difference to `active_ms_used`. The ahead-of-time reservation is crash accounting, not an admission limit. If renewal cannot commit before the already reserved horizon, cancel work and fail safely. No network work may continue past the ten-minute slice deadline; a completed XML document may use the bounded checkpoint tail above.
3. On normal yield, pause, completion, or fatal result, stop and drain workers, then `EndAdmission` settles `active_ms_used` to actual monotonic elapsed by subtracting the unused part of `active_reserved_ms`; clear `active_*` in the same transaction. Do not include time spent queued or paused.
4. On a hard crash, the reservation remains charged. Startup clears stale `active_*` fields without refund and increments `admission_epoch` to fence the abandoned worker. With a healthy heartbeat, this overcounts at most roughly 60 seconds. Repeated crashes affect telemetry, not scan eligibility. Time tests should inject a clock and simulate both clean settlement and hard restarts.

Use `CLOCK_MONOTONIC`/Go monotonic elapsed in-process; PostgreSQL timestamps are for lease observability and recovery, not to subtract an outage from the budget. Ensure the heartbeat operates while a sitemap read or page probe is blocked. A failed heartbeat must cancel network work, and the end transaction must not convert a failed checkpoint into apparent completion.

Every discovery reservation, task mutation, probe write, admission settlement, requeue, failure, and final publication must require the current `admission_epoch`. An old worker whose run was canceled or superseded cannot write into a later `profiling` admission merely because the status string matches again. Report a typed stale-admission error and stop that worker; never interpret it as a normal yield. Use scan-then-discovery row lock order for operations that touch both rows.

## Scanner and recovery transitions

Scanner starts by loading the scan plus discovery state before interpreting `urls`:

| State on admission | Action |
| --- | --- |
| Single-page scan | Existing direct URL path. |
| Sitemap, no discovery row, existing `urls` | Historical complete discovery; continue existing page workflow. |
| Sitemap, no discovery row, zero `urls` | Create root discovery state, set `profiling`, run checkpointed Profiler. |
| Sitemap, `fetch` or `probe`, zero `urls` | Set `profiling`, resume from saved tasks/outcomes and cumulative budgets. |
| Sitemap, `complete`, saved `urls` | Continue the existing ten-minute page workflow. |
| Any contradictory combination | Return an invariant error and keep scan recoverable; never scan a partial list. |

Each profiling admission has a ten-minute fairness slice. When the slice ends, stop scheduling tasks, cancel/drain current HTTP and probe workers, persist finished outcomes and time, then change `profiling -> pending` with `updated_at=NOW()` so older queued scans get a slot. A canceled network request with no committed sitemap/probe outcome repeats later. A pause request uses the existing `pause_requested` flag and run-context cancellation: drain, settle, and finalize `paused` without deleting state. Resume changes `paused -> pending` through existing admission controls. Preserve the already sticky `root_public` column and companion policy; each resumed admission re-resolves and pins the current approved address set, calls `ObserveScanRootDNS` before any dial, and uses `GuardScanPrivateRootDial` for private TCP dials. Never persist an exact DNS answer as a permanent allowlist. If a formerly private root is newly public, the public-only policy sticks across later page work and companion checks; mixed or later private answers fail before dialing.

Startup recovery changes interrupted `profiling` to `pending` or `paused`, retaining discovery tasks, outcomes, counters, and root policy. It clears stale active lease fields as described above. It must no longer call `ResetScan` for a checkpointed profiling scan. For a legacy profiling scan without state or `urls`, it may reset and start fresh. Existing `scanning`/`processing` recovery remains unchanged and retains terminal page evidence. Pending and paused scans retain their state. A storage failure during recovery should keep startup fail-closed as the current scanner does. All state transitions should predicate on current scan status/pause flag under row locks; a stale worker must not undo a concurrent pause or resume.

Fatal nested, XML, DNS, or budget errors set the scan to `failed` and leave `urls` empty. Partial discovery rows may be retained for diagnostics and are removed by scan deletion cascade. A failed scan is not resumed by failed-page retry (it has no page rows); rescan creates a new scan and starts a new discovery with inherited `root_public` policy. Companion link check remains queued until an accessibility scan completes and must never consume candidate rows.

## Atomic publication transaction

`PublishComplete` uses a single transaction and locks the scan row first, then `scan_discoveries`, following the existing scan/root-policy lock order. It requires `phase=probe`, zero queued or failed sitemap tasks, zero pending probes, and no global budget error. Query eligible candidates ordered by ordinal; keep the first occurrence of each `final_url` (same canonicalization as current Profiler). If none remain, return the existing no-URLs failure without publication. Insert the final list into `urls` in deterministic order, update `scans.total_urls` to the inserted count while leaving `scanned_urls=0`, and set `scan_discoveries.phase='complete'`. Commit once. Do not update `scans.status` to `scanning` here; scanner checks pause after commit and follows its existing page transition. A pause requested during publication may produce a complete list and a paused scan, which resumes without refetching.

The transaction should be idempotent: if already complete, return saved `urls`; if incomplete, publish all or none. One process is still the supported topology, but the lock and phase predicate prevent duplicate insertion if an operator inadvertently triggers concurrent execution. An interruption before commit leaves zero scan-ready rows; an interruption after commit leaves the complete list and phase marker. `urls` has no uniqueness constraint today, so this transaction must use the phase/lock gate instead of relying on `ON CONFLICT`.

## Upgrade and deployment gate

Migration `000020` is additive, but overlapping old/new Shopkeepers remain unsafe. An old binary can reset a `profiling` scan or decide that a partially written `urls` table is complete; it cannot honor the new phase or budgets. The first release containing `000020` therefore requires the same stop-all-backends, migrate, start-new-backend maintenance cutover used for migrations `000016`–`000019`. No old Shopkeeper process may run after `000020` is applied. The existing source/release updater and native paths already use stop/migrate/start; update their docs and mock checks to mention `000020` without changing that ordering.

UI-first/Shopkeeper-first source compatibility must be checked, but no UI schema change is planned. Rehearse migration from a populated `000019` database with paused, completed, failed, and queued scans; verify saved results and screenshots stay readable.

## Focused verification

- SQL fixture on isolated PostgreSQL 17: migration up/down/up, FK cascade, constraints, array DFS ordering, queued duplicate path move, atomic urlset insertion on XML failure, 10,000 raw candidate boundary, 20,000 request boundary, 128 MiB exact and plus-one boundaries, and rollback of incomplete final publication. Keep the database fixture private and do not start host Docker.
- Profiler fixtures: nested indexes with repeated/cyclic sitemap URLs and a duplicate first encountered through an earlier subtree; verify exact DFS candidate and final URL order. Verify 403 fallback, 429/5xx/network retry charges, same-authority redirect charges, external sitemap failure, external page skip, unresolved page skip, and output dedup after redirects.
- Scanner/repository integration: ten-minute yield behind older queue entries, pause during XML fetch and during parallel probes, resume without repeating committed work, restart with unfinished sitemap/probe, crash before/after final transaction, historical saved scan with no discovery row, zero-eligible terminal failure, failed nested sitemap with successful siblings but no `urls`, and unchanged page checkpoint recovery.
- Time tests with fake clock: clean yield refunds unused reservation; crash immediately after admission overcounts at most 60 seconds; heartbeat keeps a long blocked fetch covered; outage time is excluded; repeated crashes do not make an otherwise eligible scan fail; each admission yields after ten minutes. Verify request and byte counters never reset on retries, yields, pauses, or restarts.
- Network policy fixtures: first private answer followed by public answer across admissions sets durable `root_public`; later private or mixed answer fails before dial. Check the companion inherits the same policy and cannot start from partial discovery. Use local loopback/browser fixtures for actual GET/redirect behavior, including a real Chromium smoke scan after publication.
- Deployment mocks: verify native/source/release stop/migrate/start order. Run focused Go and SQL tests, race tests for probe/pause paths, `go vet`, dashboard typecheck if touched, and `git diff --check`.

## Original implementation sequence

1. Add migration `000020`, repository state types/transactions, SQL tests, and a migration compatibility test against populated `000019` data. Keep the old Profiler call path intact at this stage.
2. Refactor Profiler's fetch, parser, and probe routines to accept durable request/byte hooks and task/result callbacks. Add DFS, retry, dedup, and budget fixture tests. Preserve the direct `Discover` behavior while validating the new checkpointed entry point.
3. Wire scanner discovery admissions, ten-minute yielding, pause/resume, startup recovery, and atomic publication. Run SQL and network integration tests. Audit every `len(urlRecords)` decision and companion trigger against the new phase marker.
4. Verify source/release/native update order. Perform a populated upgrade rehearsal, full Go suite, race tests on changed packages, and a small browser scan. Keep deployment until the stop/migrate/start release check is reviewable.
