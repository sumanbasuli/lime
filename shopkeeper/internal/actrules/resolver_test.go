package actrules

import (
	"path/filepath"
	"runtime"
	"testing"

	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
)

func TestCatalogContract(t *testing.T) {
	resolver := loadTestResolver(t)

	if len(resolver.catalog.ACTRules) == 0 {
		t.Fatal("expected ACT rules to be loaded")
	}

	for id, rule := range resolver.catalog.ACTRules {
		if rule.ActRuleID == "" {
			t.Fatalf("rule %s is missing act_rule_id", id)
		}
		if rule.Title == "" {
			t.Fatalf("rule %s is missing title", id)
		}
		if rule.Status == "" {
			t.Fatalf("rule %s is missing status", id)
		}
		if rule.RuleURL == "" {
			t.Fatalf("rule %s is missing rule_url", id)
		}
		if rule.AccessibilityRequirements == nil {
			t.Fatalf("rule %s is missing accessibility_requirements", id)
		}
	}
}

func TestResolveKnownMapping(t *testing.T) {
	resolver := loadTestResolver(t)

	rules, fixes := resolver.Resolve("button-name")

	if len(rules) == 0 {
		t.Fatal("expected button-name to resolve to ACT rules")
	}
	if len(fixes) == 0 {
		t.Fatal("expected button-name to include suggested fixes")
	}
	if rules[0].ActRuleID != "97a4e1" {
		t.Fatalf("expected first ACT rule to be 97a4e1, got %s", rules[0].ActRuleID)
	}
}

func TestResolvePreservesMultipleMappings(t *testing.T) {
	resolver := loadTestResolver(t)

	rules, fixes := resolver.Resolve("bypass")

	if len(rules) != 5 {
		t.Fatalf("expected 5 ACT rules for bypass, got %d", len(rules))
	}
	if len(fixes) == 0 {
		t.Fatal("expected bypass to aggregate suggested fixes")
	}
}

func TestResolveUnmappedRuleReturnsEmpty(t *testing.T) {
	resolver := loadTestResolver(t)

	rules, fixes := resolver.Resolve("definitely-not-a-real-axe-rule")

	if len(rules) != 0 {
		t.Fatalf("expected no ACT rules, got %d", len(rules))
	}
	if len(fixes) != 0 {
		t.Fatalf("expected no suggested fixes, got %d", len(fixes))
	}
}

func TestEnrichIssuesPreservesFieldsAndAddsContext(t *testing.T) {
	resolver := loadTestResolver(t)

	input := []models.IssueWithOccurrences{
		{
			Issue: models.Issue{
				ID:            "issue-1",
				ScanID:        "scan-1",
				ViolationType: "color-contrast",
				Description:   "Elements must meet minimum color contrast ratio thresholds",
				Severity:      "serious",
			},
			Occurrences: []models.IssueOccurrence{
				{ID: "occ-1", IssueID: "issue-1", URLID: "url-1", PageURL: "https://example.com"},
			},
		},
	}

	enriched := resolver.EnrichIssues(input)

	if len(enriched) != 1 {
		t.Fatalf("expected one enriched issue, got %d", len(enriched))
	}
	if enriched[0].Issue.ID != input[0].Issue.ID {
		t.Fatalf("expected issue ID %s to be preserved, got %s", input[0].Issue.ID, enriched[0].Issue.ID)
	}
	if len(enriched[0].Issue.ActRules) != 2 {
		t.Fatalf("expected 2 ACT rules for color-contrast, got %d", len(enriched[0].Issue.ActRules))
	}
	if len(enriched[0].Issue.SuggestedFixes) == 0 {
		t.Fatal("expected suggested fixes to be added")
	}
	if enriched[0].Occurrences[0].ID != input[0].Occurrences[0].ID {
		t.Fatalf("expected occurrence ID %s to be preserved, got %s", input[0].Occurrences[0].ID, enriched[0].Occurrences[0].ID)
	}
}

func TestResolverSupportsProposedRuleStatus(t *testing.T) {
	resolver := NewFromCatalog(Catalog{
		AxeRuleToACTRuleIDs: map[string][]string{
			"fake-rule": []string{"abc123"},
		},
		ACTRules: map[string]models.ACTRule{
			"abc123": {
				ActRuleID:      "abc123",
				Title:          "Synthetic proposed rule",
				Status:         "proposed",
				RuleURL:        "https://www.w3.org/WAI/standards-guidelines/act/rules/abc123/proposed/",
				SuggestedFixes: []string{"Use the proposed rule guidance."},
			},
		},
	})

	rules, fixes := resolver.Resolve("fake-rule")

	if len(rules) != 1 {
		t.Fatalf("expected one ACT rule, got %d", len(rules))
	}
	if rules[0].Status != "proposed" {
		t.Fatalf("expected proposed status, got %s", rules[0].Status)
	}
	if len(fixes) != 1 {
		t.Fatalf("expected one suggested fix, got %d", len(fixes))
	}
}

func loadTestResolver(t *testing.T) *Resolver {
	t.Helper()

	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("failed to determine test file location")
	}

	resolver, err := NewFromPath(filepath.Join(filepath.Dir(filename), "..", "..", "..", "data", "act-rules.json"))
	if err != nil {
		t.Fatalf("failed to load ACT catalog: %v", err)
	}

	return resolver
}
