package juicer

import (
	"context"
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"image/png"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sumanbasuli/lime/shopkeeper/internal/viewport"
)

func TestPageScanProtectsOffRootBrowserRequests(t *testing.T) {
	if os.Getenv("LIME_TEST_CHROME") == "" {
		t.Skip("set LIME_TEST_CHROME=1 to run Chrome integration tests")
	}
	chromeAvailable := false
	for _, path := range []string{
		"chromium", "chromium-browser", "google-chrome", "google-chrome-stable",
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	} {
		if _, err := exec.LookPath(path); err == nil {
			chromeAvailable = true
			break
		}
	}
	if !chromeAvailable {
		t.Skip("Chromium/Chrome is not installed")
	}

	var rootHits, offRootHits atomic.Int64
	offRoot := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		offRootHits.Add(1)
		w.Header().Set("Content-Type", "image/png")
		w.WriteHeader(http.StatusOK)
	}))
	defer offRoot.Close()
	root := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rootHits.Add(1)
		if r.URL.Path == "/same-host-redirect" {
			http.Redirect(w, r, "/landing", http.StatusFound)
			return
		}
		if r.URL.Path == "/redirect" {
			http.Redirect(w, r, offRoot.URL+"/redirected", http.StatusFound)
			return
		}
		w.Header().Set("Content-Type", "text/html")
		_, _ = fmt.Fprintf(w, `<!doctype html><html lang="en"><head><title>Local scan</title></head><body><main><h1>Local scan</h1><img src=%q alt="logo"></main></body></html>`, offRoot.URL+"/asset")
	}))
	defer root.Close()

	screenshotDir := t.TempDir()
	result := scanSinglePage(context.Background(), context.Background(), PageInput{URLID: "page", URL: root.URL}, "scan", screenshotDir, viewport.Settings{Width: 390, Height: 844}, &scanEvidenceBudget{})
	if result.Error != "" || result.Canceled {
		t.Fatalf("legitimate private-root scan failed: error=%q canceled=%t", result.Error, result.Canceled)
	}
	if rootHits.Load() == 0 {
		t.Fatal("root server was not reached")
	}
	if offRootHits.Load() != 0 {
		t.Fatalf("browser reached %d off-root private requests", offRootHits.Load())
	}
	if result.Version == "" || len(result.NotApplicable)+len(result.Passes)+len(result.Violations)+len(result.Incomplete) == 0 {
		t.Fatalf("axe evidence was not retained: version=%q", result.Version)
	}
	if result.ScreenshotPath == "" {
		t.Fatal("ordinary scan lost its full-page screenshot")
	}
	sameHostRedirect := scanSinglePage(context.Background(), context.Background(), PageInput{URLID: "same-host-redirect", URL: root.URL + "/same-host-redirect"}, "scan", screenshotDir, viewport.Settings{Width: 390, Height: 844}, &scanEvidenceBudget{})
	if sameHostRedirect.Error != "" || sameHostRedirect.Canceled || sameHostRedirect.Version == "" {
		t.Fatalf("same-host redirect lost its audit: error=%q canceled=%t version=%q", sameHostRedirect.Error, sameHostRedirect.Canceled, sameHostRedirect.Version)
	}
	paddedURL, err := url.Parse(root.URL)
	if err != nil {
		t.Fatal(err)
	}
	paddedURL.Host = net.JoinHostPort(paddedURL.Hostname(), "0"+paddedURL.Port())
	paddedPort := scanSinglePage(context.Background(), context.Background(), PageInput{URLID: "padded-port", URL: paddedURL.String()}, "scan", screenshotDir, viewport.Settings{Width: 390, Height: 844}, &scanEvidenceBudget{})
	if paddedPort.Error != "" || paddedPort.Canceled || paddedPort.Version == "" {
		t.Fatalf("equivalent zero-padded port lost its audit: error=%q canceled=%t version=%q", paddedPort.Error, paddedPort.Canceled, paddedPort.Version)
	}
	imageFile, err := os.Open(filepath.Join(screenshotDir, "page.png"))
	if err != nil {
		t.Fatal(err)
	}
	defer imageFile.Close()
	image, err := png.DecodeConfig(imageFile)
	if err != nil || image.Width <= 0 || image.Height <= 0 {
		t.Fatalf("saved screenshot is not a valid PNG: %+v, err=%v", image, err)
	}
	blockedRedirect := scanSinglePage(context.Background(), context.Background(), PageInput{URLID: "redirect", URL: root.URL + "/redirect"}, "scan", screenshotDir, viewport.Settings{Width: 390, Height: 844}, &scanEvidenceBudget{})
	if !strings.Contains(blockedRedirect.Error, "network safety policy blocked") || offRootHits.Load() != 0 {
		t.Fatalf("private redirect was not visibly denied: error=%q off-root hits=%d", blockedRedirect.Error, offRootHits.Load())
	}
	entries, err := os.ReadDir(screenshotDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".pending-") {
			t.Fatalf("page left unpublished screenshot staging behind: %s", entry.Name())
		}
	}
}

