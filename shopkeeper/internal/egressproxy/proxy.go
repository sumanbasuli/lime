package egressproxy

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/sumanbasuli/lime/shopkeeper/internal/rootdns"
	"golang.org/x/net/idna"
)

const (
	connectTimeout   = 10 * time.Second
	handshakeTimeout = 10 * time.Second
	addressTimeout   = 4 * time.Second

	maxLiveConnectionsPerPage    = 64
	maxLiveConnectionsPerProcess = 256
	maxAcceptedConnectionsPage   = 512
	maxPayloadBytesPerPage       = 256 << 20
	maxPayloadBytesPerProcess    = 1 << 30
)

var processConnectionSlots = make(chan struct{}, maxLiveConnectionsPerProcess)
var processPayloadBudget = newPayloadBudget(maxPayloadBytesPerProcess)

// The used count includes bytes reserved for writes that have not finished.
// A pending write may refund bytes, so waiters only report a breach after the
// exhausted limit has no relevant pending writes left.
type payloadBudget struct {
	mu      sync.Mutex
	changed *sync.Cond
	limit   int64
	used    int64
	pending int64
}

func newPayloadBudget(limit int64) *payloadBudget {
	budget := &payloadBudget{limit: limit}
	budget.changed = sync.NewCond(&budget.mu)
	return budget
}

type connectionLimits struct {
	livePerPage     int
	acceptedPerPage int64
	processSlots    chan struct{}
	payloadPerPage  int64
	processPayload  *payloadBudget
}

func defaultConnectionLimits() connectionLimits {
	return connectionLimits{
		livePerPage: maxLiveConnectionsPerPage, acceptedPerPage: maxAcceptedConnectionsPage,
		processSlots: processConnectionSlots, payloadPerPage: maxPayloadBytesPerPage,
		processPayload: processPayloadBudget,
	}
}

type ipResolver interface {
	LookupIPAddr(context.Context, string) ([]net.IPAddr, error)
}

type dialFunc func(context.Context, string, string) (net.Conn, error)

var errBlockedDestination = errors.New("off-root destination is not public")

type authority struct {
	host string
	port uint16
}

// Proxy is a scan-page-local SOCKS5 proxy. Chrome sends its TCP requests here;
// the proxy resolves, checks, and dials an IP literal without a second lookup.
type Proxy struct {
	listener         net.Listener
	ctx              context.Context
	cancel           context.CancelFunc
	resolver         ipResolver
	dial             dialFunc
	root             authority
	pairedPort       uint16
	rootIPs          []netip.Addr
	guardPrivateDial rootdns.PrivateDialGuard
	denied           atomic.Int64
	budgetHit        atomic.Bool
	payloadBudgetHit atomic.Bool
	pageSlots        chan struct{}
	processSlots     chan struct{}
	maxAccepted      int64
	accepted         int64 // Written only by serve.
	payloadLimit     int64
	payloadUsed      int64 // Protected by processPayload.mu.
	payloadPending   int64 // Protected by processPayload.mu.
	processPayload   *payloadBudget
	closeOnce        sync.Once
	releaseOnce      sync.Once
	closeErr         error
	wg               sync.WaitGroup
}

// Start resolves and pins the page's exact root authority before starting the
// proxy. A private-only root is intentional; a mixed public/private answer is
// ambiguous and fails closed. No browser should be started if Start fails.
func Start(ctx context.Context, rootURL string) (*Proxy, error) {
	return start(ctx, rootURL, net.DefaultResolver, (&net.Dialer{Timeout: connectTimeout}).DialContext)
}

// StartWithRootPolicy applies a durable policy to the exact answer this proxy
// will pin. A rejected observation prevents Chrome from starting.
func StartWithRootPolicy(ctx context.Context, rootURL string, observe rootdns.Observer, guards ...rootdns.PrivateDialGuard) (*Proxy, error) {
	return startWithPolicy(ctx, rootURL, net.DefaultResolver, (&net.Dialer{Timeout: connectTimeout}).DialContext, observe, guards...)
}

func start(ctx context.Context, rootURL string, resolver ipResolver, dial dialFunc) (*Proxy, error) {
	return startWithPolicy(ctx, rootURL, resolver, dial, nil)
}

