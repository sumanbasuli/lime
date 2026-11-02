package egressproxy

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sumanbasuli/lime/shopkeeper/internal/rootdns"
)

type stagedResolver struct {
	mu      sync.Mutex
	answers map[string][][]net.IPAddr
	fails   map[string]error
}

func (r *stagedResolver) LookupIPAddr(_ context.Context, host string) ([]net.IPAddr, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.fails[host]; err != nil {
		return nil, err
	}
	stages := r.answers[host]
	if len(stages) == 0 {
		return nil, errors.New("unconfigured hostname")
	}
	answer := stages[0]
	if len(stages) > 1 {
		r.answers[host] = stages[1:]
	}
	return answer, nil
}

func ipAnswers(values ...string) []net.IPAddr {
	answers := make([]net.IPAddr, 0, len(values))
	for _, value := range values {
		answers = append(answers, net.IPAddr{IP: net.ParseIP(value)})
	}
	return answers
}

type recordingDialer struct {
	mu      sync.Mutex
	more    []net.Conn
	targets []string
}

func (d *recordingDialer) dial(_ context.Context, _, address string) (net.Conn, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	client, upstream := net.Pipe()
	d.more = append(d.more, upstream)
	d.targets = append(d.targets, address)
	return client, nil
}

func (d *recordingDialer) close() {
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, conn := range d.more {
		_ = conn.Close()
	}
}

func (d *recordingDialer) dialed() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string(nil), d.targets...)
}

func (d *recordingDialer) upstream(t *testing.T, index int) net.Conn {
	t.Helper()
	d.mu.Lock()
	defer d.mu.Unlock()
	if index >= len(d.more) {
		t.Fatalf("upstream %d was not dialed", index)
	}
	return d.more[index]
}

func payloadUsage(budget *payloadBudget) int64 {
	budget.mu.Lock()
	defer budget.mu.Unlock()
	return budget.used
}

func transferPayload(from, to net.Conn, data []byte) error {
	deadline := time.Now().Add(2 * time.Second)
	_ = from.SetWriteDeadline(deadline)
	_ = to.SetReadDeadline(deadline)
	defer from.SetWriteDeadline(time.Time{})
	defer to.SetReadDeadline(time.Time{})
	written := make(chan error, 1)
	go func() {
		n, err := from.Write(data)
		if err == nil && n != len(data) {
			err = io.ErrShortWrite
		}
		written <- err
	}()
	received := make([]byte, len(data))
	if _, err := io.ReadFull(to, received); err != nil {
		return err
	}
	if err := <-written; err != nil {
		return err
	}
	if !bytes.Equal(received, data) {
		return errors.New("relayed payload differs from sent payload")
	}
	return nil
}

func payloadLimits(page, process int64) connectionLimits {
	return connectionLimits{
		livePerPage: 4, acceptedPerPage: 16, processSlots: make(chan struct{}, 8),
		payloadPerPage: page, processPayload: newPayloadBudget(process),
	}
}

func waitForPayloadBreach(t *testing.T, proxy *Proxy) {
	t.Helper()
	select {
	case <-proxy.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("payload breach did not close the proxy")
	}
	if !proxy.PayloadBudgetExceeded() || !proxy.BudgetExceeded() {
		t.Fatal("proxy closed without recording the payload budget breach")
	}
}