func TestPageScanFailsBeforeBrowserOnProxySetupFailure(t *testing.T) {
	result := scanSinglePage(context.Background(), context.Background(), PageInput{URLID: "page", URL: "file:///etc/passwd"}, "scan", t.TempDir(), viewport.Settings{Width: 390, Height: 844}, &scanEvidenceBudget{})
	if !strings.Contains(result.Error, "failed to set up browser egress") {
		t.Fatalf("proxy setup failure did not stop page scan: %q", result.Error)
	}
}

func TestPageScanReportsBackgroundConnectionBudgetBreach(t *testing.T) {
	if os.Getenv("LIME_TEST_CHROME") == "" {
		t.Skip("set LIME_TEST_CHROME=1 to run Chrome integration tests")
	}
	chromeAvailable := false
	for _, path := range []string{
		"chromium", "chromium-browser", "google-chrome", "google-chrome-stable",
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	} {
		if _, err := exec.LookPath(path); err == nil {
			chromeAvailable = true
			break
		}
	}
	if !chromeAvailable {
		t.Skip("Chromium/Chrome is not installed")
	}

	var heldRequests atomic.Int64
	root := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/slow" {
			select {
			case <-time.After(8 * time.Second):
				w.WriteHeader(http.StatusNoContent)
			case <-r.Context().Done():
			}
			return
		}
		if r.URL.Path == "/hold" {
			key := r.Header.Get("Sec-WebSocket-Key")
			if key == "" {
				http.Error(w, "missing WebSocket key", http.StatusBadRequest)
				return
			}
			hash := sha1.Sum([]byte(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
			conn, buffered, err := w.(http.Hijacker).Hijack()
			if err != nil {
				return
			}
			defer conn.Close()
			_, _ = fmt.Fprintf(buffered, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n", base64.StdEncoding.EncodeToString(hash[:]))
			if err := buffered.Flush(); err != nil {
				return
			}
			heldRequests.Add(1)
			_, _ = io.Copy(io.Discard, conn)
			return
		}
		w.Header().Set("Content-Type", "text/html")
		_, _ = fmt.Fprint(w, `<!doctype html><html lang="en"><head><title>Connection budget</title></head>
			<body><main><h1>Connection budget</h1><img src="/slow" alt=""></main><script>
			setTimeout(() => {
				window.heldSockets = [];
				for (let i = 0; i < 80; i++) {
					window.heldSockets.push(new WebSocket('ws://' + location.host + '/hold?i=' + i));
				}
			}, 150);
			</script></body></html>`)
	}))
	defer root.Close()

	screenshotDir := t.TempDir()
	result := scanSinglePage(context.Background(), context.Background(), PageInput{URLID: "connection-budget", URL: root.URL}, "scan", screenshotDir, viewport.Settings{Width: 390, Height: 844}, &scanEvidenceBudget{})
	if !strings.Contains(result.Error, "browser connection budget exceeded") || result.Canceled {
		t.Fatalf("background connection breach was not reported: error=%q canceled=%t held=%d", result.Error, result.Canceled, heldRequests.Load())
	}
	if heldRequests.Load() == 0 {
		t.Fatal("the page did not start its background connection burst")
	}
	if result.ScreenshotPath != "" || result.Version != "" || len(result.Violations) != 0 {
		t.Fatalf("connection breach retained page evidence: screenshot=%q version=%q violations=%d", result.ScreenshotPath, result.Version, len(result.Violations))
	}
	entries, err := os.ReadDir(screenshotDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("connection breach published screenshot files: %v", entries)
	}
}