func startWithPolicy(ctx context.Context, rootURL string, resolver ipResolver, dial dialFunc, observe rootdns.Observer, guards ...rootdns.PrivateDialGuard) (*Proxy, error) {
	return startWithLimits(ctx, rootURL, resolver, dial, observe, defaultConnectionLimits(), guards...)
}

func startWithLimits(ctx context.Context, rootURL string, resolver ipResolver, dial dialFunc, observe rootdns.Observer, limits connectionLimits, guards ...rootdns.PrivateDialGuard) (*Proxy, error) {
	if limits.payloadPerPage == 0 {
		limits.payloadPerPage = maxPayloadBytesPerPage
	}
	if limits.processPayload == nil {
		limits.processPayload = processPayloadBudget
	}
	root, err := parseRootAuthority(rootURL)
	if err != nil {
		return nil, err
	}
	lookupCtx, cancelLookup := context.WithTimeout(ctx, connectTimeout)
	rootIPs, err := resolveIPs(lookupCtx, resolver, root.host)
	cancelLookup()
	if err != nil {
		return nil, fmt.Errorf("resolve scan root: %w", err)
	}
	public, nonPublic := false, false
	for _, ip := range rootIPs {
		if publicAddress(ip) {
			public = true
		} else {
			nonPublic = true
		}
	}
	if observe != nil {
		if err := observe(ctx, public, nonPublic); err != nil {
			return nil, fmt.Errorf("scan root DNS policy: %w", err)
		}
	}
	if public && nonPublic {
		return nil, errors.New("scan root has mixed public and non-public DNS answers")
	}

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("start scan egress proxy: %w", err)
	}
	proxyCtx, cancel := context.WithCancel(ctx)
	var guardPrivateDial rootdns.PrivateDialGuard
	if len(guards) > 0 {
		guardPrivateDial = guards[0]
	}
	p := &Proxy{listener: listener, ctx: proxyCtx, cancel: cancel, resolver: resolver, dial: dial, root: root, pairedPort: defaultPairForRoot(rootURL, root), rootIPs: rootIPs, guardPrivateDial: guardPrivateDial, pageSlots: make(chan struct{}, limits.livePerPage), processSlots: limits.processSlots, maxAccepted: limits.acceptedPerPage, payloadLimit: limits.payloadPerPage, processPayload: limits.processPayload}
	context.AfterFunc(proxyCtx, func() {
		_ = listener.Close()
		p.processPayload.mu.Lock()
		p.processPayload.changed.Broadcast()
		p.processPayload.mu.Unlock()
	})
	p.wg.Add(1)
	go p.serve()
	return p, nil
}

func (p *Proxy) Address() string { return p.listener.Addr().String() }

// Done closes when this page proxy stops, including after a budget breach.
func (p *Proxy) Done() <-chan struct{} { return p.ctx.Done() }

// DeniedCount counts requests refused by the root or off-root network policy.
func (p *Proxy) DeniedCount() int64 { return p.denied.Load() }

// BudgetExceeded reports a connection or payload limit hit, independently of
// destination-policy denials. It remains set after the proxy closes.
func (p *Proxy) BudgetExceeded() bool { return p.budgetHit.Load() || p.payloadBudgetHit.Load() }

// PayloadBudgetExceeded distinguishes payload limits from connection limits.
func (p *Proxy) PayloadBudgetExceeded() bool { return p.payloadBudgetHit.Load() }

func (p *Proxy) Close() error {
	p.stop()
	p.wg.Wait()
	p.releaseOnce.Do(func() {
		budget := p.processPayload
		budget.mu.Lock()
		budget.used -= p.payloadUsed
		p.payloadUsed = 0
		budget.changed.Broadcast()
		budget.mu.Unlock()
	})
	if errors.Is(p.closeErr, net.ErrClosed) {
		return nil
	}
	return p.closeErr
}

func (p *Proxy) stop() {
	p.closeOnce.Do(func() {
		p.cancel()
		p.closeErr = p.listener.Close()
	})
}

func (p *Proxy) exceedBudget(client net.Conn) {
	p.budgetHit.Store(true)
	_ = client.Close()
	p.stop()
}

func (p *Proxy) exceedPayloadBudget() {
	p.payloadBudgetHit.Store(true)
	p.stop()
}

