package router

import (
	"encoding/json"
	"net"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"unicode"

	"golang.org/x/net/idna"
)

var (
	hostLabel = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`)
	hexHost   = regexp.MustCompile(`^0x[0-9a-f]+$`)
)

// parseRequestAuthority deliberately uses the HTTP Host value rather than the
// URL or forwarded headers. A reverse proxy must preserve the validated public
// Host when forwarding requests to this service.
func parseRequestAuthority(value string) (string, bool) {
	if value == "" || value != strings.TrimSpace(value) || strings.ContainsAny(value, ",/@?#%\\") ||
		strings.IndexFunc(value, unicode.IsSpace) >= 0 {
		return "", false
	}

	var hostname, port string
	if strings.HasPrefix(value, "[") {
		close := strings.IndexByte(value, ']')
		if close < 0 {
			return "", false
		}
		hostname = value[1:close]
		ip := net.ParseIP(hostname)
		if ip == nil || !strings.Contains(hostname, ":") || strings.Contains(hostname, "%") {
			return "", false
		}
		suffix := value[close+1:]
		if suffix != "" {
			if !strings.HasPrefix(suffix, ":") {
				return "", false
			}
			port = suffix[1:]
		}
	} else {
		hostname = value
		if separator := strings.IndexByte(value, ':'); separator >= 0 {
			hostname, port = value[:separator], value[separator+1:]
		}
		if strings.ContainsAny(hostname, ":[]") {
			return "", false
		}
	}
	if strings.Contains(value, ":") && port == "" && !strings.HasSuffix(value, "]") {
		return "", false
	}
	if port != "" {
		for _, digit := range port {
			if digit < '0' || digit > '9' {
				return "", false
			}
		}
		parsed, err := strconv.Atoi(port)
		if err != nil || parsed < 1 || parsed > 65535 {
			return "", false
		}
	}
	if ip := net.ParseIP(hostname); ip != nil {
		return strings.ToLower(hostname), true
	}
	lower := strings.ToLower(hostname)
	if hexHost.MatchString(lower) || strings.Trim(lower, "0123456789.") == "" {
		return "", false
	}
	identity, err := idna.Lookup.ToASCII(strings.TrimSuffix(hostname, "."))
	if err != nil || identity == "" || len(identity) > 253 || strings.HasSuffix(identity, ".") {
		return "", false
	}
	identity = strings.ToLower(identity)
	for _, label := range strings.Split(identity, ".") {
		if len(label) == 0 || len(label) > 63 || !hostLabel.MatchString(label) {
			return "", false
		}
	}
	return identity, true
}

func configuredHosts(value string) (map[string]struct{}, bool) {
	names := make(map[string]struct{})
	if value == "" {
		return names, true
	}
	for _, entry := range strings.Split(value, ",") {
		entry = strings.TrimSpace(entry)
		name, ok := parseRequestAuthority(entry)
		if !ok {
			return nil, false
		}
		names[name] = struct{}{}
	}
	return names, true
}

func rejectUntrustedHost(next http.Handler) http.Handler {
	names, valid := configuredHosts(os.Getenv("LIME_ALLOWED_HOSTS"))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name, parsed := parseRequestAuthority(r.Host)
		_, listed := names[name]
		if valid && parsed && (name == "localhost" || net.ParseIP(name) != nil || listed) {
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusMisdirectedRequest)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "Unrecognized request host"})
	})
}
