package router

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
)

// rejectCrossOriginWrites protects direct REST access. Browser requests through
// Next are checked against the public dashboard origin before proxying here.
func rejectCrossOriginWrites(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions {
			next.ServeHTTP(w, r)
			return
		}
		origin := r.Header.Get("Origin")
		_, hasOrigin := r.Header["Origin"]
		site := strings.ToLower(r.Header.Get("Sec-Fetch-Site"))
		if (hasOrigin && !allowedWriteOrigin(r, origin)) ||
			(site == "cross-site" && (!hasOrigin || !isLocalhostDevOrigin(origin))) ||
			(site == "same-site" && !hasOrigin) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusForbidden)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "Cross-origin write requests are not allowed"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func allowedWriteOrigin(r *http.Request, origin string) bool {
	parsed, ok := parseWriteOrigin(origin)
	if !ok {
		return false
	}
	// Preserve the backend's existing trusted localhost development exception,
	// including a local UI that calls a backend on another host.
	if isLocalhostDevOriginURL(parsed) {
		return true
	}

	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	} else if forwarded := strings.TrimSpace(strings.SplitN(r.Header.Get("X-Forwarded-Proto"), ",", 2)[0]); forwarded != "" {
		if forwarded != "http" && forwarded != "https" {
			return false
		}
		scheme = forwarded
	}
	host, err := url.Parse(scheme + "://" + r.Host)
	return err == nil && strings.EqualFold(parsed.Hostname(), host.Hostname()) &&
		effectivePort(parsed) == effectivePort(host) && parsed.Scheme == scheme
}

func isLocalhostDevOrigin(origin string) bool {
	parsed, ok := parseWriteOrigin(origin)
	return ok && isLocalhostDevOriginURL(parsed)
}

func isLocalhostDevOriginURL(parsed *url.URL) bool {
	return parsed.Scheme == "http" && parsed.Hostname() == "localhost" && parsed.Port() != ""
}

func parseWriteOrigin(origin string) (*url.URL, bool) {
	parsed, err := url.Parse(origin)
	return parsed, err == nil && (parsed.Scheme == "http" || parsed.Scheme == "https") &&
		parsed.Hostname() != "" && parsed.User == nil && parsed.Path == "" &&
		parsed.RawQuery == "" && parsed.Fragment == "" && parsed.Opaque == ""
}

func effectivePort(u *url.URL) string {
	if port := u.Port(); port != "" {
		return port
	}
	if u.Scheme == "https" {
		return "443"
	}
	return "80"
}
