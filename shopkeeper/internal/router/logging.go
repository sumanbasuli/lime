package router

import (
	"log"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/sumanbasuli/lime/shopkeeper/internal/safelog"
)

// Log only the registered route pattern, never the client-supplied request
// target, Host, forwarded IP, or headers. Target URLs can contain literal
// whitespace and punctuation, making string-based query stripping unsafe.
type diagnosticLogFormatter struct{}

func (diagnosticLogFormatter) NewLogEntry(request *http.Request) middleware.LogEntry {
	return diagnosticLogEntry{request: request}
}

type diagnosticLogEntry struct{ request *http.Request }

func (entry diagnosticLogEntry) Write(status, bytes int, _ http.Header, elapsed time.Duration, _ interface{}) {
	pattern := ""
	if route := chi.RouteContext(entry.request.Context()); route != nil {
		pattern = route.RoutePattern()
	}
	if pattern == "" {
		pattern = "[unmatched route]"
	}
	log.Printf("request route=%q status=%d bytes=%d duration=%s", pattern, status, bytes, elapsed)
}

func (diagnosticLogEntry) Panic(value interface{}, stack []byte) {
	safelog.Printf("request panic: %v\n%s", value, stack)
}
