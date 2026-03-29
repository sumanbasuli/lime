package sweetner

import (
	"testing"

	"github.com/sumanbasuli/lime/shopkeeper/internal/juicer"
)

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
