package egressproxy

import (
	"context"
	"encoding/binary"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/chromedp/cdproto/browser"
	"github.com/chromedp/cdproto/runtime"
	"github.com/chromedp/cdproto/security"
	"github.com/chromedp/chromedp"
)

type noDNSResolver struct{}

func (noDNSResolver) LookupIPAddr(context.Context, string) ([]net.IPAddr, error) {
	return nil, fmt.Errorf("DNS is disabled in the localhost-only WebRTC fixture")
}

func requireChrome(t *testing.T) {
	t.Helper()
	if os.Getenv("LIME_TEST_CHROME") == "" {
		t.Skip("set LIME_TEST_CHROME=1 to run Chrome integration tests")
	}
	for _, path := range []string{
		"chromium", "chromium-browser", "google-chrome", "google-chrome-stable",
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	} {
		if _, err := exec.LookPath(path); err == nil {
			return
		}
	}
	t.Skip("Chromium/Chrome is not installed")
}

func chromeTab(t *testing.T, proxy *Proxy) context.Context {
	t.Helper()
	allocCtx, allocCancel := NewChromeAllocator(context.Background(), proxy.Address())
	t.Cleanup(allocCancel)
	tabCtx, tabCancel := chromedp.NewContext(allocCtx)
	t.Cleanup(tabCancel)
	ctx, cancel := context.WithTimeout(tabCtx, 15*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func TestChromeRoutesHTTPSubresourcesAndRedirectsThroughProxy(t *testing.T) {
	requireChrome(t)
	var offRootHits atomic.Int64
	offRoot := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		offRootHits.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer offRoot.Close()
	root := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/redirect":
			http.Redirect(w, r, offRoot.URL+"/redirected", http.StatusFound)
		default:
			_, _ = fmt.Fprintf(w, `<html><body><img src=%q><iframe src=%q></iframe><p>root loaded</p><script>fetch(%q).catch(() => {}); new WebSocket(%q);</script></body></html>`,
				offRoot.URL+"/asset", offRoot.URL+"/frame", offRoot.URL+"/fetch", strings.Replace(offRoot.URL, "http://", "ws://", 1)+"/socket")
		}
	}))
	defer root.Close()

	proxy, err := Start(context.Background(), root.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer proxy.Close()
	ctx := chromeTab(t, proxy)
	var body string
	if err := chromedp.Run(ctx, chromedp.Navigate(root.URL), chromedp.Text("body", &body), chromedp.Sleep(300*time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(body, "root loaded") {
		t.Fatalf("legitimate private root did not load: %q", body)
	}
	if offRootHits.Load() != 0 || proxy.DeniedCount() < 3 {
		t.Fatalf("private off-root image/frame/fetch/WebSocket was not blocked: hits=%d denials=%d", offRootHits.Load(), proxy.DeniedCount())
	}

	before := proxy.DeniedCount()
	redirectErr := chromedp.Run(ctx, chromedp.Navigate(root.URL+"/redirect"))
	t.Logf("blocked redirect navigation: %v", redirectErr)
	if offRootHits.Load() != 0 || proxy.DeniedCount() <= before {
		t.Fatalf("private off-root redirect was not blocked: hits=%d denials=%d", offRootHits.Load(), proxy.DeniedCount())
	}
}

func TestChromePayloadBudgetAllowsSmallPageAndStopsLargePage(t *testing.T) {
	requireChrome(t)
	root := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		if r.URL.Path == "/large" {
			_, _ = fmt.Fprint(w, "<!doctype html><body>", strings.Repeat("x", 2<<20), "</body>")
			return
		}
		_, _ = fmt.Fprint(w, "<!doctype html><body>small page loaded</body>")
	}))
	defer root.Close()
	startLimited := func(t *testing.T) *Proxy {
		t.Helper()
		limits := payloadLimits(1<<20, 4<<20)
		limits.livePerPage = maxLiveConnectionsPerPage
		limits.acceptedPerPage = maxAcceptedConnectionsPage
		limits.processSlots = make(chan struct{}, maxLiveConnectionsPerProcess)
		proxy, err := startWithLimits(context.Background(), root.URL, net.DefaultResolver, (&net.Dialer{Timeout: connectTimeout}).DialContext, nil, limits)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = proxy.Close() })
		return proxy
	}

	small := startLimited(t)
	var body string
	if err := chromedp.Run(chromeTab(t, small), chromedp.Navigate(root.URL+"/small"), chromedp.Text("body", &body)); err != nil {
		t.Fatalf("small Chrome page: %v (budget hit=%t, payload hit=%t, used=%d, denied=%d)", err, small.BudgetExceeded(), small.PayloadBudgetExceeded(), payloadUsage(small.processPayload), small.DeniedCount())
	}
	if body != "small page loaded" || small.BudgetExceeded() {
		t.Fatalf("below-budget Chrome page failed: body=%q hit=%t", body, small.BudgetExceeded())
	}
	if err := small.Close(); err != nil {
		t.Fatal(err)
	}

	large := startLimited(t)
	ctx, cancel := context.WithTimeout(chromeTab(t, large), 5*time.Second)
	defer cancel()
	_ = chromedp.Run(ctx, chromedp.Navigate(root.URL+"/large"))
	select {
	case <-large.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("large Chrome response did not hit the payload budget")
	}
	if err := large.Close(); err != nil {
		t.Fatal(err)
	}
	if !large.PayloadBudgetExceeded() {
		t.Fatal("large Chrome response did not record a payload budget breach")
	}
}

