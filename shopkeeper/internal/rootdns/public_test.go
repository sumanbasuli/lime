package rootdns

import (
	"net/netip"
	"testing"
)

func TestPublicIP(t *testing.T) {
	tests := []struct {
		name   string
		ip     string
		public bool
	}{
		{"public IPv4", "8.8.8.8", true},
		{"public IPv4 at another provider", "1.1.1.1", true},
		{"public IPv6", "2606:4700:4700::1111", true},
		{"public IPv6 at another provider", "2001:4860:4860::8888", true},
		{"mapped public IPv4", "::ffff:8.8.8.8", true},

		{"unspecified IPv4", "0.0.0.0", false},
		{"unspecified IPv6", "::", false},
		{"private IPv4 10/8", "10.1.2.3", false},
		{"private IPv4 172.16/12", "172.31.255.254", false},
		{"private IPv4 192.168/16", "192.168.1.1", false},
		{"private IPv6", "fd12:3456::1", false},
		{"mapped private IPv4", "::ffff:192.168.1.1", false},
		{"loopback IPv4", "127.0.0.1", false},
		{"loopback IPv6", "::1", false},
		{"mapped loopback IPv4", "::ffff:127.0.0.1", false},
		{"link-local IPv4", "169.254.1.2", false},
		{"link-local IPv6", "fe80::1", false},
		{"CGNAT lower bound", "100.64.0.0", false},
		{"CGNAT upper bound", "100.127.255.255", false},
		{"IPv4 documentation TEST-NET-1", "192.0.2.1", false},
		{"IPv4 documentation TEST-NET-2", "198.51.100.1", false},
		{"IPv4 documentation TEST-NET-3", "203.0.113.1", false},
		{"IPv6 documentation", "2001:db8::1", false},
		{"IPv6 documentation 3fff/20", "3fff::1", false},
		{"IPv4 protocol assignment", "192.0.0.1", false},
		{"IPv4 6to4 relay anycast", "192.88.99.1", false},
		{"IPv4 benchmarking", "198.18.0.1", false},
		{"IPv4 reserved", "240.0.0.1", false},
		{"IPv4 broadcast", "255.255.255.255", false},
		{"IPv6 special-purpose 2001/23", "2001::1", false},
		{"IPv6 6to4", "2002::1", false},
		{"IPv6 outside global-unicast allocation", "100::1", false},
		{"multicast IPv4", "224.0.0.1", false},
		{"multicast IPv6", "ff02::1", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := PublicIP(netip.MustParseAddr(tt.ip)); got != tt.public {
				t.Errorf("PublicIP(%q) = %t; want %t", tt.ip, got, tt.public)
			}
		})
	}
}

func TestPublicIPInvalidAddress(t *testing.T) {
	if PublicIP(netip.Addr{}) {
		t.Fatal("invalid IP address classified as public")
	}
}
