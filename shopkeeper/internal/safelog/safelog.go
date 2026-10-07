// Package safelog removes HTTP URL userinfo from scan diagnostics. It does not
// change the URLs used by scan jobs or stored in the database.
package safelog

import (
	"fmt"
	"log"
	"regexp"
)

// A URL's authority ends before a path, query, fragment, or whitespace. The
// greedy match removes everything through the last @ in that authority, as
// net/url does when parsing userinfo. Query strings containing @ are untouched.
var urlUserinfo = regexp.MustCompile(`(?i)(https?://)[^/?#\s]+@`)

// Text removes entire URL userinfo (including the username) from diagnostics.
// A URL's password must not be treated as the only sensitive part.
func Text(message string) string {
	return urlUserinfo.ReplaceAllString(message, "${1}")
}

// Printf is the scan pipeline's logger. It also sanitizes URLs embedded in
// wrapped or third-party error strings before they reach process logs.
func Printf(format string, args ...any) {
	_ = log.Output(2, Text(fmt.Sprintf(format, args...)))
}

type redactedError struct{ cause error }

func (e redactedError) Error() string { return Text(e.cause.Error()) }
func (e redactedError) Unwrap() error { return e.cause }

// Error protects the printable form of a returned error while preserving
// errors.Is/As checks used for cancellation and discovery budget handling.
func Error(err error) error {
	if err == nil {
		return nil
	}
	return redactedError{cause: err}
}