func TestChromePreservesHTTPSHostAndSNI(t *testing.T) {
	requireChrome(t)
	var offRootHits atomic.Int64
	offRoot := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		offRootHits.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer offRoot.Close()
	offRootParsed, err := url.Parse(offRoot.URL)
	if err != nil {
		t.Fatal(err)
	}
	_, offRootPort, err := net.SplitHostPort(offRootParsed.Host)
	if err != nil {
		t.Fatal(err)
	}
	seen := make(chan [2]string, 1)
	root := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		username, password, ok := r.BasicAuth()
		if !ok || username != "alice" || password != "p@ss" {
			w.Header().Set("WWW-Authenticate", `Basic realm="scan"`)
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		select {
		case seen <- [2]string{r.Host, r.TLS.ServerName}:
		default:
		}
		w.Header().Set("Content-Type", "text/html")
		_, _ = fmt.Fprintf(w, `<html><body><p>secure root loaded</p><img src=%q><script>new WebSocket(%q);</script></body></html>`,
			"https://localhost:"+offRootPort+"/asset", "wss://localhost:"+offRootPort+"/socket")
	}))
	defer root.Close()
	parsed, err := url.Parse(root.URL)
	if err != nil {
		t.Fatal(err)
	}
	_, port, err := net.SplitHostPort(parsed.Host)
	if err != nil {
		t.Fatal(err)
	}
	parsed.Host = "localhost:" + port
	parsed.User = url.UserPassword("alice", "p@ss")
	rootURL := parsed.String()
	proxy, err := Start(context.Background(), rootURL)
	if err != nil {
		t.Fatal(err)
	}
	defer proxy.Close()
	ctx := chromeTab(t, proxy)
	var body string
	if err := chromedp.Run(ctx, security.SetIgnoreCertificateErrors(true), chromedp.Navigate(rootURL), chromedp.Text("body", &body), chromedp.Sleep(300*time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(body, "secure root loaded") {
		t.Fatalf("HTTPS root body = %q", body)
	}
	select {
	case got := <-seen:
		if got[0] != "localhost:"+port || got[1] != "localhost" {
			t.Fatalf("proxy changed Host/SNI: %v", got)
		}
	case <-time.After(time.Second):
		t.Fatal("HTTPS server did not observe browser request")
	}
	if offRootHits.Load() != 0 || proxy.DeniedCount() < 2 {
		t.Fatalf("private HTTPS/WSS off-root requests escaped policy: hits=%d denials=%d", offRootHits.Load(), proxy.DeniedCount())
	}
}

func TestChromeDoesNotGoDirectWhenProxyIsUnavailable(t *testing.T) {
	requireChrome(t)
	var hits atomic.Int64
	root := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		_, _ = w.Write([]byte("should not load"))
	}))
	defer root.Close()
	proxy, err := Start(context.Background(), root.URL)
	if err != nil {
		t.Fatal(err)
	}
	ctx := chromeTab(t, proxy)
	if err := proxy.Close(); err != nil {
		t.Fatal(err)
	}
	_ = chromedp.Run(ctx, chromedp.Navigate(root.URL))
	if hits.Load() != 0 {
		t.Fatalf("Chrome bypassed a failed proxy with %d direct requests", hits.Load())
	}
}

