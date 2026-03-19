# Sweetner (Result Refiner)

**Sweetner** is the final module in the Shopkeeper core pipeline, responsible for post-processing the raw results from Juicer.

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
* **Severity Mapping**: Maps axe-core impact levels to our database severity enum:
    - `critical` → `critical`
    - `serious` → `serious`
    - `moderate` → `moderate`
    - `minor` → `minor`
    - Unknown → defaults to `moderate`

### Deduplication Algorithm

```
issueMap := map[violationID → issueDBID]

for each RawResult:
    skip if result has error
    for each Violation:
        if violationID not in issueMap:
            create Issue record in DB
            store issueDBID in issueMap
        for each Node in Violation:
            create IssueOccurrence(issueID, urlID, htmlSnippet, screenshotPath)
```

This means if "color-contrast" appears on 50 pages with 3 nodes each, we get 1 Issue record and 150 IssueOccurrence records.

### Relationship to ACT Enrichment

- Sweetner does not persist ACT metadata.
- The stored `issues.violation_type` field is the stable key used later by the read-time ACT resolver.
- This keeps the scan pipeline simple: Juicer produces axe violations, Sweetner normalizes them into canonical issue records, and the ACT layer enriches those issues only when they are read by the API or issue-details UI.

## Output

All data is persisted directly to the database via the repository layer. The Sweetner does not return data — it writes to:
- `issues` table — One row per unique violation type
- `issue_occurrences` table — One row per affected URL+node combination
