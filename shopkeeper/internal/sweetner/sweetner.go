package sweetner

import (
	"context"
	"log"

	"github.com/sumanbasuli/lime/shopkeeper/internal/juicer"
	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
	"github.com/sumanbasuli/lime/shopkeeper/internal/repository"
)

// Process takes raw scan results from the Juicer, deduplicates violations,
// groups them by violation type (axe-core rule ID), and persists to the database.
//
// Deduplication logic:
//   - Multiple pages may report the same violation type (e.g., "color-contrast").
//   - We create ONE Issue record per unique violation type per scan.
//   - Each occurrence (URL + DOM node) becomes an IssueOccurrence record.
func Process(ctx context.Context, repo *repository.Repository, scanID string, results []juicer.RawResult) error {
	// Map of violation ID → issue DB ID. Seed with any issues already persisted for
	// this scan so resumed batches append to the existing issue groups.
	issueMap, err := repo.GetScanIssueMap(ctx, scanID)
	if err != nil {
		return err
	}
	inheritedFalsePositiveStates, err := repo.GetInheritedFalsePositiveStates(
		ctx,
		scanID,
		uniqueViolationTypes(results),
	)
	if err != nil {
		return err
	}

	totalOccurrences := 0

	for _, result := range results {
		if result.Error != "" {
			// Skip pages that errored during scanning
			continue
		}

		if err := repo.CreateURLAudits(ctx, buildURLAudits(result)); err != nil {
			return err
		}
		if err := repo.CreateURLAuditOccurrences(ctx, buildURLAuditOccurrences(result)); err != nil {
			return err
		}

		for _, violation := range result.Violations {
			// Get or create the Issue record for this violation type
			issueID, exists := issueMap[violation.ID]
			if !exists {
				severity := mapImpactToSeverity(violation.Impact)
				var helpURL *string
				if violation.HelpURL != "" {
					helpURL = &violation.HelpURL
				}
				issue, err := repo.CreateIssue(
					ctx,
					scanID,
					violation.ID,
					violation.Help,
					severity,
					helpURL,
					inheritedFalsePositiveStates[violation.ID],
				)
				if err != nil {
					log.Printf("Sweetner: failed to create issue for violation %s: %v", violation.ID, err)
					continue
				}
				issueID = issue.ID
				issueMap[violation.ID] = issueID
			}

			// Create an occurrence for each DOM node affected
			for _, node := range violation.Nodes {
				htmlSnippet := node.HTML
				var htmlPtr *string
				if htmlSnippet != "" {
					htmlPtr = &htmlSnippet
				}

				var screenshotPtr *string
				if result.ScreenshotPath != "" {
					screenshotPtr = &result.ScreenshotPath
				}

				var elemScreenshotPtr *string
				if node.ElementScreenshotPath != "" {
					elemScreenshotPtr = &node.ElementScreenshotPath
				}

				var cssSelectorPtr *string
				if len(node.Target) > 0 {
					cssSelectorPtr = &node.Target[0]
				}

				if err := repo.CreateIssueOccurrence(ctx, issueID, result.URLID, htmlPtr, screenshotPtr, elemScreenshotPtr, cssSelectorPtr); err != nil {
					log.Printf("Sweetner: failed to create occurrence for issue %s on URL %s: %v", issueID, result.URLID, err)
					continue
				}
				totalOccurrences++
			}

			// If no nodes but violation exists, create at least one occurrence
			if len(violation.Nodes) == 0 {
				var screenshotPtr *string
				if result.ScreenshotPath != "" {
					screenshotPtr = &result.ScreenshotPath
				}

				if err := repo.CreateIssueOccurrence(ctx, issueID, result.URLID, nil, screenshotPtr, nil, nil); err != nil {
					log.Printf("Sweetner: failed to create occurrence for issue %s on URL %s: %v", issueID, result.URLID, err)
					continue
				}
				totalOccurrences++
			}
		}
	}

	log.Printf("Sweetner: processed scan %s — %d unique issues, %d total occurrences", scanID, len(issueMap), totalOccurrences)
	return nil
}

