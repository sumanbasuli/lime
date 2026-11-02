package egressproxy

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/chromedp/chromedp"
)

func TestScanChromePreservesProxyAndSandbox(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix executable fixture")
	}
	dir := t.TempDir()
	argsPath := filepath.Join(dir, "args")
	if err := os.WriteFile(filepath.Join(dir, "chromium-browser"), []byte("#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$LIME_CHROME_ARGV_PATH\"\nexit 1\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	t.Setenv("LIME_CHROME_ARGV_PATH", argsPath)
	allocator, stop := NewChromeAllocator(context.Background(), "127.0.0.1:32123")
	defer stop()
	browser, cancel := chromedp.NewContext(allocator)
	defer cancel()
	ctx, timeout := context.WithTimeout(browser, 10*time.Second)
	defer timeout()
	if err := chromedp.Run(ctx); err == nil {
		t.Fatal("fixture browser unexpectedly started")
	}
	args, err := os.ReadFile(argsPath)
	if err != nil {
		t.Fatal(err)
	}
	flags := map[string]bool{}
	for _, arg := range strings.Split(string(args), "\n") {
		flags[arg] = true
		if arg == "--no-sandbox" || strings.HasPrefix(arg, "--no-sandbox=") {
			t.Fatalf("browser sandbox disabled: %q", arg)
		}
	}
	for _, want := range []string{"--proxy-server=socks5://127.0.0.1:32123", "--proxy-bypass-list=<-loopback>", "--disable-quic", "--webrtc-ip-handling-policy=disable_non_proxied_udp"} {
		if !flags[want] {
			t.Fatalf("scan browser lost %s", want)
		}
	}
}
