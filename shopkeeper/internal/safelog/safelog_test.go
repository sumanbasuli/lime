package safelog

import (
	"bytes"
	"errors"
	"fmt"
	"log"
	"net/url"
	"strings"
	"testing"
)

func TestPublicURLTextRemovesCredentialsQueryAndFragment(t *testing.T) {
	tests := []struct {
		name, input, want string
	}{
		{"password", "fetch https://alice:p%40ss@example.test/path", "fetch https://example.test/path"},
		{"username only", "fetch http://alice@example.test/path", "fetch http://example.test/path"},
		{"last at in authority", "fetch HTTP://alice:p@ss@example.test/path", "fetch HTTP://example.test/path"},
		{"multiple URLs", "http://a:x@one.test/a then https://b:y@two.test/b", "http://one.test/a then https://two.test/b"},
		{"query at is not userinfo", "fetch https://example.test?owner=a@b", "fetch https://example.test"},
		{"fragment token", "https://example.test/path#access_token=QUERY_TOKEN_CANARY", "https://example.test/path"},
		{"malformed URL", "https://alice:pass@example.test/a b?token=QUERY_TOKEN_CANARY", "https://example.test/a b"},
		{"plain URL", "fetch https://example.test/path", "fetch https://example.test/path"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := PublicURLText(test.input); got != test.want {
				t.Fatalf("PublicURLText() = %q; want %q", got, test.want)
			}
		})
	}
}

func TestTextRemovesURLQueriesFromDiagnostics(t *testing.T) {
	const secret = "QUERY_TOKEN_CANARY"
	input := "GET https://alice:password@example.test/path?token=" + secret + "&lang=en: denied; retry HTTP://public.test/other#fragment"
	got := Text(input)
	if strings.Contains(got, "alice") || strings.Contains(got, "password") || strings.Contains(got, secret) || strings.Contains(got, "lang=en") || strings.Contains(got, "#fragment") {
		t.Fatalf("diagnostic leaked URL credentials: %q", got)
	}
	if got != "GET [URL details omitted]" {
		t.Fatalf("diagnostic did not omit the ambiguous URL tail: %q", got)
	}
	for _, input := range []string{
		"retry HTTP://public.test/other#fragment",
		"bad https://alice:p?" + secret + "@example.test",
		"quoted https://alice:p\"ss@example.test/secret?token=" + secret,
	} {
		got := Text(input)
		if strings.Contains(got, "alice") || strings.Contains(got, secret) || strings.Contains(got, "fragment") {
			t.Fatalf("alternate URL form leaked: %q", got)
		}
	}
}

func TestTextRedactsAcceptedRawQueryWithWhitespace(t *testing.T) {
	const raw = "https://example.test/path?token=PREFIX QUERY_TOKEN_CANARY<still-query>"
	if _, err := url.ParseRequestURI(raw); err != nil {
		t.Fatalf("expected URL accepted by scan parser: %v", err)
	}
	got := Text("Scanner: starting scan for " + raw + " at desktop")
	if strings.Contains(got, "PREFIX") || strings.Contains(got, "QUERY_TOKEN_CANARY") || strings.Contains(got, "still-query") || got != "Scanner: starting scan for [URL details omitted]" {
		t.Fatalf("accepted raw query leaked to diagnostic: %q", got)
	}
}

func TestTextRedactsAcceptedPathWhitespaceBeforeQuery(t *testing.T) {
	for _, raw := range []string{
		"https://example.test/a b?token=QUERY_TOKEN_CANARY",
		"https://example.test/a<b>?token=QUERY_TOKEN_CANARY",
	} {
		if _, err := url.ParseRequestURI(raw); err != nil {
			t.Fatalf("expected URL accepted by scan parser: %v", err)
		}
		got := Text("Scanner: starting scan for " + raw + " at desktop")
		if got != "Scanner: starting scan for [URL details omitted]" {
			t.Fatalf("accepted path leaked to diagnostic: %q", got)
		}
	}
}

func TestTextRedactsAcceptedOpaqueSchemeURL(t *testing.T) {
	const raw = "https:opaque?token=QUERY_TOKEN_CANARY"
	if _, err := url.ParseRequestURI(raw); err != nil {
		t.Fatalf("expected URL accepted by scan parser: %v", err)
	}
	got := Text("Scanner: starting scan for " + raw)
	if got != "Scanner: starting scan for [URL details omitted]" {
		t.Fatalf("opaque URL query leaked: %q", got)
	}
}

