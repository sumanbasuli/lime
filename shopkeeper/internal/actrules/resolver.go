package actrules

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
)

// Catalog is the JSON payload stored in data/act-rules.json.
type Catalog struct {
	AxeRuleToACTRuleIDs map[string][]string       `json:"axe_rule_to_act_rule_ids"`
	ACTRules            map[string]models.ACTRule `json:"act_rules"`
}

// Resolver loads the checked-in ACT catalog and resolves axe rule IDs to ACT context.
type Resolver struct {
	catalog Catalog
}

var (
	defaultResolverOnce sync.Once
	defaultResolver     *Resolver
	defaultResolverErr  error
)

// Default returns the process-wide resolver loaded from ACT_RULES_PATH or known fallback locations.
func Default() (*Resolver, error) {
	defaultResolverOnce.Do(func() {
		defaultResolver, defaultResolverErr = NewFromCandidatePaths(defaultCatalogPaths())
		if defaultResolver == nil {
			defaultResolver = NewFromCatalog(Catalog{})
		}
	})

	return defaultResolver, defaultResolverErr
}

// NewFromCatalog creates a resolver from an in-memory catalog.
func NewFromCatalog(catalog Catalog) *Resolver {
	if catalog.AxeRuleToACTRuleIDs == nil {
		catalog.AxeRuleToACTRuleIDs = map[string][]string{}
	}
	if catalog.ACTRules == nil {
		catalog.ACTRules = map[string]models.ACTRule{}
	}

	return &Resolver{catalog: catalog}
}

// NewFromPath loads a catalog from a specific JSON file path.
func NewFromPath(path string) (*Resolver, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read ACT catalog %s: %w", path, err)
	}

	var catalog Catalog
	if err := json.Unmarshal(data, &catalog); err != nil {
		return nil, fmt.Errorf("parse ACT catalog %s: %w", path, err)
	}

	return NewFromCatalog(catalog), nil
}

// NewFromCandidatePaths loads the first ACT catalog file that exists and parses successfully.
func NewFromCandidatePaths(paths []string) (*Resolver, error) {
	var errs []error

	for _, path := range dedupeStrings(paths) {
		if path == "" {
			continue
		}

		resolver, err := NewFromPath(path)
		if err == nil {
			return resolver, nil
		}

		if errors.Is(err, os.ErrNotExist) {
			errs = append(errs, fmt.Errorf("%s: %w", path, os.ErrNotExist))
			continue
		}

		return nil, err
	}

	if len(errs) == 0 {
		return nil, fmt.Errorf("no ACT catalog paths configured")
	}

	return nil, errors.Join(errs...)
}

// Resolve returns the ACT rules and aggregated suggested fixes for an axe violation type.
func (r *Resolver) Resolve(violationType string) ([]models.ACTRule, []string) {
	if r == nil {
		return []models.ACTRule{}, []string{}
	}

	actRuleIDs := r.catalog.AxeRuleToACTRuleIDs[violationType]
	if len(actRuleIDs) == 0 {
		return []models.ACTRule{}, []string{}
	}

	rules := make([]models.ACTRule, 0, len(actRuleIDs))
	suggestedFixes := make([]string, 0, len(actRuleIDs))

	for _, actRuleID := range actRuleIDs {
		rule, ok := r.catalog.ACTRules[actRuleID]
		if !ok {
			continue
		}

		rule.AccessibilityRequirements = ensureRequirements(rule.AccessibilityRequirements)
		rule.SuggestedFixes = dedupeStrings(rule.SuggestedFixes)
		rules = append(rules, rule)
		suggestedFixes = append(suggestedFixes, rule.SuggestedFixes...)
	}

	return rules, dedupeStrings(suggestedFixes)
}

// EnrichIssues copies ACT rule context onto issue records without mutating DB-backed fields.
func (r *Resolver) EnrichIssues(issues []models.IssueWithOccurrences) []models.IssueWithOccurrences {
	if len(issues) == 0 {
		return []models.IssueWithOccurrences{}
	}

	enriched := make([]models.IssueWithOccurrences, len(issues))
	for index, issueWithOccurrences := range issues {
		rules, fixes := r.Resolve(issueWithOccurrences.Issue.ViolationType)
		issueWithOccurrences.Issue.ActRules = rules
		issueWithOccurrences.Issue.SuggestedFixes = fixes
		enriched[index] = issueWithOccurrences
	}

	return enriched
}

func ensureRequirements(requirements []models.ACTAccessibilityRequirement) []models.ACTAccessibilityRequirement {
	if requirements == nil {
		return []models.ACTAccessibilityRequirement{}
	}
	return requirements
}

func defaultCatalogPaths() []string {
	cwd, _ := os.Getwd()

	return []string{
		os.Getenv("ACT_RULES_PATH"),
		"/shared-data/act-rules.json",
		filepath.Join(cwd, "data", "act-rules.json"),
		filepath.Join(cwd, "..", "data", "act-rules.json"),
	}
}

func dedupeStrings(values []string) []string {
	if len(values) == 0 {
		return []string{}
	}

	result := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		if value == "" {
			continue
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}

	return result
}
