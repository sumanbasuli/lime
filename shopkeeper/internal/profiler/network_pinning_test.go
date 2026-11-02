package profiler

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestDiscoveryPinsFirstDNSAnswerAndBypassesEnvironmentProxy(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Connection", "close") // Force a second TCP dial.
		fmt.Fprint(w, `<urlset><url><loc>http://rebind.example/page</loc></url></urlset>`)
	}))
	defer server.Close()
	parsed, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	target := "http://rebind.example:" + parsed.Port() + "/sitemap.xml"
	var proxyCalls, lookupCalls, dialCalls atomic.Int32
	withTestHTTPClient(t, &http.Client{Transport: &http.Transport{Proxy: func(*http.Request) (*url.URL, error) {
		proxyCalls.Add(1)
		return nil, errors.New("environment proxy must not resolve scan target")
	}}}, func() {
		d, err := newDiscovery(target)
		if err != nil {
			t.Fatal(err)
		}
		defer d.client.CloseIdleConnections()
		d.lookupIPAddr = func(context.Context, string) ([]net.IPAddr, error) {
			if lookupCalls.Add(1) == 1 {
				return []net.IPAddr{{IP: net.ParseIP("8.8.8.8")}}, nil
			}
			return []net.IPAddr{{IP: net.ParseIP("127.0.0.1")}}, nil
		}
		d.dialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
			dialCalls.Add(1)
			if !strings.HasPrefix(address, "8.8.8.8:") {
				return nil, fmt.Errorf("unapproved DNS-flipped destination %s", address)
			}
			return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
		}
		for range 2 {
			body, _, _, err := d.fetchURLOnce(context.Background(), target, sitemapFetchProfiles[0])
			if err != nil || !strings.Contains(string(body), "urlset") {
				t.Fatalf("pinned fetch failed: body=%q err=%v", body, err)
			}
		}
	})
	if lookupCalls.Load() != 1 || dialCalls.Load() != 2 || proxyCalls.Load() != 0 {
		t.Fatalf("lookups=%d dials=%d proxy calls=%d", lookupCalls.Load(), dialCalls.Load(), proxyCalls.Load())
	}
}

func TestDiscoveryLookupFailureNeverFallsBackToDefaultDial(t *testing.T) {
	d, err := newDiscovery("http://unresolved.example/sitemap.xml")
	if err != nil {
		t.Fatal(err)
	}
	defer d.client.CloseIdleConnections()
	d.lookupIPAddr = func(context.Context, string) ([]net.IPAddr, error) {
		return nil, errors.New("DNS unavailable")
	}
	var dials atomic.Int32
	d.dialContext = func(context.Context, string, string) (net.Conn, error) {
		dials.Add(1)
		return nil, errors.New("unexpected dial")
	}
	_, _, _, err = d.fetchURLOnce(context.Background(), "http://unresolved.example/sitemap.xml", sitemapFetchProfiles[0])
	if err == nil || !strings.Contains(err.Error(), "DNS unavailable") || dials.Load() != 0 {
		t.Fatalf("lookup failure fell through: err=%v dials=%d", err, dials.Load())
	}
}

func TestDiscoveryRejectsMixedInitialDNSAnswerBeforeDial(t *testing.T) {
	d, err := newDiscovery("http://mixed.example/sitemap.xml")
	if err != nil {
		t.Fatal(err)
	}
	defer d.client.CloseIdleConnections()
	var lookups atomic.Int32
	d.lookupIPAddr = func(context.Context, string) ([]net.IPAddr, error) {
		if lookups.Add(1) == 1 {
			return []net.IPAddr{{IP: net.ParseIP("8.8.8.8")}, {IP: net.ParseIP("127.0.0.1")}}, nil
		}
		return []net.IPAddr{{IP: net.ParseIP("127.0.0.1")}}, nil
	}
	var dials atomic.Int32
	d.dialContext = func(context.Context, string, string) (net.Conn, error) {
		dials.Add(1)
		return nil, errors.New("unexpected dial")
	}
	_, err = d.fetchURL(context.Background(), "http://mixed.example/sitemap.xml")
	if !errors.Is(err, errMixedRootDNS) || lookups.Load() != 1 || dials.Load() != 0 {
		t.Fatalf("mixed answer was retried or dialed: err=%v lookups=%d dials=%d", err, lookups.Load(), dials.Load())
	}
}

