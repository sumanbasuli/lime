package mcp

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

func actionRPCRequest(id string) *http.Request {
	body := fmt.Sprintf(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_scan","arguments":{"request_id":"%s","sitemap_url":"https://example.test"}}}`, id)
	req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+testToken)
	return req
}

func TestMCPActionAdmissionCoversFinalEncodingAndBlockedWrite(t *testing.T) {
	r := newActionRepository()
	s := New(r, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusCreated, map[string]any{"id": testScanID})
	}))
	ids := []string{
		"dddddddd-dddd-4ddd-8ddd-dddddddddddd",
		"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
		"ffffffff-ffff-4fff-8fff-ffffffffffff",
	}
	writers := []*blockedReadWriter{}
	done := []chan struct{}{}
	defer func() {
		for i, writer := range writers {
			select {
			case <-writer.unblock:
			default:
				close(writer.unblock)
			}
			<-done[i]
		}
	}()
	for _, id := range ids[:2] {
		writer := &blockedReadWriter{ResponseRecorder: httptest.NewRecorder(), started: make(chan struct{}), unblock: make(chan struct{})}
		writers = append(writers, writer)
		finished := make(chan struct{})
		done = append(done, finished)
		go func(id string) {
			defer close(finished)
			s.ServeHTTP(writer, actionRPCRequest(id))
		}(id)
		select {
		case <-writer.started:
		case <-time.After(3 * time.Second):
			t.Fatal("action did not reach final HTTP write")
		}
		if writer.deadline.IsZero() {
			t.Fatal("action delivery has no write deadline")
		}
	}
	busy := httptest.NewRecorder()
	s.ServeHTTP(busy, actionRPCRequest(ids[2]))
	if busy.Code != http.StatusServiceUnavailable || busy.Header().Get("Retry-After") != "1" || busy.Body.Len() > 1024 {
		t.Fatalf("third action bypassed blocked delivery admission: status=%d body=%s", busy.Code, busy.Body.String())
	}
	r.mu.Lock()
	_, reserved := r.entries[ids[2]]
	r.mu.Unlock()
	if reserved {
		t.Fatal("busy action reserved a request ID")
	}
	close(writers[0].unblock)
	<-done[0]
	replacement := httptest.NewRecorder()
	s.ServeHTTP(replacement, actionRPCRequest(ids[0]))
	if replacement.Code != http.StatusOK || strings.Contains(replacement.Body.String(), `"isError":true`) {
		t.Fatalf("completed write did not release action capacity: status=%d body=%s", replacement.Code, replacement.Body.String())
	}
}

type cleanupActionRepository struct {
	*actionRepository
	beginErr error
	until    time.Time
	closed   int
}

func (r *cleanupActionRepository) BeginMCPActionCall(ctx context.Context) (context.Context, func() time.Time, error) {
	return ctx, func() time.Time { r.closed++; return r.until }, r.beginErr
}