func (p *Proxy) reservePayload(want int) (int, bool) {
	budget := p.processPayload
	budget.mu.Lock()
	defer budget.mu.Unlock()
	for p.ctx.Err() == nil {
		pageRemaining := p.payloadLimit - p.payloadUsed
		processRemaining := budget.limit - budget.used
		if pageRemaining > 0 && processRemaining > 0 {
			granted := int64(want)
			if granted > pageRemaining {
				granted = pageRemaining
			}
			if granted > processRemaining {
				granted = processRemaining
			}
			p.payloadUsed += granted
			p.payloadPending += granted
			budget.used += granted
			budget.pending += granted
			return int(granted), false
		}
		if (pageRemaining <= 0 && p.payloadPending == 0) || (processRemaining <= 0 && budget.pending == 0) {
			return 0, true
		}
		budget.changed.Wait()
	}
	return 0, false
}

func (p *Proxy) settlePayload(reserved, written int) {
	budget := p.processPayload
	budget.mu.Lock()
	amount, refund := int64(reserved), int64(reserved-written)
	p.payloadPending -= amount
	budget.pending -= amount
	p.payloadUsed -= refund
	budget.used -= refund
	budget.changed.Broadcast()
	budget.mu.Unlock()
}

func (p *Proxy) copyPayload(dst, src net.Conn) {
	var buffer [32 * 1024]byte
	for {
		read, readErr := src.Read(buffer[:])
		for offset := 0; offset < read; {
			granted, exceeded := p.reservePayload(read - offset)
			if exceeded {
				p.exceedPayloadBudget()
				return
			}
			if granted == 0 { // Canceled while waiting for a pending write.
				return
			}
			written, writeErr := dst.Write(buffer[offset : offset+granted])
			p.settlePayload(granted, written)
			if writeErr != nil || written != granted {
				return
			}
			offset += written
		}
		if readErr != nil {
			return
		}
	}
}

func (p *Proxy) serve() {
	defer p.wg.Done()
	for {
		client, err := p.listener.Accept()
		if err != nil {
			return
		}
		if p.ctx.Err() != nil {
			_ = client.Close()
			return
		}
		p.accepted++
		if p.accepted > p.maxAccepted {
			p.exceedBudget(client)
			return
		}
		select {
		case p.pageSlots <- struct{}{}:
		default:
			p.exceedBudget(client)
			return
		}
		select {
		case p.processSlots <- struct{}{}:
		default:
			<-p.pageSlots
			p.exceedBudget(client)
			return
		}
		if p.ctx.Err() != nil {
			<-p.processSlots
			<-p.pageSlots
			_ = client.Close()
			return
		}
		p.wg.Add(1)
		go func() {
			defer p.wg.Done()
			defer func() {
				<-p.processSlots
				<-p.pageSlots
			}()
			p.handle(client)
		}()
	}
}

func (p *Proxy) handle(client net.Conn) {
	defer client.Close()
	stopClient := context.AfterFunc(p.ctx, func() { _ = client.Close() })
	defer stopClient()
	_ = client.SetDeadline(time.Now().Add(handshakeTimeout))
	var greeting [2]byte
	if _, err := io.ReadFull(client, greeting[:]); err != nil || greeting[0] != 5 {
		return
	}
	methods := make([]byte, int(greeting[1]))
	if _, err := io.ReadFull(client, methods); err != nil {
		return
	}
	noAuth := false
	for _, method := range methods {
		if method == 0 {
			noAuth = true
			break
		}
	}
	if !noAuth {
		_, _ = client.Write([]byte{5, 0xff})
		return
	}
	if _, err := client.Write([]byte{5, 0}); err != nil {
		return
	}
	request, err := readConnectRequest(client)
	if err != nil {
		p.writeReply(client, 7)
		return
	}
	_ = client.SetDeadline(time.Time{})
	upstream, err := p.connect(request)
	if err != nil {
		if errors.Is(err, errBlockedDestination) || errors.Is(err, rootdns.ErrBlocked) {
			p.denied.Add(1)
		}
		p.writeReply(client, 2)
		return
	}
	defer upstream.Close()
	stopUpstream := context.AfterFunc(p.ctx, func() { _ = upstream.Close() })
	defer stopUpstream()
	p.writeReply(client, 0)
	done := make(chan struct{})
	go func() {
		p.copyPayload(upstream, client)
		if tcp, ok := upstream.(*net.TCPConn); ok {
			_ = tcp.CloseWrite()
		}
		close(done)
	}()
	p.copyPayload(client, upstream)
	if tcp, ok := client.(*net.TCPConn); ok {
		_ = tcp.CloseWrite()
	}
	<-done
}