func TestErrorRedactsPrintableFormAndPreservesClassification(t *testing.T) {
	cause := errors.New("discovery stopped")
	err := Error(fmt.Errorf("fetch https://alice:secret@example.test/path?token=QUERY_TOKEN_CANARY: %w", cause))
	if !errors.Is(err, cause) {
		t.Fatalf("redacted error lost its cause: %v", err)
	}
	if got := err.Error(); got != "fetch [URL details omitted]: discovery stopped" {
		t.Fatalf("Error() = %q", got)
	}
	if Error(nil) != nil {
		t.Fatal("nil error was not preserved")
	}
}

func TestErrorRetainsWrappedStatusAndJoinedCausesWithoutURLs(t *testing.T) {
	err := Error(fmt.Errorf("failed to fetch sitemap https://example.test/a b?token=QUERY_TOKEN_CANARY: %w", errors.Join(
		fmt.Errorf("HTTP 401 for https://example.test/a b?token=QUERY_TOKEN_CANARY"),
		fmt.Errorf("%w: https:opaque?token=OTHER_TOKEN", errors.New("different authority")),
	)))
	got := err.Error()
	if !strings.Contains(got, "HTTP 401") || !strings.Contains(got, "different authority") || strings.Contains(got, "QUERY_TOKEN_CANARY") || strings.Contains(got, "OTHER_TOKEN") || strings.Contains(got, "example.test") {
		t.Fatalf("wrapped cause was lost or URL leaked: %q", got)
	}
}

func TestPrintfRedactsURLInNestedError(t *testing.T) {
	var output bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&output)
	defer log.SetOutput(previous)

	Printf("scan failed: %v", fmt.Errorf("GET https://alice:secret@example.test/path?token=QUERY_TOKEN_CANARY: denied"))
	message := output.String()
	if !strings.Contains(message, "GET [URL details omitted]") {
		t.Fatalf("URL omission missing from log: %q", message)
	}
	if strings.Contains(message, "alice") || strings.Contains(message, "secret") || strings.Contains(message, "QUERY_TOKEN_CANARY") {
		t.Fatalf("URL credentials leaked to log: %q", message)
	}
}

func TestPrintfKeepsSeparateDiagnosticArgumentsAfterURL(t *testing.T) {
	var output bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&output)
	defer log.SetOutput(previous)

	Printf("found sitemap at %s with %d URLs: %v", "https://example.test/a b?token=QUERY_TOKEN_CANARY", 7, fmt.Errorf("HTTP 599 for https://example.test/a b?token=QUERY_TOKEN_CANARY"))
	message := output.String()
	if !strings.Contains(message, "[URL details omitted] with 7 URLs: HTTP 599 for [URL details omitted]") || strings.Contains(message, "QUERY_TOKEN_CANARY") {
		t.Fatalf("diagnostic detail lost or query leaked: %q", message)
	}
}

func TestSprintfPreservesIndependentFailureReasonsAndPolicyCounts(t *testing.T) {
	for _, target := range []string{
		"https://alice:password@example.test/path?token=QUERY_TOKEN_CANARY",
		"https://example.test/a b?token=QUERY_TOKEN_CANARY<tail>",
		"HTTP://example.test/path?token=PREFIX QUERY_TOKEN_CANARY",
		"https:opaque?token=QUERY_TOKEN_CANARY",
	} {
		t.Run(target, func(t *testing.T) {
			cause := fmt.Errorf("browser: %w", errors.New("HTTP 599 for https://error.test/?token=ERROR_CANARY"))
			got := Sprintf("failed to navigate to %s: %v; browser network safety policy blocked %d request(s)", target, cause, 2)
			want := "failed to navigate to [URL details omitted]: browser: HTTP 599 for [URL details omitted]; browser network safety policy blocked 2 request(s)"
			if got != want {
				t.Fatalf("Sprintf() = %q; want %q", got, want)
			}
		})
	}
}

func TestSprintfRetainsConservativeUnstructuredURLTailRedaction(t *testing.T) {
	if got := Sprintf("error: %s", []byte("bad https://example.test/a b?token=QUERY_TOKEN_CANARY")); got != "error: bad [URL details omitted]" {
		t.Fatalf("unstructured URL tail leaked: %q", got)
	}
	if got := Sprintf("plain %s status %d: %v", "message", 503, errors.New("unavailable")); got != "plain message status 503: unavailable" {
		t.Fatalf("ordinary diagnostic changed: %q", got)
	}
}