func TestDiscoveryRecordsPublicAnswerBeforeFirstDialAndRejectsReboundRoot(t *testing.T) {
	publicSeen := false
	observe := func(_ context.Context, public, nonPublic bool) error {
		if publicSeen && nonPublic {
			return errors.New("root previously resolved publicly")
		}
		if public {
			publicSeen = true
		}
		return nil
	}
	first, err := newDiscovery("http://changing.example/sitemap.xml")
	if err != nil {
		t.Fatal(err)
	}
	defer first.client.CloseIdleConnections()
	first.observeRootDNS = observe
	first.lookupIPAddr = func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("8.8.8.8")}}, nil
	}
	var publicDials atomic.Int32
	first.dialContext = func(_ context.Context, _, address string) (net.Conn, error) {
		if !publicSeen || address != "8.8.8.8:80" {
			t.Fatalf("public observation did not precede pinned dial: %q", address)
		}
		publicDials.Add(1)
		return nil, errors.New("fixture dial ended")
	}
	_, _ = first.dialPinnedAddress(context.Background(), "tcp", "changing.example:80")
	if !publicSeen || publicDials.Load() != 1 {
		t.Fatalf("public observation/dial missing: observed=%t dials=%d", publicSeen, publicDials.Load())
	}

	second, err := newDiscovery("http://changing.example/sitemap.xml")
	if err != nil {
		t.Fatal(err)
	}
	defer second.client.CloseIdleConnections()
	second.observeRootDNS = observe
	second.lookupIPAddr = func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("169.254.169.254")}}, nil
	}
	var privateDials atomic.Int32
	second.dialContext = func(context.Context, string, string) (net.Conn, error) {
		privateDials.Add(1)
		return nil, errors.New("private dial must not run")
	}
	_, err = second.dialPinnedAddress(context.Background(), "tcp", "changing.example:80")
	if err == nil || !strings.Contains(err.Error(), "previously resolved publicly") || privateDials.Load() != 0 {
		t.Fatalf("rebound address reached dial: err=%v private dials=%d", err, privateDials.Load())
	}
}

func TestDiscoveryRechecksPrivatePinnedRootAtEveryDial(t *testing.T) {
	d, err := newDiscovery("http://private.example/sitemap.xml")
	if err != nil {
		t.Fatal(err)
	}
	defer d.client.CloseIdleConnections()
	d.lookupIPAddr = func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("127.0.0.1")}}, nil
	}
	publicSeen := false
	d.privateDialGuard = func(context.Context) (func(), error) {
		if publicSeen {
			return nil, errors.New("private root no longer allowed")
		}
		return func() {}, nil
	}
	var dials atomic.Int32
	d.dialContext = func(context.Context, string, string) (net.Conn, error) {
		dials.Add(1)
		return nil, errors.New("fixture dial stopped")
	}
	_, _ = d.dialPinnedAddress(context.Background(), "tcp", "private.example:80")
	publicSeen = true
	_, err = d.dialPinnedAddress(context.Background(), "tcp", "private.example:80")
	if err == nil || !strings.Contains(err.Error(), "no longer allowed") || dials.Load() != 1 {
		t.Fatalf("stale private pin bypassed guard: err=%v dials=%d", err, dials.Load())
	}
}

