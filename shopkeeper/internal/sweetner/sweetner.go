package sweetner

import (
	"context"
	"log"

	"github.com/sumanbasuli/lime/shopkeeper/internal/juicer"
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
	// Map of violation ID → created issue DB ID
	issueMap := make(map[string]string)

	totalOccurrences := 0

	for _, result := range results {
		if result.Error != "" {
			// Skip pages that errored during scanning
			continue
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
				issue, err := repo.CreateIssue(ctx, scanID, violation.ID, violation.Help, severity, helpURL)
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
