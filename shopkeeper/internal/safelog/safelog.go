// Package safelog removes HTTP URL details from diagnostics. It does not change
// the URLs used by scan jobs or stored in the database.
package safelog

import (
	"errors"
	"fmt"
	"log"
	"regexp"
	"strings"
)

// A URL's authority ends before a path, query, fragment, or whitespace. The
// greedy match removes everything through the last @ in that authority, as
// net/url does when parsing userinfo. Query strings containing @ are untouched.
var urlUserinfo = regexp.MustCompile(`(?i)(https?://)[^/?#\s]+@`)
var httpScheme = regexp.MustCompile(`(?i)https?:`)

// PublicURLText removes URL credentials, query, and fragment from a URL before
// returning it to a reader. Unlike diagnostic redaction, it keeps the public
// origin and path useful for identifying a scan or link. The input may be a
// malformed legacy URL, so avoid reparsing/normalizing its remaining bytes.
func PublicURLText(value string) string {
	if end := strings.IndexAny(value, "?#"); end >= 0 {
		value = value[:end]
	}
	return urlUserinfo.ReplaceAllString(value, "${1}")
}

// Text omits HTTP(S) URLs and everything after them from diagnostic strings.
// Go accepts unescaped whitespace and angle brackets in URL paths and queries,
// so diagnostics cannot reliably identify where a target URL ends. Raw target
// URLs remain available internally for scans and link checks.
func Text(message string) string {
	if bounds := httpScheme.FindStringIndex(message); bounds != nil {
		return message[:bounds[0]] + "[URL details omitted]"
	}
	return message
}

// Sprintf preserves independent diagnostic arguments without exposing URL tails.
func Sprintf(format string, args ...any) string {
	safeArgs := make([]any, len(args))
	for i, arg := range args {
		switch value := arg.(type) {
		case string:
			safeArgs[i] = Text(value)
		case []byte:
			safeArgs[i] = []byte(Text(string(value)))
		case error:
			safeArgs[i] = Error(value)
		default:
			safeArgs[i] = arg
		}
	}
	return Text(fmt.Sprintf(format, safeArgs...))
}

// Printf is the scan pipeline's logger. It also sanitizes URLs embedded in
// wrapped or third-party error strings before they reach process logs.
func Printf(format string, args ...any) {
	_ = log.Output(2, Sprintf(format, args...))
}

type redactedError struct{ cause error }

func (e redactedError) Error() string { return diagnosticErrorText(e.cause, 0) }
func (e redactedError) Unwrap() error { return e.cause }

// Rebuild wrapped errors from each safe segment. Sanitizing a flattened error
// would discard the useful cause after the first URL, such as an HTTP status.
func diagnosticErrorText(err error, depth int) string {
	if depth >= 32 {
		return "[nested error details omitted]"
	}
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		var parts []string
		for _, cause := range joined.Unwrap() {
			if cause != nil {
				parts = append(parts, diagnosticErrorText(cause, depth+1))
			}
		}
		if len(parts) > 0 {
			return strings.Join(parts, "\n")
		}
	}
	if cause := errors.Unwrap(err); cause != nil {
		raw := err.Error()
		if prefix, ok := strings.CutSuffix(raw, cause.Error()); ok {
			safePrefix := Text(prefix)
			if safePrefix != prefix {
				safePrefix += ": "
			}
			return safePrefix + diagnosticErrorText(cause, depth+1)
		}
	}
	return Text(err.Error())
}

// Error protects the printable form of a returned error while preserving
// errors.Is/As checks used for cancellation and discovery budget handling.
func Error(err error) error {
	if err == nil {
		return nil
	}
	return redactedError{cause: err}
}