func TestDiscoveryKeepsPrivateDialLeaseUntilLosingAttemptStops(t *testing.T) {
	d, err := newDiscovery("http://private.example/sitemap.xml")
	if err != nil {
		t.Fatal(err)
	}
	defer d.client.CloseIdleConnections()
	d.lookupIPAddr = func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("10.0.0.1")}, {IP: net.ParseIP("10.0.0.2")}}, nil
	}
	leaseReleased := make(chan struct{})
	d.privateDialGuard = func(context.Context) (func(), error) {
		return func() { close(leaseReleased) }, nil
	}
	stalled := make(chan struct{})
	cancelled := make(chan struct{})
	allowExit := make(chan struct{})
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(allowExit) }) }
	defer release()
	var peer net.Conn
	d.dialContext = func(dialCtx context.Context, _, address string) (net.Conn, error) {
		if address == "10.0.0.1:80" {
			close(stalled)
			<-dialCtx.Done()
			close(cancelled)
			<-allowExit
			return nil, dialCtx.Err()
		}
		<-stalled
		client, other := net.Pipe()
		peer = other
		return client, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	type outcome struct {
		conn net.Conn
		err  error
	}
	returned := make(chan outcome, 1)
	go func() {
		conn, err := d.dialPinnedAddress(ctx, "tcp", "private.example:80")
		returned <- outcome{conn, err}
	}()
	select {
	case <-cancelled:
	case <-ctx.Done():
		t.Fatal("losing private dial was not cancelled")
	}
	select {
	case <-leaseReleased:
		t.Fatal("private-root lease released while a dial was still in flight")
	case <-time.After(20 * time.Millisecond):
	}
	release()
	select {
	case result := <-returned:
		if result.err != nil {
			t.Fatal(result.err)
		}
		_ = result.conn.Close()
		_ = peer.Close()
	case <-ctx.Done():
		t.Fatal("winner did not return after the losing dial ended")
	}
	select {
	case <-leaseReleased:
	default:
		t.Fatal("private-root lease remained held after every dial ended")
	}
}

func TestDiscoveryPinnedDualStackFallsBackFromUnreachableIPv6(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `<urlset><url><loc>http://dual.example/page</loc></url></urlset>`)
	}))
	defer server.Close()
	parsed, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	target := "http://dual.example:" + parsed.Port() + "/sitemap.xml"
	d, err := newDiscovery(target)
	if err != nil {
		t.Fatal(err)
	}
	defer d.client.CloseIdleConnections()
	d.lookupIPAddr = func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{
			{IP: net.ParseIP("2001:4860:4860::8888")},
			{IP: net.ParseIP("2001:4860:4860::8844")},
			{IP: net.ParseIP("8.8.8.8")},
		}, nil
	}
	d.dialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		if strings.HasPrefix(address, "8.8.8.8:") {
			return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
		}
		<-ctx.Done() // Simulate an unreachable IPv6 address.
		return nil, ctx.Err()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	body, _, _, err := d.fetchURLOnce(ctx, target, sitemapFetchProfiles[0])
	if err != nil || !strings.Contains(string(body), "urlset") {
		t.Fatalf("dual-stack fallback failed: body=%q err=%v", body, err)
	}
}

func TestDiscoveryPinnedThirdAddressAfterTwoBlackholedDials(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `<urlset><url><loc>http://fallback.example/page</loc></url></urlset>`)
	}))
	defer server.Close()
	parsed, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	target := "http://fallback.example:" + parsed.Port() + "/sitemap.xml"
	d, err := newDiscovery(target)
	if err != nil {
		t.Fatal(err)
	}
	defer d.client.CloseIdleConnections()
	d.dialTimeout = 25 * time.Millisecond
	var lookups, attempts atomic.Int32
	d.lookupIPAddr = func(context.Context, string) ([]net.IPAddr, error) {
		lookups.Add(1)
		return []net.IPAddr{
			{IP: net.ParseIP("8.8.8.8")},
			{IP: net.ParseIP("8.8.4.4")},
			{IP: net.ParseIP("1.1.1.1")},
		}, nil
	}
	d.dialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		attempts.Add(1)
		if strings.HasPrefix(address, "1.1.1.1:") {
			return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
		}
		if !strings.HasPrefix(address, "8.8.8.8:") && !strings.HasPrefix(address, "8.8.4.4:") {
			return nil, fmt.Errorf("unapproved destination %s", address)
		}
		<-ctx.Done() // The two first pinned addresses never answer.
		return nil, ctx.Err()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	body, _, _, err := d.fetchURLOnce(ctx, target, sitemapFetchProfiles[0])
	if err != nil || !strings.Contains(string(body), "urlset") {
		t.Fatalf("third pinned address was starved: body=%q err=%v", body, err)
	}
	if lookups.Load() != 1 || attempts.Load() != 3 {
		t.Fatalf("lookups=%d dial attempts=%d, want one lookup and three pinned attempts", lookups.Load(), attempts.Load())
	}
}

