package models

import (
	"strings"
	"testing"
)

func TestPublicScanAndIssueCopiesRedactURLSecrets(t *testing.T) {
	const raw = "https://alice:s%40cret@example.test/path?owner=a@b"
	const safe = "https://example.test/path"
	scans := []Scan{{ID: "scan-1", SitemapURL: raw}, {ID: "scan-2", SitemapURL: "https://example.test/"}}
	publicScans := PublicScans(scans)
	if publicScans[0].SitemapURL != safe || publicScans[1].SitemapURL != scans[1].SitemapURL {
		t.Fatalf("unexpected public scan URLs: %+v", publicScans)
	}
	if scans[0].SitemapURL != raw {
		t.Fatal("stored scan URL was mutated")
	}
	issues := []IssueWithOccurrences{{Occurrences: []IssueOccurrence{{PageURL: raw}}}}
	publicIssues := PublicIssues(issues)
	if publicIssues[0].Occurrences[0].PageURL != safe || issues[0].Occurrences[0].PageURL != raw {
		t.Fatal("issue occurrence was not safely copied", publicIssues, issues)
	}
	publicIssues[0].Occurrences[0].PageURL = "changed"
	if issues[0].Occurrences[0].PageURL != raw {
		t.Fatal("public occurrence aliases stored occurrence")
	}
}

func TestPublicProjectionPreservesNilSlices(t *testing.T) {
	if PublicScans(nil) != nil || PublicIssueOccurrences(nil) != nil || PublicIssues(nil) != nil ||
		PublicMCPIssueSummaries(nil) != nil || PublicLinkChecks(nil) != nil || PublicLinkResults(nil) != nil || PublicLinkSources(nil) != nil {
		t.Fatal("nil JSON slice behavior changed")
	}
}

func TestPublicLinkProjectionRemovesQueryCanariesWithoutMutatingStoredRows(t *testing.T) {
	const token = "QUERY_TOKEN_CANARY"
	const raw = "https://user:pass@example.test/path?token=" + token + "#fragment"
	errText := "GET " + raw + ": connection reset"
	final := raw + "-redirect"
	job := LinkCheck{URL: raw, Error: &errText, SeedURLs: []string{raw}}
	source := LinkSource{PageURL: raw, Element: "a", Text: "Captured label"}
	result := LinkResult{TargetURL: raw, FinalURL: &final, Error: &errText, Sources: []LinkSource{source}}
	publicJob := PublicLinkCheck(job)
	publicResult := PublicLinkResult(result)
	for _, value := range []string{publicJob.URL, *publicJob.Error, publicResult.TargetURL, *publicResult.FinalURL, *publicResult.Error, publicResult.Sources[0].PageURL} {
		if strings.Contains(value, token) || strings.Contains(value, "user:pass") || strings.Contains(value, "fragment") {
			t.Fatalf("public link value leaked URL details: %q", value)
		}
	}
	if publicJob.URL != "https://example.test/path" || publicResult.TargetURL != publicJob.URL || publicResult.Sources[0].PageURL != publicJob.URL {
		t.Fatal("public link paths changed", publicJob, publicResult)
	}
	publicResult.Sources[0].PageURL = "changed"
	if job.URL != raw || job.SeedURLs[0] != raw || *job.Error != errText || result.TargetURL != raw || *result.FinalURL != final || *result.Error != errText || result.Sources[0].PageURL != raw {
		t.Fatal("projection changed stored job or result")
	}
}

func TestPublicIssueMetadataRemovesQueryCanariesWithoutMutatingRuleURL(t *testing.T) {
	const raw = "https://rules.test/help?token=QUERY_TOKEN_CANARY"
	help := raw
	issue := Issue{HelpURL: &help, ActRules: []ACTRule{{RuleURL: raw}}}
	public := PublicIssue(issue)
	summary := PublicMCPIssueSummary(MCPIssueSummary{HelpURL: &help})
	if *public.HelpURL != "https://rules.test/help" || public.ActRules[0].RuleURL != "https://rules.test/help" || *summary.HelpURL != "https://rules.test/help" {
		t.Fatal("issue metadata leaked query", public, summary)
	}
	public.ActRules[0].RuleURL = "changed"
	if *issue.HelpURL != raw || issue.ActRules[0].RuleURL != raw || help != raw {
		t.Fatal("public issue metadata mutated stored values")
	}
}