func TestChromeWebRTCSTUNDoesNotBypassProxy(t *testing.T) {
	requireChrome(t)
	root := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte("<!doctype html><title>WebRTC egress fixture</title>"))
	}))
	defer root.Close()
	proxy, err := start(context.Background(), root.URL, noDNSResolver{}, func(ctx context.Context, network, address string) (net.Conn, error) {
		host, _, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		ip := net.ParseIP(host)
		if network != "tcp" || ip == nil || !ip.IsLoopback() {
			return nil, fmt.Errorf("non-loopback proxy dial in WebRTC fixture: %s %s", network, address)
		}
		return (&net.Dialer{}).DialContext(ctx, network, address)
	})
	if err != nil {
		t.Fatal(err)
	}
	defer proxy.Close()

	probe := func(t *testing.T, unprotected bool) bool {
		t.Helper()
		udp, err := net.ListenPacket("udp4", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		defer udp.Close()
		stunURL := fmt.Sprintf("stun:127.0.0.1:%d", udp.LocalAddr().(*net.UDPAddr).Port)

		var allocCtx context.Context
		var allocCancel context.CancelFunc
		if unprotected {
			// Only the WebRTC policy differs from the production browser.
			options := append(chromeAllocatorOptions(proxy.Address()), chromedp.Flag("force-webrtc-ip-handling-policy", "default"))
			allocCtx, allocCancel = chromedp.NewExecAllocator(context.Background(), options...)
		} else {
			allocCtx, allocCancel = NewChromeAllocator(context.Background(), proxy.Address())
		}
		defer allocCancel()
		tabCtx, tabCancel := chromedp.NewContext(allocCtx)
		defer tabCancel()
		ctx, cancel := context.WithTimeout(tabCtx, 15*time.Second)
		defer cancel()

		var state struct {
			DescriptionSet bool   `json:"descriptionSet"`
			GatheringState string `json:"gatheringState"`
		}
		var commandLine []string
		var chromeProduct string
		script := fmt.Sprintf(`(async () => {
			const pc = new RTCPeerConnection({iceServers: [{urls: %q}], iceTransportPolicy: "all"});
			window.__webrtcProbe = pc;
			pc.createDataChannel("probe");
			await pc.setLocalDescription(await pc.createOffer());
			return {descriptionSet: !!pc.localDescription, gatheringState: pc.iceGatheringState};
		})()`, stunURL)
		if err := chromedp.Run(ctx,
			chromedp.Navigate(root.URL),
			chromedp.ActionFunc(func(ctx context.Context) error {
				var err error
				commandLine, err = browser.GetBrowserCommandLine().Do(ctx)
				if err != nil {
					return err
				}
				_, chromeProduct, _, _, _, err = browser.GetVersion().Do(ctx)
				return err
			}),
			chromedp.Evaluate(script, &state, func(p *runtime.EvaluateParams) *runtime.EvaluateParams {
				return p.WithAwaitPromise(true)
			}),
		); err != nil {
			t.Fatalf("start WebRTC ICE gathering: %v", err)
		}
		policy := "disable_non_proxied_udp"
		if unprotected {
			policy = "default"
		}
		if !slices.Contains(commandLine, "--force-webrtc-ip-handling-policy="+policy) ||
			!slices.Contains(commandLine, "--proxy-server=socks5://"+proxy.Address()) ||
			!slices.Contains(commandLine, "--proxy-bypass-list=<-loopback>") {
			t.Fatalf("Chrome did not receive the expected proxy and WebRTC flags: policy=%s", policy)
		}
		if !unprotected && !slices.Contains(commandLine, "--webrtc-ip-handling-policy=disable_non_proxied_udp") {
			t.Fatal("Chrome did not receive the WebRTC IP handling policy")
		}
		t.Logf("%s command line confirmed policy=%s, SOCKS proxy=%s", chromeProduct, policy, proxy.Address())
		if !state.DescriptionSet {
			t.Fatalf("WebRTC local description was not set: %+v", state)
		}
		t.Logf("ICE state after local description: %s", state.GatheringState)

		if err := udp.SetReadDeadline(time.Now().Add(4 * time.Second)); err != nil {
			t.Fatal(err)
		}
		var packet [1500]byte
		observed := false
		for {
			n, source, err := udp.ReadFrom(packet[:])
			if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
				break
			}
			if err != nil {
				t.Fatal(err)
			}
			if n >= 20 && binary.BigEndian.Uint16(packet[:2]) == 1 && binary.BigEndian.Uint32(packet[4:8]) == 0x2112a442 &&
				int(binary.BigEndian.Uint16(packet[2:4]))+20 <= n {
				t.Logf("received STUN Binding Request from %s", source)
				observed = true
				break
			}
		}
		if err := chromedp.Run(ctx, chromedp.Evaluate("window.__webrtcProbe.iceGatheringState", &state.GatheringState)); err != nil {
			t.Fatalf("read WebRTC ICE gathering state: %v", err)
		}
		if !unprotected && state.GatheringState != "complete" {
			t.Fatalf("protected WebRTC ICE gathering did not complete: %s", state.GatheringState)
		}
		t.Logf("ICE state after UDP observation: %s", state.GatheringState)
		return observed
	}

	if !t.Run("positive-control", func(t *testing.T) {
		if !probe(t, true) {
			t.Fatal("Chrome did not send localhost STUN with the default WebRTC policy; protected result would be inconclusive")
		}
	}) {
		return
	}
	t.Run("production-policy", func(t *testing.T) {
		if probe(t, false) {
			t.Fatal("Chrome sent STUN directly to localhost despite disable_non_proxied_udp")
		}
	})
}