func socksConnect(t *testing.T, proxyAddress, host string, port uint16) (net.Conn, byte) {
	t.Helper()
	conn, err := net.DialTimeout("tcp", proxyAddress, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
	if _, err := conn.Write([]byte{5, 1, 0}); err != nil {
		t.Fatal(err)
	}
	var method [2]byte
	if _, err := io.ReadFull(conn, method[:]); err != nil || method != [2]byte{5, 0} {
		t.Fatalf("SOCKS greeting = %v, err=%v", method, err)
	}
	if len(host) > 255 {
		t.Fatal("test hostname too long")
	}
	request := append([]byte{5, 1, 0, 3, byte(len(host))}, host...)
	var rawPort [2]byte
	binary.BigEndian.PutUint16(rawPort[:], port)
	request = append(request, rawPort[:]...)
	if _, err := conn.Write(request); err != nil {
		t.Fatal(err)
	}
	var reply [10]byte
	if _, err := io.ReadFull(conn, reply[:]); err != nil || reply[0] != 5 {
		t.Fatalf("SOCKS reply = %v, err=%v", reply, err)
	}
	_ = conn.SetDeadline(time.Time{})
	return conn, reply[1]
}

func holdSocksClient(t *testing.T, proxyAddress string) net.Conn {
	t.Helper()
	conn, err := net.DialTimeout("tcp", proxyAddress, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
	if _, err := conn.Write([]byte{5, 1, 0}); err != nil {
		_ = conn.Close()
		t.Fatal(err)
	}
	var reply [2]byte
	if _, err := io.ReadFull(conn, reply[:]); err != nil || reply != [2]byte{5, 0} {
		_ = conn.Close()
		t.Fatalf("SOCKS greeting = %v, err=%v", reply, err)
	}
	_ = conn.SetDeadline(time.Time{})
	return conn
}

func waitForSlots(t *testing.T, slots chan struct{}, want int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for len(slots) != want {
		if time.Now().After(deadline) {
			t.Fatalf("connection slots = %d, want %d", len(slots), want)
		}
		time.Sleep(time.Millisecond)
	}
}

func triggerConnectionLimit(t *testing.T, proxy *Proxy) {
	t.Helper()
	client, err := net.DialTimeout("tcp", proxy.Address(), 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	select {
	case <-proxy.ctx.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("connection limit did not close the proxy")
	}
	if !proxy.BudgetExceeded() {
		t.Fatal("proxy closed without recording the connection budget breach")
	}
}

func TestLivePageConnectionLimitClosesExistingTunnel(t *testing.T) {
	processSlots := make(chan struct{}, 3)
	dialer := &recordingDialer{}
	defer dialer.close()
	proxy, err := startWithLimits(context.Background(), "http://127.0.0.1:8080", &stagedResolver{}, dialer.dial, nil,
		connectionLimits{livePerPage: 2, acceptedPerPage: 10, processSlots: processSlots})
	if err != nil {
		t.Fatal(err)
	}
	defer proxy.Close()
	tunnel, status := socksConnect(t, proxy.Address(), "127.0.0.1", 8080)
	if status != 0 {
		t.Fatalf("ordinary root tunnel rejected: %d", status)
	}
	defer tunnel.Close()
	idle := holdSocksClient(t, proxy.Address())
	defer idle.Close()
	triggerConnectionLimit(t, proxy)
	if err := proxy.Close(); err != nil {
		t.Fatal(err)
	}
	if len(proxy.pageSlots) != 0 || len(processSlots) != 0 {
		t.Fatalf("connection slots leaked: page=%d process=%d", len(proxy.pageSlots), len(processSlots))
	}
	if proxy.DeniedCount() != 0 || len(dialer.dialed()) != 1 {
		t.Fatalf("budget breach was counted as policy denial or reached another dial: denied=%d dials=%v", proxy.DeniedCount(), dialer.dialed())
	}
	_ = tunnel.SetReadDeadline(time.Now().Add(time.Second))
	var data [1]byte
	if _, err := tunnel.Read(data[:]); err == nil {
		t.Fatal("budget breach left an existing tunnel open")
	} else if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
		t.Fatal("budget breach did not promptly close the existing tunnel")
	}
}

func TestProcessConnectionLimitIsSharedAcrossPages(t *testing.T) {
	processSlots := make(chan struct{}, 2)
	limits := connectionLimits{livePerPage: 2, acceptedPerPage: 10, processSlots: processSlots}
	first, err := startWithLimits(context.Background(), "http://127.0.0.1:8080", &stagedResolver{}, nil, nil, limits)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	second, err := startWithLimits(context.Background(), "http://127.0.0.1:8080", &stagedResolver{}, nil, nil, limits)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	firstClient := holdSocksClient(t, first.Address())
	defer firstClient.Close()
	secondClient := holdSocksClient(t, second.Address())
	defer secondClient.Close()
	triggerConnectionLimit(t, first)
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	if second.BudgetExceeded() || len(processSlots) != 1 {
		t.Fatalf("another page lost its connection slot: hit=%t slots=%d", second.BudgetExceeded(), len(processSlots))
	}
	if err := second.Close(); err != nil || len(processSlots) != 0 {
		t.Fatalf("process slots leaked after both pages closed: err=%v slots=%d", err, len(processSlots))
	}
}

func TestCumulativeConnectionLimitCountsReleasedClients(t *testing.T) {
	processSlots := make(chan struct{}, 2)
	proxy, err := startWithLimits(context.Background(), "http://127.0.0.1:8080", &stagedResolver{}, nil, nil,
		connectionLimits{livePerPage: 2, acceptedPerPage: 2, processSlots: processSlots})
	if err != nil {
		t.Fatal(err)
	}
	defer proxy.Close()
	for range 2 {
		client := holdSocksClient(t, proxy.Address())
		_ = client.Close()
		waitForSlots(t, proxy.pageSlots, 0)
	}
	if proxy.BudgetExceeded() {
		t.Fatal("the permitted connections exceeded the cumulative budget")
	}
	triggerConnectionLimit(t, proxy)
	if err := proxy.Close(); err != nil || len(processSlots) != 0 {
		t.Fatalf("cumulative breach leaked a slot: err=%v slots=%d", err, len(processSlots))
	}
}

func TestParentCancellationClosesAcceptedClientsWithoutBudgetHit(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	processSlots := make(chan struct{}, 1)
	proxy, err := startWithLimits(ctx, "http://127.0.0.1:8080", &stagedResolver{}, nil, nil,
		connectionLimits{livePerPage: 1, acceptedPerPage: 1, processSlots: processSlots})
	if err != nil {
		t.Fatal(err)
	}
	client := holdSocksClient(t, proxy.Address())
	defer client.Close()
	cancel()
	if err := proxy.Close(); err != nil {
		t.Fatal(err)
	}
	if proxy.BudgetExceeded() || len(proxy.pageSlots) != 0 || len(processSlots) != 0 {
		t.Fatalf("parent cancellation caused a false budget hit or leaked slots: hit=%t page=%d process=%d", proxy.BudgetExceeded(), len(proxy.pageSlots), len(processSlots))
	}
}

func TestPayloadBudgetCountsBothDirectionsAndOnlyFailsOnNextByte(t *testing.T) {
	limits := payloadLimits(7, 20)
	dialer := &recordingDialer{}
	defer dialer.close()
	proxy, err := startWithLimits(context.Background(), "http://127.0.0.1:8080", &stagedResolver{}, dialer.dial, nil, limits)
	if err != nil {
		t.Fatal(err)
	}
	defer proxy.Close()
	client, status := socksConnect(t, proxy.Address(), "127.0.0.1", 8080)
	if status != 0 {
		t.Fatalf("root tunnel rejected: %d", status)
	}
	defer client.Close()
	upstream := dialer.upstream(t, 0)
	if err := transferPayload(client, upstream, []byte("abcd")); err != nil {
		t.Fatal(err)
	}
	if err := transferPayload(upstream, client, []byte("xyz")); err != nil {
		t.Fatal(err)
	}
	if got := payloadUsage(limits.processPayload); proxy.BudgetExceeded() || got != 7 {
		t.Fatalf("exact payload limit failed: hit=%t used=%d", proxy.BudgetExceeded(), got)
	}
	_, _ = client.Write([]byte("!"))
	waitForPayloadBreach(t, proxy)
	if err := proxy.Close(); err != nil {
		t.Fatal(err)
	}
	if got := payloadUsage(limits.processPayload); got != 0 {
		t.Fatalf("closed page retained %d process payload bytes", got)
	}
	if proxy.DeniedCount() != 0 {
		t.Fatal("payload breach was counted as a destination-policy denial")
	}
	_ = upstream.SetReadDeadline(time.Now().Add(time.Second))
	var extra [1]byte
	if _, err := upstream.Read(extra[:]); err == nil {
		t.Fatal("payload breach left the tunnel open")
	}
}

func TestPayloadBudgetSharedAcrossConnectionsOnOnePage(t *testing.T) {
	limits := payloadLimits(5, 20)
	dialer := &recordingDialer{}
	defer dialer.close()
	proxy, err := startWithLimits(context.Background(), "http://127.0.0.1:8080", &stagedResolver{}, dialer.dial, nil, limits)
	if err != nil {
		t.Fatal(err)
	}
	defer proxy.Close()
	first, status := socksConnect(t, proxy.Address(), "127.0.0.1", 8080)
	if status != 0 {
		t.Fatalf("first root tunnel rejected: %d", status)
	}
	defer first.Close()
	second, status := socksConnect(t, proxy.Address(), "127.0.0.1", 8080)
	if status != 0 {
		t.Fatalf("second root tunnel rejected: %d", status)
	}
	defer second.Close()
	if err := transferPayload(first, dialer.upstream(t, 0), []byte("abc")); err != nil {
		t.Fatal(err)
	}
	if err := transferPayload(second, dialer.upstream(t, 1), []byte("de")); err != nil {
		t.Fatal(err)
	}
	if proxy.BudgetExceeded() || payloadUsage(limits.processPayload) != 5 {
		t.Fatal("two connections did not share the exact page payload budget")
	}
	_, _ = first.Write([]byte("f"))
	waitForPayloadBreach(t, proxy)
	if err := proxy.Close(); err != nil {
		t.Fatal(err)
	}
	_ = second.SetReadDeadline(time.Now().Add(time.Second))
	var extra [1]byte
	if _, err := second.Read(extra[:]); err == nil {
		t.Fatal("payload breach left another tunnel open")
	}
}

func TestPayloadBudgetSharedAcrossActivePagesAndReleasedAfterClose(t *testing.T) {
	limits := payloadLimits(8, 10)
	firstDialer, secondDialer := &recordingDialer{}, &recordingDialer{}
	defer firstDialer.close()
	defer secondDialer.close()
	first, err := startWithLimits(context.Background(), "http://127.0.0.1:8080", &stagedResolver{}, firstDialer.dial, nil, limits)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	second, err := startWithLimits(context.Background(), "http://127.0.0.1:8080", &stagedResolver{}, secondDialer.dial, nil, limits)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	firstClient, status := socksConnect(t, first.Address(), "127.0.0.1", 8080)
	if status != 0 {
		t.Fatalf("first root tunnel rejected: %d", status)
	}
	defer firstClient.Close()
	secondClient, status := socksConnect(t, second.Address(), "127.0.0.1", 8080)
	if status != 0 {
		t.Fatalf("second root tunnel rejected: %d", status)
	}
	defer secondClient.Close()
	firstUpstream := firstDialer.upstream(t, 0)
	secondUpstream := secondDialer.upstream(t, 0)
	start := make(chan struct{})
	results := make(chan error, 2)
	go func() { <-start; results <- transferPayload(firstClient, firstUpstream, []byte("12345")) }()
	go func() { <-start; results <- transferPayload(secondUpstream, secondClient, []byte("67890")) }()
	close(start)
	for range 2 {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	if first.BudgetExceeded() || second.BudgetExceeded() || payloadUsage(limits.processPayload) != 10 {
		t.Fatalf("concurrent exact process limit failed: first=%t second=%t used=%d", first.BudgetExceeded(), second.BudgetExceeded(), payloadUsage(limits.processPayload))
	}
	_, _ = secondClient.Write([]byte("!"))
	waitForPayloadBreach(t, second)
	if err := second.Close(); err != nil {
		t.Fatal(err)
	}
	if first.BudgetExceeded() || payloadUsage(limits.processPayload) != 5 {
		t.Fatalf("closing one page affected the other: hit=%t used=%d", first.BudgetExceeded(), payloadUsage(limits.processPayload))
	}
	if err := transferPayload(firstClient, firstUpstream, []byte("abc")); err != nil {
		t.Fatalf("remaining page could not use released process budget: %v", err)
	}
	if err := first.Close(); err != nil || payloadUsage(limits.processPayload) != 0 {
		t.Fatalf("active-page payload contribution leaked: close=%v used=%d", err, payloadUsage(limits.processPayload))
	}
}

type shortPayloadWrite struct {
	net.Conn
	written int
}

func (c shortPayloadWrite) Write(data []byte) (int, error) { return c.written, nil }

func TestPayloadBudgetRefundsUnwrittenBytes(t *testing.T) {
	for _, written := range []int{0, 2} {
		t.Run(strconv.Itoa(written), func(t *testing.T) {
			budget := newPayloadBudget(5)
			proxy := &Proxy{ctx: context.Background(), payloadLimit: 5, processPayload: budget}
			source, sender := net.Pipe()
			defer source.Close()
			defer sender.Close()
			destination, peer := net.Pipe()
			defer destination.Close()
			defer peer.Close()
			done := make(chan struct{})
			go func() {
				proxy.copyPayload(shortPayloadWrite{Conn: destination, written: written}, source)
				close(done)
			}()
			_ = sender.SetWriteDeadline(time.Now().Add(time.Second))
			if _, err := sender.Write([]byte("abcde")); err != nil {
				t.Fatal(err)
			}
			select {
			case <-done:
			case <-time.After(time.Second):
				t.Fatal("short write did not terminate payload copy")
			}
			if proxy.BudgetExceeded() || payloadUsage(budget) != int64(written) {
				t.Fatalf("short write counted unwritten bytes: hit=%t used=%d", proxy.BudgetExceeded(), payloadUsage(budget))
			}
		})
	}
}

func TestParentCancellationAfterExactPayloadDoesNotReportBreach(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	limits := payloadLimits(3, 3)
	dialer := &recordingDialer{}
	defer dialer.close()
	proxy, err := startWithLimits(ctx, "http://127.0.0.1:8080", &stagedResolver{}, dialer.dial, nil, limits)
	if err != nil {
		t.Fatal(err)
	}
	client, status := socksConnect(t, proxy.Address(), "127.0.0.1", 8080)
	if status != 0 {
		t.Fatalf("root tunnel rejected: %d", status)
	}
	defer client.Close()
	if err := transferPayload(client, dialer.upstream(t, 0), []byte("abc")); err != nil {
		t.Fatal(err)
	}
	cancel()
	if err := proxy.Close(); err != nil {
		t.Fatal(err)
	}
	if proxy.BudgetExceeded() || payloadUsage(limits.processPayload) != 0 {
		t.Fatalf("cancellation caused a payload breach or leaked usage: hit=%t used=%d", proxy.BudgetExceeded(), payloadUsage(limits.processPayload))
	}
}

func TestPrivateRootOnlyAtExactAuthority(t *testing.T) {
	resolver := &stagedResolver{answers: map[string][][]net.IPAddr{
		"internal.test": {ipAnswers("127.0.0.1")},
	}}
	dialer := &recordingDialer{}
	defer dialer.close()
	proxy, err := start(context.Background(), "http://internal.test:8080/path", resolver, dialer.dial)
	if err != nil {
		t.Fatal(err)
	}
	defer proxy.Close()

	root, status := socksConnect(t, proxy.Address(), "INTERNAL.TEST.", 8080)
	_ = root.Close()
	if status != 0 {
		t.Fatalf("intentional private root rejected: %d", status)
	}
	otherPort, status := socksConnect(t, proxy.Address(), "internal.test", 8081)
	_ = otherPort.Close()
	if status == 0 {
		t.Fatal("private service on another port was allowed")
	}
	if got := dialer.dialed(); len(got) != 1 || got[0] != "127.0.0.1:8080" {
		t.Fatalf("unexpected dial targets: %v", got)
	}
	if proxy.DeniedCount() != 1 {
		t.Fatalf("denials = %d, want 1", proxy.DeniedCount())
	}
}

func TestDefaultPortTransitionUsesPinnedPrivateRootAddresses(t *testing.T) {
	resolver := &stagedResolver{answers: map[string][][]net.IPAddr{
		"internal.test": {ipAnswers("127.0.0.1"), ipAnswers("8.8.8.8")},
	}}
	dialer := &recordingDialer{}
	defer dialer.close()
	proxy, err := start(context.Background(), "http://internal.test", resolver, dialer.dial)
	if err != nil {
		t.Fatal(err)
	}
	defer proxy.Close()
	paired, status := socksConnect(t, proxy.Address(), "internal.test", 443)
	_ = paired.Close()
	if status != 0 {
		t.Fatalf("same-host HTTP→HTTPS default-port transition was rejected: %d", status)
	}
	if got := dialer.dialed(); len(got) != 1 || got[0] != "127.0.0.1:443" {
		t.Fatalf("paired default port did not use the pinned private answer: %v", got)
	}
	for _, tc := range []struct {
		rootURL   string
		otherPort uint16
	}{
		{"http://internal.test", 8443},
		{"http://internal.test:443", 80},
		{"https://internal.test:80", 443},
	} {
		resolver := &stagedResolver{answers: map[string][][]net.IPAddr{"internal.test": {ipAnswers("127.0.0.1")}}}
		proxy, err := start(context.Background(), tc.rootURL, resolver, dialer.dial)
		if err != nil {
			t.Fatal(err)
		}
		conn, status := socksConnect(t, proxy.Address(), "internal.test", tc.otherPort)
		_ = conn.Close()
		_ = proxy.Close()
		if status == 0 {
			t.Fatalf("root %q granted unrelated private port %d", tc.rootURL, tc.otherPort)
		}
	}
}

func TestPublicOffRootDNSFlipNeverDialsPrivateAnswer(t *testing.T) {
	resolver := &stagedResolver{answers: map[string][][]net.IPAddr{
		"root.test": {ipAnswers("8.8.8.8")},
		"cdn.test":  {ipAnswers("1.1.1.1"), ipAnswers("127.0.0.1")},
	}}
	dialer := &recordingDialer{}
	defer dialer.close()
	proxy, err := start(context.Background(), "https://root.test", resolver, dialer.dial)
	if err != nil {
		t.Fatal(err)
	}
	defer proxy.Close()

	first, status := socksConnect(t, proxy.Address(), "cdn.test", 443)
	_ = first.Close()
	if status != 0 {
		t.Fatalf("public off-root address was rejected: %d", status)
	}
	second, status := socksConnect(t, proxy.Address(), "cdn.test", 443)
	_ = second.Close()
	if status == 0 {
		t.Fatal("rebound private address was allowed")
	}
	if got := dialer.dialed(); len(got) != 1 || got[0] != "1.1.1.1:443" {
		t.Fatalf("unexpected dial targets: %v", got)
	}
}

func TestApprovedDualStackFallbackDoesNotWaitForBlackholedFirstFamily(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	var stalled, fallback atomic.Int64
	var peer net.Conn
	firstStarted := make(chan struct{})
	started := time.Now()
	conn, err := dialApproved(ctx, []netip.Addr{
		netip.MustParseAddr("2001:4860:4860::8888"),
		netip.MustParseAddr("8.8.8.8"),
	}, 443, func(dialCtx context.Context, _, address string) (net.Conn, error) {
		if strings.HasPrefix(address, "[") {
			stalled.Add(1)
			close(firstStarted)
			<-dialCtx.Done()
			return nil, dialCtx.Err()
		}
		<-firstStarted
		fallback.Add(1)
		client, other := net.Pipe()
		peer = other
		return client, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	defer peer.Close()
	if time.Since(started) > 500*time.Millisecond || stalled.Load() != 1 || fallback.Load() != 1 {
		t.Fatalf("dual-stack fallback stalled or skipped an approved address: stalled=%d fallback=%d duration=%s", stalled.Load(), fallback.Load(), time.Since(started))
	}
}

func TestApprovedDialWaitsForLosingAttemptBeforeReturning(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	stalled := make(chan struct{})
	cancelled := make(chan struct{})
	allowExit := make(chan struct{})
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(allowExit) }) }
	defer release()
	type outcome struct {
		conn net.Conn
		err  error
	}
	returned := make(chan outcome, 1)
	var peer net.Conn
	go func() {
		conn, err := dialApproved(ctx, []netip.Addr{
			netip.MustParseAddr("10.0.0.1"),
			netip.MustParseAddr("10.0.0.2"),
		}, 443, func(dialCtx context.Context, _, address string) (net.Conn, error) {
			if address == "10.0.0.1:443" {
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
		})
		returned <- outcome{conn, err}
	}()
	select {
	case <-cancelled:
	case <-ctx.Done():
		t.Fatal("losing dial was not cancelled")
	}
	select {
	case result := <-returned:
		if result.conn != nil {
			_ = result.conn.Close()
		}
		t.Fatal("winner returned before the losing private dial ended")
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
}

func TestApprovedThirdAddressRunsAfterTwoStalledAttempts(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 9*time.Second)
	defer cancel()
	var attempts atomic.Int64
	var peer net.Conn
	started := time.Now()
	conn, err := dialApproved(ctx, []netip.Addr{
		netip.MustParseAddr("2001:4860:4860::8888"),
		netip.MustParseAddr("8.8.8.8"),
		netip.MustParseAddr("1.1.1.1"),
	}, 443, func(dialCtx context.Context, _, address string) (net.Conn, error) {
		attempts.Add(1)
		if address != "1.1.1.1:443" {
			<-dialCtx.Done()
			return nil, dialCtx.Err()
		}
		client, other := net.Pipe()
		peer = other
		return client, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	defer peer.Close()
	if attempts.Load() != 3 || time.Since(started) > 7*time.Second {
		t.Fatalf("third vetted address was starved: attempts=%d duration=%s", attempts.Load(), time.Since(started))
	}
}

func TestMixedAnswersAndResolutionFailureFailClosed(t *testing.T) {
	resolver := &stagedResolver{answers: map[string][][]net.IPAddr{
		"root.test":  {ipAnswers("8.8.8.8")},
		"mixed.test": {ipAnswers("1.1.1.1", "127.0.0.1")},
	}, fails: map[string]error{"failed.test": errors.New("lookup failed")}}
	dialer := &recordingDialer{}
	proxy, err := start(context.Background(), "https://root.test", resolver, dialer.dial)
	if err != nil {
		t.Fatal(err)
	}
	defer proxy.Close()
	for _, host := range []string{"mixed.test", "failed.test"} {
		conn, status := socksConnect(t, proxy.Address(), host, 443)
		_ = conn.Close()
		if status == 0 {
			t.Fatalf("%s reached a dial despite unsafe DNS", host)
		}
	}
	if got := dialer.dialed(); len(got) != 0 {
		t.Fatalf("unsafe DNS triggered a default dial: %v", got)
	}
	if _, err := start(context.Background(), "https://mixed.test", resolver, dialer.dial); err == nil {
		t.Fatal("mixed public/private root was admitted")
	}
}

func TestIPClassificationsAndRootParsing(t *testing.T) {
	for _, tc := range []struct {
		ip     string
		public bool
	}{
		{"8.8.8.8", true}, {"2606:4700:4700::1111", true},
		{"127.0.0.1", false}, {"::1", false}, {"::ffff:127.0.0.1", false},
		{"169.254.169.254", false}, {"10.1.2.3", false}, {"100.64.0.1", false},
		{"198.18.0.1", false}, {"2001:db8::1", false}, {"fc00::1", false},
	} {
		if got := publicAddress(netip.MustParseAddr(tc.ip)); got != tc.public {
			t.Errorf("publicAddress(%s) = %t, want %t", tc.ip, got, tc.public)
		}
	}
	for _, raw := range []string{"file:///etc/passwd", "http://host:0", "http://host:65536", "https://"} {
		if _, err := parseRootAuthority(raw); err == nil {
			t.Errorf("unsafe root %q was accepted", raw)
		}
	}
	root, err := parseRootAuthority("https://[::ffff:127.0.0.1]/")
	if err != nil || root.host != "127.0.0.1" || root.port != 443 {
		t.Fatalf("mapped private root parsed incorrectly: %+v, %v", root, err)
	}
}

func TestRootPolicyBlocksPublicToPrivateAcrossPageProxies(t *testing.T) {
	resolver := &stagedResolver{answers: map[string][][]net.IPAddr{
		"rebind.test": {ipAnswers("8.8.8.8"), ipAnswers("169.254.169.254")},
	}}
	publicSeen := false
	observe := func(_ context.Context, public, nonPublic bool) error {
		if publicSeen && nonPublic {
			return errors.New("public-only root")
		}
		if public {
			publicSeen = true
		}
		return nil
	}
	dialer := &recordingDialer{}
	defer dialer.close()
	first, err := startWithPolicy(context.Background(), "https://rebind.test", resolver, dialer.dial, observe)
	if err != nil || !publicSeen {
		t.Fatalf("first public page was not observed: err=%v observed=%t", err, publicSeen)
	}
	_ = first.Close()
	second, err := startWithPolicy(context.Background(), "https://rebind.test", resolver, dialer.dial, observe)
	if err == nil || second != nil || !strings.Contains(err.Error(), "public-only root") {
		t.Fatalf("private rebound started proxy: proxy=%v err=%v", second, err)
	}
	if got := dialer.dialed(); len(got) != 0 {
		t.Fatalf("private root dialed: %v", got)
	}
}

func TestRootPolicyAllowsOrdinaryPublicDNSRotation(t *testing.T) {
	resolver := &stagedResolver{answers: map[string][][]net.IPAddr{
		"public.test": {ipAnswers("8.8.8.8"), ipAnswers("1.1.1.1")},
	}}
	observations := 0
	observe := func(_ context.Context, public, nonPublic bool) error {
		if !public || nonPublic {
			t.Fatalf("ordinary public answer classified incorrectly: public=%t nonpublic=%t", public, nonPublic)
		}
		observations++
		return nil
	}
	for range 2 {
		proxy, err := startWithPolicy(context.Background(), "https://public.test", resolver, nil, observe)
		if err != nil {
			t.Fatal(err)
		}
		_ = proxy.Close()
	}
	if observations != 2 {
		t.Fatalf("public DNS observations = %d, want 2", observations)
	}
}

func TestMixedRootAnswerIsObservedBeforeItIsBlocked(t *testing.T) {
	resolver := &stagedResolver{answers: map[string][][]net.IPAddr{
		"mixed.test": {ipAnswers("8.8.8.8", "127.0.0.1")},
	}}
	observed := false
	proxy, err := startWithPolicy(context.Background(), "http://mixed.test", resolver, nil, func(_ context.Context, public, nonPublic bool) error {
		observed = public && nonPublic
		return nil
	})
	if err == nil || proxy != nil || !observed {
		t.Fatalf("mixed answer bypassed observation/block: proxy=%v err=%v observed=%t", proxy, err, observed)
	}
}

func TestPrivateRootProxyRechecksPolicyAtEveryConnection(t *testing.T) {
	resolver := &stagedResolver{answers: map[string][][]net.IPAddr{
		"private.test": {ipAnswers("127.0.0.1")},
	}}
	var publicSeen atomic.Bool
	var dials atomic.Int32
	proxy, err := startWithPolicy(context.Background(), "http://private.test", resolver,
		func(_ context.Context, _, _ string) (net.Conn, error) {
			dials.Add(1)
			return nil, errors.New("fixture connection stopped")
		},
		func(_ context.Context, public, nonPublic bool) error {
			if publicSeen.Load() && nonPublic {
				return rootdns.ErrBlocked
			}
			return nil
		},
		func(context.Context) (func(), error) {
			if publicSeen.Load() {
				return nil, rootdns.ErrBlocked
			}
			return func() {}, nil
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	defer proxy.Close()
	publicSeen.Store(true) // Simulate another page recording a public root answer.
	conn, status := socksConnect(t, proxy.Address(), "private.test", 80)
	_ = conn.Close()
	if status == 0 || dials.Load() != 0 || proxy.DeniedCount() != 1 {
		t.Fatalf("stale private proxy bypassed policy: status=%d dials=%d denied=%d", status, dials.Load(), proxy.DeniedCount())
	}
}

func TestPrivateRootDialGuardCoversDialAndReleasesOnFailure(t *testing.T) {
	resolver := &stagedResolver{answers: map[string][][]net.IPAddr{
		"private.test": {ipAnswers("127.0.0.1")},
	}}
	var held atomic.Bool
	var releases atomic.Int32
	proxy, err := startWithPolicy(context.Background(), "http://private.test", resolver,
		func(context.Context, string, string) (net.Conn, error) {
			if !held.Load() {
				t.Error("private TCP dial ran outside policy guard")
			}
			return nil, errors.New("fixture dial stopped")
		}, nil,
		func(context.Context) (func(), error) {
			held.Store(true)
			return func() {
				held.Store(false)
				releases.Add(1)
			}, nil
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	defer proxy.Close()
	conn, status := socksConnect(t, proxy.Address(), "private.test", 80)
	_ = conn.Close()
	if status == 0 || held.Load() || releases.Load() != 1 {
		t.Fatalf("private dial guard lifetime: status=%d held=%t releases=%d", status, held.Load(), releases.Load())
	}
}

func TestChromeBinaryDetectionPreservesServicePathOrder(t *testing.T) {
	dir := t.TempDir()
	chromePath := filepath.Join(dir, "chromium-browser")
	if err := os.WriteFile(chromePath, []byte("#!/bin/sh\nexit 0\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	if got := findChromeBinary(); got != chromePath {
		t.Fatalf("detected Chrome path = %q, want %q", got, chromePath)
	}
}

func TestClosingProxyTerminatesAnActiveTunnel(t *testing.T) {
	dialer := &recordingDialer{}
	defer dialer.close()
	proxy, err := start(context.Background(), "http://127.0.0.1:8080", &stagedResolver{}, dialer.dial)
	if err != nil {
		t.Fatal(err)
	}
	conn, status := socksConnect(t, proxy.Address(), "127.0.0.1", 8080)
	if status != 0 {
		t.Fatalf("root tunnel rejected: %d", status)
	}
	done := make(chan error, 1)
	go func() { done <- proxy.Close() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("proxy close did not terminate active tunnel")
	}
	_ = conn.SetReadDeadline(time.Now().Add(time.Second))
	var data [1]byte
	if _, err := conn.Read(data[:]); err == nil {
		t.Fatal("closed proxy tunnel remained readable")
	}
	_ = conn.Close()
}

func TestClosingProxyCancelsPendingDial(t *testing.T) {
	started := make(chan struct{})
	proxy, err := start(context.Background(), "http://127.0.0.1:8080", &stagedResolver{}, func(ctx context.Context, _, _ string) (net.Conn, error) {
		close(started)
		<-ctx.Done()
		return nil, ctx.Err()
	})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := proxy.connect(proxy.root)
		done <- err
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("proxy dial never started")
	}
	if err := proxy.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("pending dial was not canceled: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("proxy close left a pending dial")
	}
}

func TestSocksRejectsUnsupportedCommand(t *testing.T) {
	proxy, err := start(context.Background(), "http://127.0.0.1:8080", &stagedResolver{}, func(context.Context, string, string) (net.Conn, error) {
		return nil, errors.New("should not dial")
	})
	if err != nil {
		t.Fatal(err)
	}
	defer proxy.Close()
	conn, err := net.Dial("tcp", proxy.Address())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
	_, _ = conn.Write([]byte{5, 1, 0})
	var reply [2]byte
	_, _ = io.ReadFull(conn, reply[:])
	_, _ = conn.Write([]byte{5, 3, 0, 1, 127, 0, 0, 1, 0x1f, 0x90})
	var failure [10]byte
	if _, err := io.ReadFull(conn, failure[:]); err != nil || failure[1] == 0 {
		t.Fatalf("unsupported command = %v, err=%v", failure, err)
	}
}
