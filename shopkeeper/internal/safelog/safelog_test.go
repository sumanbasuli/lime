package safelog

import (
	"bytes"
	"errors"
	"fmt"
	"log"
	"strings"
	"testing"
)

func TestTextRemovesEntireURLUserinfo(t *testing.T) {
	tests := []struct {
		name, input, want string
	}{
		{"password", "fetch https://alice:p%40ss@example.test/path", "fetch https://example.test/path"},
		{"username only", "fetch http://alice@example.test/path", "fetch http://example.test/path"},
		{"last at in authority", "fetch HTTP://alice:p@ss@example.test/path", "fetch HTTP://example.test/path"},
		{"multiple URLs", "http://a:x@one.test/a then https://b:y@two.test/b", "http://one.test/a then https://two.test/b"},
		{"query at is not userinfo", "fetch https://example.test?owner=a@b", "fetch https://example.test?owner=a@b"},
		{"plain URL", "fetch https://example.test/path", "fetch https://example.test/path"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := Text(test.input); got != test.want {
				t.Fatalf("Text() = %q; want %q", got, test.want)
			}
		})
	}
}

func TestErrorRedactsPrintableFormAndPreservesClassification(t *testing.T) {
	cause := errors.New("discovery stopped")
	err := Error(fmt.Errorf("fetch https://alice:secret@example.test/path: %w", cause))
	if !errors.Is(err, cause) {
		t.Fatalf("redacted error lost its cause: %v", err)
	}
	if got := err.Error(); got != "fetch https://example.test/path: discovery stopped" {
		t.Fatalf("Error() = %q", got)
	}
	if Error(nil) != nil {
		t.Fatal("nil error was not preserved")
	}
}

func TestPrintfRedactsURLInNestedError(t *testing.T) {
	var output bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&output)
	defer log.SetOutput(previous)

	Printf("scan failed: %v", fmt.Errorf("GET https://alice:secret@example.test/path: denied"))
	message := output.String()
	if !strings.Contains(message, "GET https://example.test/path: denied") {
		t.Fatalf("safe URL missing from log: %q", message)
	}
	if strings.Contains(message, "alice") || strings.Contains(message, "secret") {
		t.Fatalf("URL userinfo leaked to log: %q", message)
	}
}
