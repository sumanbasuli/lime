# Sweetner (Result Refiner)

**Sweetner** groups and saves Juicer's results. It creates one issue per failed rule in each scan and records every affected page and element.

## Implementation

**File**: `shopkeeper/internal/sweetner/sweetner.go`

### Entry Point

```go
func Process(ctx context.Context, repo *repository.Repository, scanID string, results []juicer.RawResult) error
```

## Responsibilities

* **Result Refinement**: Parses the raw axe-core violation objects from Juicer.
* **Deduplication & Grouping**: Groups violations by axe-core rule ID (e.g., `color-contrast`, `image-alt`). Creates one `Issue` DB record per unique violation type per scan.
* **Occurrence Tracking**: For each affected page + DOM node, creates an `IssueOccurrence` record linking the Issue to the URL with the HTML snippet and screenshot path.
* **Audit Outcomes**: Persists passed, failed, incomplete, and not-applicable rule outcomes in `url_audits`, with manual-review evidence in `url_audit_occurrences`.
* **Resume And Retry**: Seeds its rule-to-issue map from existing issue rows so new successful pages append to the same groups without replacing completed-page evidence.
* **Triage Inheritance**: New matching target/type/viewport scans inherit the latest terminal scan's false-positive mark or unmark decision per rule; existing issue rows retain their saved state.
* **Severity Mapping**: Maps axe-core impact levels to our database severity enum:
    - `critical` → `critical`
    - `serious` → `serious`
    - `moderate` → `moderate`
    - `minor` → `minor`
    - Unknown → defaults to `moderate`

### Deduplication Algorithm

```
issueMap := existing scan issues[violationID → issueDBID]

for each RawResult:
    skip if result has error
    persist rule audit outcomes and incomplete occurrence evidence
    for each Violation:
        if violationID not in issueMap:
            create Issue record in DB
            store issueDBID in issueMap
        for each Node in Violation:
            create IssueOccurrence(issueID, urlID, htmlSnippet, screenshotPath)
```

For example, if `color-contrast` fails on 50 pages with 3 affected elements each, Sweetner creates 1 issue and 150 occurrence records.

The grouping map is per scan and seeded on resume/retry; this is not cross-scan deduplication. Needs-review grouping happens later in the read layer: when a failed group exists for a rule, the UI/reports/MCP suppress a duplicate needs-review card for that rule while keeping its incomplete audit evidence in storage.

`Process` is not one transaction for the entire scan. Audit writes can return an error to the scanner, while individual issue/occurrence insertion errors are logged and the loop continues. Do not infer from a terminal scan status alone that every possible evidence row was written; check logs and occurrence counts when investigating persistence failures. Restart recovery of interrupted active scans clears their partial evidence and reruns them, while explicit resume/retry preserves already completed evidence.

### Relationship to ACT Enrichment

- Sweetner does not persist ACT metadata.
- The stored `issues.violation_type` field is the stable key used later by the read-time ACT resolver.
- This keeps the scan pipeline simple: Juicer produces axe violations, Sweetner normalizes them into canonical issue records, and the ACT layer enriches those issues only when they are read by the API or issue-details UI.

## Output

Sweetner saves results through the repository layer in these tables:

- `issues` table — One row per unique violation type
- `issue_occurrences` table — One row per affected URL+node combination
- `url_audits` table — Rule outcome rows for completed pages
- `url_audit_occurrences` table — Incomplete outcome evidence for needs-review groups

## Developer Checks

Run backend tests from `shopkeeper/` with `go test ./...`. Keep rule grouping, severity mapping, stored screenshot paths, and triage inheritance aligned with `repository.GetInheritedFalsePositiveStates` and the corresponding tests. A fresh rescan must not retroactively modify its source scan's decision, and an unmark is an explicit inherited decision rather than absence of history.
