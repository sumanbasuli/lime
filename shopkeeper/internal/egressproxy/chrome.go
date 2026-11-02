package egressproxy

import (
	"context"
	"os/exec"

	"github.com/chromedp/chromedp"
)

// NewChromeAllocator starts a fresh browser process through the page's local
// egress proxy. It deliberately specifies one proxy with no DIRECT fallback.
// The other flags match the service's existing Chrome allocator.
func NewChromeAllocator(parent context.Context, proxyAddress string) (context.Context, context.CancelFunc) {
	// Unified-headless Chrome reads the regular policy switch; keep the force
	// switch below for older headless-shell builds.
	options := append(chromeAllocatorOptions(proxyAddress), chromedp.Flag("webrtc-ip-handling-policy", "disable_non_proxied_udp"))
	return chromedp.NewExecAllocator(parent, options...)
}

func chromeAllocatorOptions(proxyAddress string) []chromedp.ExecAllocatorOption {
	options := append([]chromedp.ExecAllocatorOption{}, chromedp.DefaultExecAllocatorOptions[:]...)
	options = append(options,
		// Explicit false also prevents chromedp's root-user automatic fallback.
		chromedp.Flag("no-sandbox", false),
		chromedp.DisableGPU,
		chromedp.Flag("disable-dev-shm-usage", true),
		chromedp.Flag("disable-extensions", true),
		chromedp.Flag("disable-background-networking", true),
		chromedp.Flag("disable-sync", true),
		chromedp.Flag("no-first-run", true),
		chromedp.Flag("proxy-server", "socks5://"+proxyAddress),
		chromedp.Flag("proxy-bypass-list", "<-loopback>"),
		chromedp.Flag("disable-quic", true),
		chromedp.Flag("force-webrtc-ip-handling-policy", "disable_non_proxied_udp"),
	)
	// Keep the service's explicit binary selection. When none of these paths is
	// installed, chromedp's platform-specific fallback remains in effect.
	if chromePath := findChromeBinary(); chromePath != "" {
		options = append(options, chromedp.ExecPath(chromePath))
	}
	return options
}

func findChromeBinary() string {
	for _, candidate := range []string{
		"chromium-browser", "chromium", "google-chrome", "google-chrome-stable",
		"/usr/bin/chromium-browser", "/usr/bin/chromium", "/usr/bin/google-chrome",
	} {
		if path, err := exec.LookPath(candidate); err == nil {
			return path
		}
	}
	return ""
}
