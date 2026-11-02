package sweetner

import (
	"context"
	"errors"
	"testing"

	"github.com/sumanbasuli/lime/shopkeeper/internal/juicer"
	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
)

type testIssueStore struct {
	issueErr           error
	occurrenceErr      error
	issuesCreated      int
	occurrencesCreated int
}

func (s *testIssueStore) GetScanIssueMap(context.Context, string) (map[string]string, error) {
	return map[string]string{}, nil
}

func (s *testIssueStore) GetInheritedFalsePositiveStates(context.Context, string, []string) (map[string]bool, error) {
	return map[string]bool{}, nil
}

func (s *testIssueStore) CreateURLAudits(context.Context, []models.URLAudit) error {
	return nil
}

func (s *testIssueStore) CreateURLAuditOccurrences(context.Context, []models.URLAuditOccurrence) error {
	return nil
}

func (s *testIssueStore) CreateIssue(_ context.Context, _, violationType, _, _ string, _ *string, _ bool) (*models.Issue, error) {
	s.issuesCreated++
	if s.issueErr != nil {
		return nil, s.issueErr
	}
	return &models.Issue{ID: violationType}, nil
}

func (s *testIssueStore) CreateIssueOccurrence(context.Context, string, string, *string, *string, *string, *string) error {
	s.occurrencesCreated++
	return s.occurrenceErr
}

func TestProcessFailsWhenIssueEvidenceCannotBeSaved(t *testing.T) {
	failure := errors.New("database write failed")
	tests := []struct {
		name                string
		violation           juicer.Violation
		issueErr            error
		occurrenceErr       error
		wantIssueCalls      int
		wantOccurrenceCalls int
	}{
		{"issue insert", juicer.Violation{ID: "rule-1", Nodes: []juicer.Node{{HTML: "<button>Go</button>"}}}, failure, nil, 1, 0},
		{"node occurrence insert", juicer.Violation{ID: "rule-1", Nodes: []juicer.Node{{HTML: "<button>Go</button>"}}}, nil, failure, 1, 1},
		{"fallback occurrence insert", juicer.Violation{ID: "rule-1"}, nil, failure, 1, 1},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			store := &testIssueStore{issueErr: tc.issueErr, occurrenceErr: tc.occurrenceErr}
			err := processWithStore(context.Background(), store, "scan-1", []juicer.RawResult{{URLID: "url-1", Violations: []juicer.Violation{tc.violation}}})
			if !errors.Is(err, failure) {
				t.Fatalf("expected persistence failure, got %v", err)
			}
			if store.issuesCreated != tc.wantIssueCalls || store.occurrencesCreated != tc.wantOccurrenceCalls {
				t.Fatalf("issue/occurrence calls = %d/%d, want %d/%d", store.issuesCreated, store.occurrencesCreated, tc.wantIssueCalls, tc.wantOccurrenceCalls)
			}
		})
	}
}

