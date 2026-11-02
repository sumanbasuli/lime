package repository

import (
	"errors"
	"testing"
)

type issueReadFixtureRows struct {
	remaining int
	readErr   error
	closed    bool
}

func (r *issueReadFixtureRows) Next() bool {
	if r.remaining == 0 {
		return false
	}
	r.remaining--
	return true
}

func (r *issueReadFixtureRows) Scan(dest ...any) error {
	*dest[0].(*string) = "fixture-id"
	return nil
}

func (r *issueReadFixtureRows) Err() error { return r.readErr }
func (r *issueReadFixtureRows) Close()     { r.closed = true }

func TestScanIssueRowIterationErrorsDoNotReturnPartialEvidence(t *testing.T) {
	readFailure := errors.New("fixture stream failed")
	for _, count := range []int{0, 1} {
		rows := &issueReadFixtureRows{remaining: count, readErr: readFailure}
		issues, err := readScanIssueRows(rows)
		if !errors.Is(err, readFailure) || issues != nil || !rows.closed {
			t.Fatalf("%d issue rows: issues=%v error=%v closed=%v", count, issues, err, rows.closed)
		}
		rows = &issueReadFixtureRows{remaining: count, readErr: readFailure}
		occurrences, err := readIssueOccurrenceRows(rows)
		if !errors.Is(err, readFailure) || occurrences != nil || !rows.closed {
			t.Fatalf("%d occurrence rows: occurrences=%v error=%v closed=%v", count, occurrences, err, rows.closed)
		}
	}
}

func TestScanIssueRowsStillReturnCompleteEvidence(t *testing.T) {
	emptyIssueRows := &issueReadFixtureRows{}
	emptyIssues, err := readScanIssueRows(emptyIssueRows)
	if err != nil || len(emptyIssues) != 0 || !emptyIssueRows.closed {
		t.Fatalf("empty issue rows: issues=%v error=%v closed=%v", emptyIssues, err, emptyIssueRows.closed)
	}
	issueRows := &issueReadFixtureRows{remaining: 1}
	issues, err := readScanIssueRows(issueRows)
	if err != nil || len(issues) != 1 || issues[0].ID != "fixture-id" || !issueRows.closed {
		t.Fatalf("complete issue rows: issues=%v error=%v closed=%v", issues, err, issueRows.closed)
	}
	occurrenceRows := &issueReadFixtureRows{remaining: 1}
	occurrences, err := readIssueOccurrenceRows(occurrenceRows)
	if err != nil || len(occurrences) != 1 || occurrences[0].ID != "fixture-id" || !occurrenceRows.closed {
		t.Fatalf("complete occurrence rows: occurrences=%v error=%v closed=%v", occurrences, err, occurrenceRows.closed)
	}
	emptyOccurrenceRows := &issueReadFixtureRows{}
	emptyOccurrences, err := readIssueOccurrenceRows(emptyOccurrenceRows)
	if err != nil || len(emptyOccurrences) != 0 || !emptyOccurrenceRows.closed {
		t.Fatalf("empty occurrence rows: occurrences=%v error=%v closed=%v", emptyOccurrences, err, emptyOccurrenceRows.closed)
	}
}