func TestMCPActionFailedStartupCleanupAndUncertainLease(t *testing.T) {
	repo := &cleanupActionRepository{
		actionRepository: newActionRepository(),
		beginErr:         errors.New("private SQL startup detail"),
		until:            time.Now().Add(100 * time.Millisecond),
	}
	state := &actionLifecycle{}
	_, admitted, err := state.begin(context.Background(), repo)
	if !admitted || err == nil {
		t.Fatal("startup failure did not acquire action cleanup lease")
	}
	state.finish()
	state.finish()
	if repo.closed != 1 || len(nativeActionSlots) != 1 {
		t.Fatal("uncertain startup released early or cleaned twice")
	}
	deadline := time.Now().Add(time.Second)
	for len(nativeActionSlots) != 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if len(nativeActionSlots) != 0 {
		t.Fatal("uncertain action lease never recovered")
	}
	repo.until = time.Time{}
	response := httptest.NewRecorder()
	New(repo, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusCreated, map[string]any{"id": testScanID})
	})).ServeHTTP(response, actionRPCRequest("99999999-9999-4999-8999-999999999999"))
	if strings.Contains(response.Body.String(), "private SQL") || !strings.Contains(response.Body.String(), `"isError":true`) || len(nativeActionSlots) != 0 {
		t.Fatalf("startup error leaked or admission not recovered: status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestMCPActionRealSocketDeliveryDeadline(t *testing.T) {
	if os.Getenv("LIME_TEST_MCP_DELIVERY") != "1" {
		t.Skip("set LIME_TEST_MCP_DELIVERY=1 for the 30-second real socket deadline regression")
	}
	r := newActionRepository()
	s := New(r, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusCreated, map[string]any{"id": testScanID})
	}))
	ids := []string{
		"11111111-aaaa-4111-8111-111111111111",
		"22222222-bbbb-4222-8222-222222222222",
		"33333333-cccc-4333-8333-333333333333",
	}
	for _, id := range ids[:2] {
		result, rpcErr := s.handleToolCall(context.Background(), []byte(`{"name":"create_scan","arguments":{"request_id":"`+id+`","sitemap_url":"https://example.test"}}`))
		if rpcErr != nil || result.(map[string]any)["isError"] == true {
			t.Fatalf("could not seed action %s: result=%v err=%v", id, result, rpcErr)
		}
		r.entries[id].Response = []byte(`{"action":"create_scan","http_status":201,"data":{"text":"` + strings.Repeat("x", 1750000) + `"},"request_id":"` + id + `","replayed":false}`)
	}
	server := httptest.NewServer(s)
	defer server.Close()
	address := strings.TrimPrefix(server.URL, "http://")
	for _, id := range ids[:2] {
		conn, err := net.DialTimeout("tcp", address, time.Second)
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		if tcp, ok := conn.(*net.TCPConn); ok {
			_ = tcp.SetReadBuffer(1024)
		}
		body := fmt.Sprintf(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_scan","arguments":{"request_id":"%s","sitemap_url":"https://example.test"}}}`, id)
		if _, err := fmt.Fprintf(conn, "POST /mcp HTTP/1.1\r\nHost: %s\r\nAuthorization: Bearer %s\r\nContent-Length: %d\r\n\r\n%s", address, testToken, len(body), body); err != nil {
			t.Fatal(err)
		}
		_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		response, err := http.ReadResponse(bufio.NewReader(conn), nil)
		if err != nil || response.StatusCode != http.StatusOK {
			t.Fatalf("wire response headers failed: %v", err)
		}
	}
	busy := httptest.NewRecorder()
	s.ServeHTTP(busy, actionRPCRequest(ids[2]))
	if busy.Code != http.StatusServiceUnavailable || busy.Body.Len() > 1024 {
		t.Fatal("paused peers did not retain action capacity")
	}
	started := time.Now()
	deadline := started.Add(35 * time.Second)
	for len(nativeActionSlots) != 0 && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if len(nativeActionSlots) != 0 || time.Since(started) < 25*time.Second {
		t.Fatal("real action delivery deadline missing or admission freed before paused transfers stopped")
	}
}

func TestMCPActionBusyBeforeNewIDReservationAndDashboardMarkerIndependent(t *testing.T) {
	r := newActionRepository()
	started := make(chan struct{}, 2)
	release := make(chan struct{})
	var releaseOnce sync.Once
	releaseAll := func() { releaseOnce.Do(func() { close(release) }) }
	defer releaseAll()
	s := New(r, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		started <- struct{}{}
		<-release
		writeJSON(w, http.StatusCreated, map[string]any{"id": testScanID})
	}))
	ids := []string{
		"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		"cccccccc-cccc-4ccc-8ccc-cccccccccccc",
	}
	done := make(chan *httptest.ResponseRecorder, 3)
	for _, id := range ids[:2] {
		go func(id string) {
			w := httptest.NewRecorder()
			s.ServeHTTP(w, actionRPCRequest(id))
			done <- w
		}(id)
	}
	for i := 0; i < 2; i++ {
		select {
		case <-started:
		case <-time.After(3 * time.Second):
			t.Fatal("two actions did not reach the business handler")
		}
	}

	third := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		w := httptest.NewRecorder()
		s.ServeHTTP(w, actionRPCRequest(ids[2]))
		third <- w
	}()
	select {
	case w := <-third:
		if w.Code != http.StatusServiceUnavailable || !strings.Contains(strings.ToLower(w.Body.String()), "busy") {
			t.Fatalf("third action was not denied at capacity: status=%d body=%s", w.Code, w.Body.String())
		}
	case <-time.After(3 * time.Second):
		t.Fatal("third action blocked behind occupied slots")
	}
	r.mu.Lock()
	_, thirdReserved := r.entries[ids[2]]
	reservations := len(r.entries)
	r.mu.Unlock()
	if thirdReserved || reservations != 2 {
		t.Fatalf("busy response reserved a new request ID: third=%v rows=%d", thirdReserved, reservations)
	}

	markerBody := `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"update_settings","arguments":{"confirm":true,"pdf_reports_enabled":true}}}`
	markerReq := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(markerBody))
	markerReq.Header.Set("Authorization", "Bearer "+testToken)
	marker := httptest.NewRecorder()
	s.ServeHTTP(marker, markerReq)
	if marker.Code != http.StatusOK || !strings.Contains(marker.Body.String(), `"requires_dashboard":true`) {
		t.Fatalf("dashboard marker was blocked by native action capacity: status=%d body=%s", marker.Code, marker.Body.String())
	}
	releaseAll()
	for i := 0; i < 2; i++ {
		select {
		case w := <-done:
			if w.Code != http.StatusOK {
				t.Fatalf("admitted action did not finish: status=%d body=%s", w.Code, w.Body.String())
			}
		case <-time.After(3 * time.Second):
			t.Fatal("admitted action did not release its slot")
		}
	}
}