func TestProcessStillSavesAllIssueEvidenceOnSuccess(t *testing.T) {
	store := &testIssueStore{}
	err := processWithStore(context.Background(), store, "scan-1", []juicer.RawResult{{
		URLID: "url-1",
		Violations: []juicer.Violation{
			{ID: "rule-1", Nodes: []juicer.Node{{HTML: "<button>A</button>"}, {HTML: "<button>B</button>"}}},
			{ID: "rule-2"},
		},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if store.issuesCreated != 2 || store.occurrencesCreated != 3 {
		t.Fatalf("issue/occurrence calls = %d/%d, want 2/3", store.issuesCreated, store.occurrencesCreated)
	}
}

func TestBuildURLAuditsCapturesAllAuditOutcomeBuckets(t *testing.T) {
	audits := buildURLAudits(juicer.RawResult{
		URLID: "url-1",
		Passes: []juicer.RuleID{
			{ID: "button-name"},
		},
		NotApplicable: []juicer.RuleID{
			{ID: "meta-refresh"},
		},
		Incomplete: []juicer.Violation{
			{ID: "heading-order"},
		},
		Violations: []juicer.Violation{
			{ID: "image-alt"},
		},
	})

	got := make(map[string]string)
	for _, audit := range audits {
		got[audit.RuleID] = audit.Outcome
	}

	want := map[string]string{
		"button-name":   "passed",
		"meta-refresh":  "not_applicable",
		"heading-order": "incomplete",
		"image-alt":     "failed",
	}

	if len(got) != len(want) {
		t.Fatalf("expected %d audits, got %d", len(want), len(got))
	}

	for ruleID, outcome := range want {
		if got[ruleID] != outcome {
			t.Fatalf("expected %s to be %s, got %s", ruleID, outcome, got[ruleID])
		}
	}
}

func TestBuildURLAuditsKeepsHighestPriorityOutcome(t *testing.T) {
	audits := buildURLAudits(juicer.RawResult{
		URLID: "url-1",
		Passes: []juicer.RuleID{
			{ID: "button-name"},
		},
		Violations: []juicer.Violation{
			{ID: "button-name"},
		},
	})

	if len(audits) != 1 {
		t.Fatalf("expected one audit, got %d", len(audits))
	}
	if audits[0].Outcome != "failed" {
		t.Fatalf("expected failed outcome to win, got %s", audits[0].Outcome)
	}
}

func TestBuildURLAuditOccurrencesCapturesIncompleteNodeContext(t *testing.T) {
	screenshotPath := "/tmp/page.png"
	elementScreenshotPath := "/tmp/focus.png"

	occurrences := buildURLAuditOccurrences(juicer.RawResult{
		URLID:          "url-1",
		ScreenshotPath: screenshotPath,
		Incomplete: []juicer.Violation{
			{
				ID: "heading-order",
				Nodes: []juicer.Node{
					{
						HTML:                  "<h3>Heading</h3>",
						Target:                []string{"h3"},
						ElementScreenshotPath: elementScreenshotPath,
					},
				},
			},
		},
	})

	if len(occurrences) != 1 {
		t.Fatalf("expected one occurrence, got %d", len(occurrences))
	}

	occurrence := occurrences[0]
	if occurrence.RuleID != "heading-order" {
		t.Fatalf("expected heading-order, got %s", occurrence.RuleID)
	}
	if occurrence.Outcome != "incomplete" {
		t.Fatalf("expected incomplete outcome, got %s", occurrence.Outcome)
	}
	if occurrence.HTMLSnippet == nil || *occurrence.HTMLSnippet != "<h3>Heading</h3>" {
		t.Fatalf("expected html snippet to be stored, got %#v", occurrence.HTMLSnippet)
	}
	if occurrence.CSSSelector == nil || *occurrence.CSSSelector != "h3" {
		t.Fatalf("expected css selector to be stored, got %#v", occurrence.CSSSelector)
	}
	if occurrence.ScreenshotPath == nil || *occurrence.ScreenshotPath != screenshotPath {
		t.Fatalf("expected screenshot path to be stored, got %#v", occurrence.ScreenshotPath)
	}
	if occurrence.ElementScreenshotPath == nil || *occurrence.ElementScreenshotPath != elementScreenshotPath {
		t.Fatalf("expected element screenshot path to be stored, got %#v", occurrence.ElementScreenshotPath)
	}
}

func TestBuildURLAuditOccurrencesCreatesFallbackOccurrenceWithoutNodes(t *testing.T) {
	screenshotPath := "/tmp/page.png"

	occurrences := buildURLAuditOccurrences(juicer.RawResult{
		URLID:          "url-1",
		ScreenshotPath: screenshotPath,
		Incomplete: []juicer.Violation{
			{
				ID:    "heading-order",
				Nodes: nil,
			},
		},
	})

	if len(occurrences) != 1 {
		t.Fatalf("expected one fallback occurrence, got %d", len(occurrences))
	}
	if occurrences[0].HTMLSnippet != nil {
		t.Fatalf("expected no html snippet, got %#v", occurrences[0].HTMLSnippet)
	}
	if occurrences[0].ScreenshotPath == nil || *occurrences[0].ScreenshotPath != screenshotPath {
		t.Fatalf("expected screenshot path to be stored, got %#v", occurrences[0].ScreenshotPath)
	}
}
