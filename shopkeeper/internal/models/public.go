package models

import "github.com/sumanbasuli/lime/shopkeeper/internal/safelog"

// PublicScan removes URL credentials and query data from a response copy.
// The stored URL remains intact for discovery and rescans.
func PublicScan(scan Scan) Scan {
	scan.SitemapURL = safelog.PublicURLText(scan.SitemapURL)
	return scan
}

func PublicIssue(issue Issue) Issue {
	if issue.HelpURL != nil {
		value := safelog.PublicURLText(*issue.HelpURL)
		issue.HelpURL = &value
	}
	if issue.ActRules != nil {
		rules := make([]ACTRule, len(issue.ActRules))
		copy(rules, issue.ActRules)
		for i := range rules {
			rules[i].RuleURL = safelog.PublicURLText(rules[i].RuleURL)
		}
		issue.ActRules = rules
	}
	return issue
}

func PublicScans(scans []Scan) []Scan {
	if scans == nil {
		return nil
	}
	public := make([]Scan, len(scans))
	for i, scan := range scans {
		public[i] = PublicScan(scan)
	}
	return public
}

func PublicIssueOccurrences(occurrences []IssueOccurrence) []IssueOccurrence {
	if occurrences == nil {
		return nil
	}
	public := make([]IssueOccurrence, len(occurrences))
	for i, occurrence := range occurrences {
		occurrence.PageURL = safelog.PublicURLText(occurrence.PageURL)
		public[i] = occurrence
	}
	return public
}

func PublicIssues(issues []IssueWithOccurrences) []IssueWithOccurrences {
	if issues == nil {
		return nil
	}
	public := make([]IssueWithOccurrences, len(issues))
	for i, issue := range issues {
		issue.Issue = PublicIssue(issue.Issue)
		issue.Occurrences = PublicIssueOccurrences(issue.Occurrences)
		public[i] = issue
	}
	return public
}

func PublicMCPIssueSummary(summary MCPIssueSummary) MCPIssueSummary {
	if summary.HelpURL != nil {
		value := safelog.PublicURLText(*summary.HelpURL)
		summary.HelpURL = &value
	}
	return summary
}

func PublicMCPIssueSummaries(issues []MCPIssueSummary) []MCPIssueSummary {
	if issues == nil {
		return nil
	}
	public := make([]MCPIssueSummary, len(issues))
	for i, issue := range issues {
		public[i] = PublicMCPIssueSummary(issue)
	}
	return public
}