func TestChromePrivateRootDefaultPortRedirectUsesPinnedIP(t *testing.T) {
	requireChrome(t)
	var httpHits, httpsHits atomic.Int64
	seen := make(chan [2]string, 1)
	httpsRoot := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		httpsHits.Add(1)
		select {
		case seen <- [2]string{r.Host, r.TLS.ServerName}:
		default:
		}
		_, _ = w.Write([]byte("redirected private root loaded"))
	}))
	defer httpsRoot.Close()
	httpRoot := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		httpHits.Add(1)
		http.Redirect(w, r, "https://private.test/landing", http.StatusFound)
	}))
	defer httpRoot.Close()
	resolver := &stagedResolver{answers: map[string][][]net.IPAddr{
		"private.test": {ipAnswers("127.0.0.1"), ipAnswers("8.8.8.8")},
	}}
	proxy, err := start(context.Background(), "http://private.test", resolver, func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		if host != "127.0.0.1" {
			return nil, fmt.Errorf("redirect did not use pinned root IP: %s", address)
		}
		endpoint := httpRoot.URL
		if port == "443" {
			endpoint = httpsRoot.URL
		} else if port != "80" {
			return nil, fmt.Errorf("unexpected root port %s", port)
		}
		u, err := url.Parse(endpoint)
		if err != nil {
			return nil, err
		}
		return (&net.Dialer{}).DialContext(ctx, network, u.Host)
	})
	if err != nil {
		t.Fatal(err)
	}
	defer proxy.Close()
	ctx := chromeTab(t, proxy)
	var body string
	if err := chromedp.Run(ctx, security.SetIgnoreCertificateErrors(true), chromedp.Navigate("http://private.test"), chromedp.Text("body", &body)); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(body, "redirected private root loaded") || httpHits.Load() == 0 || httpsHits.Load() == 0 {
		t.Fatalf("same-host default-port redirect failed: body=%q http=%d https=%d", body, httpHits.Load(), httpsHits.Load())
	}
	select {
	case got := <-seen:
		if got != [2]string{"private.test", "private.test"} {
			t.Fatalf("redirect changed Host/SNI: %v", got)
		}
	case <-time.After(time.Second):
		t.Fatal("redirected HTTPS request was not observed")
	}
}
