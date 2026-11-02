package repository

import (
	"context"
	"testing"

	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
)

func TestOccurrenceTextPreservesEvidenceWithoutPostgreSQLZeroBytes(t *testing.T) {
	if occurrenceText(nil) != nil {
		t.Fatal("nil evidence changed")
	}
	clean := "<a>ordinary</a>"
	if occurrenceText(&clean) != &clean {
		t.Fatal("clean evidence should not be copied or changed")
	}
	for input, want := range map[string]string{
		"\x00start":   "\uFFFDstart",
		"mid\x00dle":  "mid\uFFFDdle",
		"end\x00":     "end\uFFFD",
		"a\x00b\x00c": "a\uFFFDb\uFFFDc",
	} {
		got := occurrenceText(&input)
		if got == nil || *got != want || input == want {
			t.Fatalf("sanitized %q as %v, want %q", input, got, want)
		}
	}
}

func TestOccurrenceInsertsRetainNULBearingFailedAndIncompleteNodes(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	var scanID, urlID, issueID string
	if err := r.pool.QueryRow(ctx,
		`INSERT INTO scans (sitemap_url, status) VALUES ('https://fixture.test/', 'completed') RETURNING id`,
	).Scan(&scanID); err != nil {
		t.Fatal(err)
	}
	if err := r.pool.QueryRow(ctx,
		`INSERT INTO urls (scan_id, url, status) VALUES ($1, 'https://fixture.test/page', 'completed') RETURNING id`, scanID,
	).Scan(&urlID); err != nil {
		t.Fatal(err)
	}
	if err := r.pool.QueryRow(ctx,
		`INSERT INTO issues (scan_id, violation_type, description, severity)
		 VALUES ($1, 'image-alt', 'Missing alternate text', 'serious') RETURNING id`, scanID,
	).Scan(&issueID); err != nil {
		t.Fatal(err)
	}

	html := "<img alt=\"a\x00b\">"
	selector := "img[alt='a\x00b']"
	if err := r.CreateIssueOccurrence(ctx, issueID, urlID, &html, nil, nil, &selector); err != nil {
		t.Fatal(err)
	}
	assertOccurrenceText(t, ctx, r,
		`SELECT html_snippet, css_selector FROM issue_occurrences WHERE issue_id=$1`, issueID,
		"<img alt=\"a\uFFFDb\">", "img[alt='a\uFFFDb']")

	if err := r.CreateURLAuditOccurrences(ctx, []models.URLAuditOccurrence{
		{URLID: urlID, RuleID: "heading-order", Outcome: "incomplete", HTMLSnippet: &html, CSSSelector: &selector},
		{URLID: urlID, RuleID: "label", Outcome: "incomplete"},
	}); err != nil {
		t.Fatal(err)
	}
	assertOccurrenceText(t, ctx, r,
		`SELECT html_snippet, css_selector FROM url_audit_occurrences WHERE url_id=$1 AND rule_id='heading-order'`, urlID,
		"<img alt=\"a\uFFFDb\">", "img[alt='a\uFFFDb']")
	var count int
	if err := r.pool.QueryRow(ctx, `SELECT COUNT(*) FROM url_audit_occurrences WHERE url_id=$1`, urlID).Scan(&count); err != nil || count != 2 {
		t.Fatalf("incomplete occurrence count = %d, %v", count, err)
	}
	if html != "<img alt=\"a\x00b\">" || selector != "img[alt='a\x00b']" {
		t.Fatal("repository sanitation mutated the caller's raw evidence")
	}
}

func assertOccurrenceText(t *testing.T, ctx context.Context, r *Repository, query, id, wantHTML, wantSelector string) {
	t.Helper()
	var html, selector string
	if err := r.pool.QueryRow(ctx, query, id).Scan(&html, &selector); err != nil {
		t.Fatal(err)
	}
	if html != wantHTML || selector != wantSelector {
		t.Fatalf("persisted evidence = %q, %q; want %q, %q", html, selector, wantHTML, wantSelector)
	}
}
