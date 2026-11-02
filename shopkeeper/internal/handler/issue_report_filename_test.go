package handler

import (
	"strings"
	"testing"
	"time"
)

func TestIssueReportFilenameUsesOnlyParsedHost(t *testing.T) {
	createdAt := time.Date(2026, time.October, 23, 12, 0, 0, 0, time.UTC)

	for _, test := range []struct {
		name      string
		rawURL    string
		want      string
		wantScope string
	}{
		{
			name:      "ordinary host",
			rawURL:    "https://Example.COM/path?token=QUERY_TOKEN_CANARY",
			want:      "lime-issue-report-example-com-2026-10-23.pdf",
			wantScope: "lime-issue-report-example-com-2026-10-23-failed-color-contrast.pdf",
		},
		{
			name:      "hostless opaque URL",
			rawURL:    "https:opaque?token=QUERY_TOKEN_CANARY",
			want:      "lime-issue-report-scan-2026-10-23.pdf",
			wantScope: "lime-issue-report-scan-2026-10-23-failed-color-contrast.pdf",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			got := buildIssueReportFilename(test.rawURL, createdAt)
			if got != test.want || strings.Contains(got, "canary") {
				t.Fatalf("filename = %q, want %q", got, test.want)
			}
			gotScope := buildScopedIssueReportFilename(test.rawURL, createdAt, "failed", "color-contrast")
			if gotScope != test.wantScope || strings.Contains(gotScope, "canary") {
				t.Fatalf("scoped filename = %q, want %q", gotScope, test.wantScope)
			}
		})
	}
}