func (p *Proxy) writeReply(client net.Conn, status byte) {
	_, _ = client.Write([]byte{5, status, 0, 1, 0, 0, 0, 0, 0, 0})
}

func readConnectRequest(client net.Conn) (authority, error) {
	var header [4]byte
	if _, err := io.ReadFull(client, header[:]); err != nil {
		return authority{}, err
	}
	if header[0] != 5 || header[1] != 1 || header[2] != 0 {
		return authority{}, errors.New("unsupported SOCKS request")
	}
	var host string
	switch header[3] {
	case 1:
		var raw [4]byte
		if _, err := io.ReadFull(client, raw[:]); err != nil {
			return authority{}, err
		}
		host = net.IP(raw[:]).String()
	case 3:
		var length [1]byte
		if _, err := io.ReadFull(client, length[:]); err != nil || length[0] == 0 {
			return authority{}, errors.New("invalid SOCKS hostname")
		}
		name := make([]byte, int(length[0]))
		if _, err := io.ReadFull(client, name); err != nil {
			return authority{}, err
		}
		host = string(name)
	case 4:
		var raw [16]byte
		if _, err := io.ReadFull(client, raw[:]); err != nil {
			return authority{}, err
		}
		host = net.IP(raw[:]).String()
	default:
		return authority{}, errors.New("unsupported SOCKS address type")
	}
	var rawPort [2]byte
	if _, err := io.ReadFull(client, rawPort[:]); err != nil {
		return authority{}, err
	}
	port := binary.BigEndian.Uint16(rawPort[:])
	if port == 0 {
		return authority{}, errors.New("invalid SOCKS port")
	}
	host, err := canonicalHost(host)
	if err != nil {
		return authority{}, err
	}
	return authority{host: host, port: port}, nil
}

func (p *Proxy) connect(target authority) (net.Conn, error) {
	ctx, cancel := context.WithTimeout(p.ctx, connectTimeout)
	defer cancel()
	addresses := p.rootIPs
	rootDestination := target.host == p.root.host && (target.port == p.root.port || target.port == p.pairedPort)
	if !rootDestination {
		var err error
		addresses, err = resolveIPs(ctx, p.resolver, target.host)
		if err != nil {
			return nil, err
		}
		for _, address := range addresses {
			if !publicAddress(address) {
				return nil, errBlockedDestination
			}
		}
	}
	if rootDestination && !publicAddress(addresses[0]) && p.guardPrivateDial != nil {
		release, err := p.guardPrivateDial(ctx)
		if err != nil {
			if release != nil {
				release()
			}
			return nil, fmt.Errorf("private scan root dial policy: %w", err)
		}
		if release == nil {
			return nil, errors.New("private scan root dial guard returned no release function")
		}
		defer release()
	}
	return dialApproved(ctx, addresses, target.port, p.dial)
}