func uniqueViolationTypes(results []juicer.RawResult) []string {
	seen := make(map[string]struct{})
	types := make([]string, 0)

	for _, result := range results {
		for _, violation := range result.Violations {
			if violation.ID == "" {
				continue
			}
			if _, exists := seen[violation.ID]; exists {
				continue
			}

			seen[violation.ID] = struct{}{}
			types = append(types, violation.ID)
		}
	}

	return types
}

func buildURLAudits(result juicer.RawResult) []models.URLAudit {
	outcomes := make(map[string]string)

	setOutcome := func(ruleID, outcome string) {
		if ruleID == "" {
			return
		}

		current, exists := outcomes[ruleID]
		if !exists || auditOutcomePriority(outcome) > auditOutcomePriority(current) {
			outcomes[ruleID] = outcome
		}
	}

	for _, rule := range result.Passes {
		setOutcome(rule.ID, "passed")
	}
	for _, rule := range result.NotApplicable {
		setOutcome(rule.ID, "not_applicable")
	}
	for _, violation := range result.Incomplete {
		setOutcome(violation.ID, "incomplete")
	}
	for _, violation := range result.Violations {
		setOutcome(violation.ID, "failed")
	}

	audits := make([]models.URLAudit, 0, len(outcomes))
	for ruleID, outcome := range outcomes {
		audits = append(audits, models.URLAudit{
			URLID:   result.URLID,
			RuleID:  ruleID,
			Outcome: outcome,
		})
	}

	return audits
}

func buildURLAuditOccurrences(result juicer.RawResult) []models.URLAuditOccurrence {
	occurrences := make([]models.URLAuditOccurrence, 0)

	for _, violation := range result.Incomplete {
		for _, node := range violation.Nodes {
			htmlSnippet := node.HTML
			var htmlPtr *string
			if htmlSnippet != "" {
				htmlPtr = &htmlSnippet
			}

			var screenshotPtr *string
			if result.ScreenshotPath != "" {
				screenshotPtr = &result.ScreenshotPath
			}

			var elemScreenshotPtr *string
			if node.ElementScreenshotPath != "" {
				elemScreenshotPtr = &node.ElementScreenshotPath
			}

			var cssSelectorPtr *string
			if len(node.Target) > 0 {
				cssSelectorPtr = &node.Target[0]
			}

			occurrences = append(occurrences, models.URLAuditOccurrence{
				URLID:                 result.URLID,
				RuleID:                violation.ID,
				Outcome:               "incomplete",
				HTMLSnippet:           htmlPtr,
				ScreenshotPath:        screenshotPtr,
				ElementScreenshotPath: elemScreenshotPtr,
				CSSSelector:           cssSelectorPtr,
			})
		}

		if len(violation.Nodes) == 0 {
			var screenshotPtr *string
			if result.ScreenshotPath != "" {
				screenshotPtr = &result.ScreenshotPath
			}

			occurrences = append(occurrences, models.URLAuditOccurrence{
				URLID:          result.URLID,
				RuleID:         violation.ID,
				Outcome:        "incomplete",
				ScreenshotPath: screenshotPtr,
			})
		}
	}

	return occurrences
}

func auditOutcomePriority(outcome string) int {
	switch outcome {
	case "failed":
		return 4
	case "incomplete":
		return 3
	case "not_applicable":
		return 2
	case "passed":
		return 1
	default:
		return 0
	}
}

// mapImpactToSeverity maps axe-core impact levels to our severity enum.
func mapImpactToSeverity(impact string) string {
	switch impact {
	case "critical":
		return "critical"
	case "serious":
		return "serious"
	case "moderate":
		return "moderate"
	case "minor":
		return "minor"
	default:
		// Default unknown impacts to moderate
		return "moderate"
	}
}