func TestParentCancellationStopsBrowserWhenProxyCloses(t *testing.T) {
	if os.Getenv("LIME_TEST_CHROME") == "" {
		t.Skip("set LIME_TEST_CHROME=1 to run Chrome integration tests")
	}
	chromeAvailable := false
	for _, path := range []string{
		"chromium", "chromium-browser", "google-chrome", "google-chrome-stable",
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	} {
		if _, err := exec.LookPath(path); err == nil {
			chromeAvailable = true
			break
		}
	}
	if !chromeAvailable {
		t.Skip("Chromium/Chrome is not installed")
	}

	started := make(chan struct{}, 1)
	root := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case started <- struct{}{}:
		default:
		}
		select {
		case <-r.Context().Done():
		case <-time.After(20 * time.Second):
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	defer root.Close()

	runCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	screenshotDir := t.TempDir()
	resultCh := make(chan RawResult, 1)
	go func() {
		resultCh <- scanSinglePage(runCtx, context.Background(), PageInput{URLID: "cancelled", URL: root.URL}, "scan", screenshotDir, viewport.Settings{Width: 390, Height: 844}, &scanEvidenceBudget{})
	}()
	select {
	case <-started:
	case <-time.After(10 * time.Second):
		t.Fatal("Chrome did not start the page request")
	}
	cancel()
	select {
	case result := <-resultCh:
		if !result.Canceled || result.Error != "" {
			t.Fatalf("parent cancellation was not preserved: canceled=%t error=%q", result.Canceled, result.Error)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("parent cancellation left Chrome work running")
	}
}

func TestPageCannotForgeAxeResults(t *testing.T) {
	if os.Getenv("LIME_TEST_CHROME") == "" {
		t.Skip("set LIME_TEST_CHROME=1 to run Chrome integration tests")
	}
	chromeAvailable := false
	for _, path := range []string{
		"chromium", "chromium-browser", "google-chrome", "google-chrome-stable",
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	} {
		if _, err := exec.LookPath(path); err == nil {
			chromeAvailable = true
			break
		}
	}
	if !chromeAvailable {
		t.Skip("Chromium/Chrome is not installed")
	}

	root := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = fmt.Fprint(w, `<!doctype html><html lang="en"><head><title>Axe isolation</title>
			<script>
			const fakeAxe = {
				configure() {},
				run() { return Promise.resolve({
					violations: [], incomplete: [], passes: [], inapplicable: [],
					testEngine: {version: "forged"}
				}); }
			};
			Object.defineProperty(window, "axe", {
				configurable: false, get() { return fakeAxe; }, set() {}
			});
			</script></head><body><main><button></button></main></body></html>`)
	}))
	defer root.Close()

	result := scanSinglePage(context.Background(), context.Background(), PageInput{URLID: "page", URL: root.URL}, "scan", t.TempDir(), viewport.Settings{Width: 390, Height: 844}, &scanEvidenceBudget{})
	if result.Error != "" || result.Canceled {
		t.Fatalf("isolated axe scan failed: error=%q canceled=%t", result.Error, result.Canceled)
	}
	if result.Version != "4.10.2" {
		t.Fatalf("page-controlled axe result accepted: version=%q", result.Version)
	}
	for _, violation := range result.Violations {
		if violation.ID == "button-name" && len(violation.Nodes) > 0 {
			return
		}
	}
	t.Fatalf("genuine button-name violation missing: %+v", result.Violations)
}