func TestPinnedDialAttemptBudgetReservesTimeForLaterAddresses(t *testing.T) {
	if got := pinnedDialAttemptBudget(context.Background(), 3, pinnedDialTimeout); got != pinnedDialTimeout {
		t.Fatalf("unconstrained attempt = %v, want %v", got, pinnedDialTimeout)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	got := pinnedDialAttemptBudget(ctx, 3, pinnedDialTimeout)
	if got <= 0 || got > time.Second {
		t.Fatalf("three-address attempt = %v, want a positive share under one second", got)
	}
}

func TestDiscoveryPreservesPrivateLocalhostRoot(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `<urlset><url><loc>http://localhost/page</loc></url></urlset>`)
	}))
	defer server.Close()
	rootIP, port, err := net.SplitHostPort(server.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	target := "http://localhost:" + port + "/sitemap.xml"
	d, err := newDiscovery(target)
	if err != nil {
		t.Fatal(err)
	}
	defer d.client.CloseIdleConnections()
	d.lookupIPAddr = func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP(rootIP)}}, nil
	}
	body, _, _, err := d.fetchURLOnce(context.Background(), target, sitemapFetchProfiles[0])
	if err != nil || !strings.Contains(string(body), "urlset") {
		t.Fatalf("private localhost scan failed: body=%q err=%v", body, err)
	}
}

func TestDiscoveryPreservesHTTPSHostSNIAndBasicAuth(t *testing.T) {
	type observedRequest struct{ host, sni, auth string }
	observed := make(chan observedRequest, 1)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		request := observedRequest{host: r.Host, sni: r.TLS.ServerName}
		user, password, ok := r.BasicAuth()
		if ok {
			request.auth = user + ":" + password
		}
		observed <- request
		fmt.Fprint(w, `<urlset><url><loc>https://example.com/page</loc></url></urlset>`)
	}))
	defer server.Close()
	parsed, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	target := "https://alice:s%40cret@example.com:" + parsed.Port() + "/sitemap.xml"
	client := server.Client()
	transport, ok := client.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("unexpected TLS test transport %T", client.Transport)
	}
	var bypassCalls atomic.Int32
	transport.DialTLSContext = func(context.Context, string, string) (net.Conn, error) {
		bypassCalls.Add(1)
		return nil, errors.New("TLS dial bypassed pinned address")
	}
	withTestHTTPClient(t, client, func() {
		d, err := newDiscovery(target)
		if err != nil {
			t.Fatal(err)
		}
		defer d.client.CloseIdleConnections()
		d.lookupIPAddr = func(context.Context, string) ([]net.IPAddr, error) {
			return []net.IPAddr{{IP: net.ParseIP("8.8.8.8")}}, nil
		}
		d.dialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
			if !strings.HasPrefix(address, "8.8.8.8:") {
				return nil, fmt.Errorf("unexpected destination %s", address)
			}
			return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
		}
		body, _, _, err := d.fetchURLOnce(context.Background(), target, sitemapFetchProfiles[0])
		if err != nil || !strings.Contains(string(body), "urlset") {
			t.Fatalf("authenticated HTTPS fetch failed: body=%q err=%v", body, err)
		}
	})
	request := <-observed
	if request.host != "example.com:"+parsed.Port() || request.sni != "example.com" || request.auth != "alice:s@cret" || bypassCalls.Load() != 0 {
		t.Fatalf("HTTPS identity/auth changed: Host=%q SNI=%q auth=%q bypass=%d", request.host, request.sni, request.auth, bypassCalls.Load())
	}
}