// Race at most two approved IPs so a blackholed first IP family does not
// prevent an otherwise valid dual-stack site from loading.
func dialApproved(ctx context.Context, addresses []netip.Addr, port uint16, dial dialFunc) (net.Conn, error) {
	if len(addresses) == 1 {
		return dial(ctx, "tcp", net.JoinHostPort(addresses[0].String(), strconv.Itoa(int(port))))
	}
	dialCtx, cancel := context.WithCancel(ctx)
	var dialers sync.WaitGroup
	// Keep the caller's private-root policy lease until every losing attempt
	// has stopped, including when another address connects first.
	defer func() {
		cancel()
		dialers.Wait()
	}()
	type result struct {
		conn net.Conn
		err  error
	}
	jobs := make(chan netip.Addr)
	results := make(chan result)
	for range min(2, len(addresses)) {
		dialers.Add(1)
		go func() {
			defer dialers.Done()
			for address := range jobs {
				attemptCtx, finishAttempt := context.WithTimeout(dialCtx, addressTimeout)
				conn, err := dial(attemptCtx, "tcp", net.JoinHostPort(address.String(), strconv.Itoa(int(port))))
				finishAttempt()
				select {
				case results <- result{conn: conn, err: err}:
				case <-dialCtx.Done():
					if conn != nil {
						_ = conn.Close()
					}
					return
				}
			}
		}()
	}
	dialers.Add(1)
	go func() {
		defer dialers.Done()
		defer close(jobs)
		for _, address := range interleaveIPFamilies(addresses) {
			select {
			case jobs <- address:
			case <-dialCtx.Done():
				return
			}
		}
	}()
	var lastErr error
	for range addresses {
		select {
		case attempt := <-results:
			if attempt.conn != nil {
				return attempt.conn, nil
			}
			lastErr = attempt.err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return nil, lastErr
}

func interleaveIPFamilies(addresses []netip.Addr) []netip.Addr {
	firstIsIPv4 := addresses[0].Is4()
	primary, secondary := make([]netip.Addr, 0, len(addresses)), make([]netip.Addr, 0, len(addresses))
	for _, address := range addresses {
		if address.Is4() == firstIsIPv4 {
			primary = append(primary, address)
		} else {
			secondary = append(secondary, address)
		}
	}
	ordered := make([]netip.Addr, 0, len(addresses))
	for len(primary) > 0 || len(secondary) > 0 {
		if len(primary) > 0 {
			ordered, primary = append(ordered, primary[0]), primary[1:]
		}
		if len(secondary) > 0 {
			ordered, secondary = append(ordered, secondary[0]), secondary[1:]
		}
	}
	return ordered
}

func parseRootAuthority(rawURL string) (authority, error) {
	u, err := url.ParseRequestURI(rawURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" {
		return authority{}, errors.New("scan root must be an HTTP or HTTPS URL with a hostname")
	}
	host, err := canonicalHost(u.Hostname())
	if err != nil {
		return authority{}, err
	}
	port := uint64(80)
	if u.Scheme == "https" {
		port = 443
	}
	if u.Port() != "" {
		port, err = strconv.ParseUint(u.Port(), 10, 16)
		if err != nil || port == 0 {
			return authority{}, errors.New("invalid scan root port")
		}
	}
	return authority{host: host, port: uint16(port)}, nil
}

// HTTP-to-HTTPS and HTTPS-to-HTTP redirects on the same host and their usual
// ports retain the root's pinned addresses. A custom scheme/port combination
// does not grant the other port private-network access.
func defaultPairForRoot(rawURL string, root authority) uint16 {
	u, err := url.ParseRequestURI(rawURL)
	if err != nil {
		return 0
	}
	if u.Scheme == "http" && root.port == 80 {
		return 443
	}
	if u.Scheme == "https" && root.port == 443 {
		return 80
	}
	return 0
}

func canonicalHost(host string) (string, error) {
	if ip, err := netip.ParseAddr(host); err == nil {
		return ip.Unmap().String(), nil
	}
	host = strings.TrimSuffix(strings.ToLower(host), ".")
	ascii, err := idna.Lookup.ToASCII(host)
	if err != nil || ascii == "" || strings.ContainsAny(ascii, " /\\:@") {
		return "", errors.New("invalid destination hostname")
	}
	return strings.ToLower(ascii), nil
}

func resolveIPs(ctx context.Context, resolver ipResolver, host string) ([]netip.Addr, error) {
	if ip, err := netip.ParseAddr(host); err == nil {
		return []netip.Addr{ip.Unmap()}, nil
	}
	answers, err := resolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, err
	}
	seen := make(map[netip.Addr]struct{}, len(answers))
	addresses := make([]netip.Addr, 0, len(answers))
	for _, answer := range answers {
		ip, ok := netip.AddrFromSlice(answer.IP)
		if !ok {
			return nil, errors.New("resolver returned invalid IP address")
		}
		if answer.Zone != "" {
			ip = ip.WithZone(answer.Zone)
		}
		ip = ip.Unmap()
		if _, exists := seen[ip]; !exists {
			seen[ip] = struct{}{}
			addresses = append(addresses, ip)
		}
	}
	if len(addresses) == 0 {
		return nil, errors.New("destination has no IP addresses")
	}
	return addresses, nil
}

func publicAddress(ip netip.Addr) bool {
	return rootdns.PublicIP(ip)
}
