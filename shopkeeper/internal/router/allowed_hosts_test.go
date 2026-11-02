package router

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// These tests use only an in-memory handler. The request URL has an unrelated
// listener authority because a reverse proxy may forward a public Host to an
// internal listener; membership must be decided from the preserved Host.
func TestRejectUntrustedHostMiddleware(t *testing.T) {
	cases := []struct {
		name, config, host, forwardedHost string
		allowed                           bool
	}{
		{"localhost", "", "localhost", "", true},
		{"localhost custom port", "", "LOCALHOST:3100", "", true},
		{"localhost trailing dot", "", "localhost.:3000", "", true},
		{"loopback IPv4", "", "127.0.0.1:8080", "", true},
		{"remote literal IPv4", "", "192.0.2.10:65535", "", true},
		{"loopback IPv6", "", "[::1]:8080", "", true},
		{"remote literal IPv6", "", "[2001:db8::10]:8080", "", true},
		{"IPv4-mapped literal IPv6", "", "[::ffff:127.0.0.1]:8080", "", true},
		{"configured DNS case and port", " LIME.Example.COM., ui ", "lime.example.com:8443", "", true},
		{"configured internal service alias", "ui,shopkeeper", "shopkeeper:8080", "", true},
		{"configured IDNA name", "bücher.example", "xn--bcher-kva.example:443", "", true},
		{"unconfigured DNS", "", "attacker.example", "", false},
		{"subdomain not implied", "lime.example.com", "evil.lime.example.com", "", false},
		{"suffix not implied", "lime.example.com", "lime.example.com.evil.test", "", false},
		{"forged forwarded host", "lime.example.com", "attacker.example", "lime.example.com", false},
		{"forwarded host does not revoke valid host", "lime.example.com", "lime.example.com", "attacker.example", true},
		{"missing Host", "lime.example.com", "", "", false},
		{"comma combined Host", "lime.example.com", "lime.example.com, attacker.example", "", false},
		{"duplicate identical Host representation", "lime.example.com", "lime.example.com, lime.example.com", "", false},
		{"leading whitespace", "lime.example.com", " lime.example.com", "", false},
		{"trailing whitespace", "lime.example.com", "lime.example.com ", "", false},
		{"scheme in Host", "lime.example.com", "https://lime.example.com", "", false},
		{"userinfo in Host", "lime.example.com", "user@lime.example.com", "", false},
		{"path in Host", "lime.example.com", "lime.example.com/path", "", false},
		{"query in Host", "lime.example.com", "lime.example.com?x=1", "", false},
		{"fragment in Host", "lime.example.com", "lime.example.com#x", "", false},
		{"percent escape in Host", "lime.example.com", "lime%2eexample.com", "", false},
		{"empty port", "lime.example.com", "lime.example.com:", "", false},
		{"nonnumeric port", "lime.example.com", "lime.example.com:word", "", false},
		{"zero port", "lime.example.com", "lime.example.com:0", "", false},
		{"oversized port", "lime.example.com", "lime.example.com:65536", "", false},
		{"unbracketed IPv6", "", "::1", "", false},
		{"invalid IPv6 bracket", "", "[::1", "", false},
		{"IPv6 zone", "", "[fe80::1%25en0]:8080", "", false},
		{"abbreviated IPv4", "", "127.1", "", false},
		{"hexadecimal IPv4", "", "0x7f000001", "", false},
		{"octal IPv4", "", "010.0.0.1", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("LIME_ALLOWED_HOSTS", tc.config)
			called := 0
			gate := rejectUntrustedHost(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				called++
				w.WriteHeader(http.StatusNoContent)
			}))
			req := httptest.NewRequest(http.MethodGet, "http://internal-listener.invalid/api/health", nil)
			req.Host = tc.host
			if tc.forwardedHost != "" {
				req.Header.Set("X-Forwarded-Host", tc.forwardedHost)
			}
			response := httptest.NewRecorder()
			gate.ServeHTTP(response, req)
			if tc.allowed {
				if response.Code != http.StatusNoContent || called != 1 {
					t.Fatalf("allowed Host %q: status=%d calls=%d", tc.host, response.Code, called)
				}
			} else if response.Code != http.StatusMisdirectedRequest || called != 0 {
				t.Fatalf("rejected Host %q: status=%d calls=%d", tc.host, response.Code, called)
			}
		})
	}
}

func TestRejectUntrustedHostMalformedConfigurationFailsClosed(t *testing.T) {
	for _, config := range []string{
		"lime.example.com,,other.example", "https://lime.example.com",
		"*.example.com", "lime.example.com/path", "lime.example.com:word",
	} {
		t.Run(config, func(t *testing.T) {
			t.Setenv("LIME_ALLOWED_HOSTS", config)
			gate := rejectUntrustedHost(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				t.Fatal("malformed configuration reached a route handler")
			}))
			for _, host := range []string{"lime.example.com", "127.0.0.1"} {
				req := httptest.NewRequest(http.MethodGet, "http://internal-listener.invalid/api/health", nil)
				req.Host = host
				response := httptest.NewRecorder()
				gate.ServeHTTP(response, req)
				if response.Code != http.StatusMisdirectedRequest {
					t.Fatalf("malformed config %q with Host %q: status=%d", config, host, response.Code)
				}
			}
		})
	}
}

func TestSetupRejectsUntrustedHostBeforeAPIMCPHandlers(t *testing.T) {
	t.Setenv("LIME_ALLOWED_HOSTS", "api.example.com")
	router := Setup(nil, nil, nil)
	cases := []struct {
		name, method, path, host, origin string
		status                           int
	}{
		{"API read", http.MethodGet, "/api/health", "attacker.example", "", http.StatusMisdirectedRequest},
		{"API write", http.MethodPost, "/api/scans", "attacker.example", "http://attacker.example", http.StatusMisdirectedRequest},
		{"MCP read", http.MethodGet, "/mcp", "attacker.example", "", http.StatusMisdirectedRequest},
		{"MCP write", http.MethodPost, "/mcp", "attacker.example", "", http.StatusMisdirectedRequest},
		{"configured API", http.MethodGet, "/api/health", "api.example.com", "", http.StatusOK},
		{"configured MCP route", http.MethodGet, "/mcp", "api.example.com", "", http.StatusMethodNotAllowed},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, "http://internal-listener.invalid"+tc.path, strings.NewReader(`{}`))
			req.Host = tc.host
			if tc.origin != "" {
				req.Header.Set("Origin", tc.origin)
			}
			response := httptest.NewRecorder()
			router.ServeHTTP(response, req)
			if response.Code != tc.status {
				t.Fatalf("%s Host %q: status=%d want=%d body=%s", tc.path, tc.host, response.Code, tc.status, response.Body.String())
			}
		})
	}
}
