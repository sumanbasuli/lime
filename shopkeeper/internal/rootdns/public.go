// Package rootdns classifies root-address answers consistently across sitemap
// discovery, browser scans, and link checks.
package rootdns

import (
	"context"
	"errors"
	"net/netip"
)

// ErrBlocked is returned when a root answer violates the durable public-only
// policy. Callers may translate it to their own user-facing blocked outcome.
var ErrBlocked = errors.New("root DNS policy blocked nonpublic address")

// Observer validates a root DNS answer and durably records a public answer
// before the caller connects to any of those addresses.
type Observer func(context.Context, bool, bool) error

// PrivateDialGuard holds the job's public-only policy stable until a trusted
// private-root TCP connection has been established or failed. A public
// observation waits for active guards, and a guard started after it is blocked.
// The returned release function must be called on every path.
type PrivateDialGuard func(context.Context) (release func(), err error)

// Policy is the pair of checks a trusted root needs: observe the actual DNS
// answer, then hold a guard through any private TCP dial.
type Policy struct {
	Observe          Observer
	GuardPrivateDial PrivateDialGuard
}

var nonPublicRanges = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("192.0.0.0/24"), netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("192.88.99.0/24"), netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"), netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("240.0.0.0/4"), netip.MustParsePrefix("2001:db8::/32"),
	netip.MustParsePrefix("2001::/23"), netip.MustParsePrefix("2002::/16"),
	netip.MustParsePrefix("3fff::/20"),
}

// PublicIP reports whether ip is suitable for a public-root observation.
// A private-only root may still be intentionally scanned; the caller decides
// whether that answer is allowed by the job's durable policy.
func PublicIP(ip netip.Addr) bool {
	ip = ip.Unmap()
	if !ip.IsValid() || !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return false
	}
	if ip.Is6() && !netip.MustParsePrefix("2000::/3").Contains(ip) {
		return false
	}
	for _, prefix := range nonPublicRanges {
		if prefix.Contains(ip) {
			return false
		}
	}
	return true
}
