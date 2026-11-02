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

	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
	"github.com/sumanbasuli/lime/shopkeeper/internal/repository"
)

type blockedReadWriter struct {
	*httptest.ResponseRecorder
	started  chan struct{}
	unblock  chan struct{}
	once     sync.Once
	deadline time.Time
}

func (w *blockedReadWriter) SetWriteDeadline(deadline time.Time) error {
	w.deadline = deadline
	return nil
}
func (w *blockedReadWriter) Write(body []byte) (int, error) {
	w.once.Do(func() { close(w.started) })
	<-w.unblock
	return w.ResponseRecorder.Write(body)
}

func nativeReadRequest() *http.Request {
	r := httptest.NewRequest("POST", "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":9007199254740993,"method":"tools/call","params":{"name":"get_scan","arguments":{"scan_id":"`+testScanID+`"}}}`))
	r.Header.Set("Authorization", "Bearer "+testToken)
	return r
}

type unavailableAuthRepository struct {
	*stubRepository
	failAt int
	calls  int
}

func (r *unavailableAuthRepository) GetMCPAuthSettings(ctx context.Context) (*models.MCPAuthSettings, error) {
	r.calls++
	if r.calls == r.failAt {
		return nil, errors.New("private authorization SQL detail")
	}
	return r.stubRepository.GetMCPAuthSettings(ctx)
}

func TestNativeAuthUnavailableBeforeDispatch(t *testing.T) {
	for _, failAt := range []int{1, 2} {
		t.Run(fmt.Sprint(failAt), func(t *testing.T) {
			repo := &unavailableAuthRepository{stubRepository: newStubRepository(), failAt: failAt}
			response := httptest.NewRecorder()
			New(repo).ServeHTTP(response, nativeReadRequest())
			if response.Code != 503 || response.Header().Get("Retry-After") != "1" || repo.stubRepository.calls != 0 ||
				strings.Contains(response.Body.String(), `"id"`) || strings.Contains(response.Body.String(), "private") {
				t.Fatal("authorization failure reached dispatch, leaked details, or changed the capacity response", response.Body.String())
			}
		})
	}
	repo := newStubRepository()
	repo.auth.Enabled = false
	response := httptest.NewRecorder()
	New(repo).ServeHTTP(response, nativeReadRequest())
	if response.Code != 401 || response.Header().Get("WWW-Authenticate") == "" || repo.calls != 0 {
		t.Fatal("disabled MCP no longer fails authentication", response.Body.String())
	}
}

func TestNativeReadAdmissionCoversFinalEncodingAndWrite(t *testing.T) {
	repo := newStubRepository()
	large := strings.Repeat("x", 1<<20)
	repo.scan.Tag = &large
	writers := []*blockedReadWriter{}
	done := []chan struct{}{}
	for i := 0; i < 2; i++ {
		writer := &blockedReadWriter{ResponseRecorder: httptest.NewRecorder(), started: make(chan struct{}), unblock: make(chan struct{})}
		writers = append(writers, writer)
		finished := make(chan struct{})
		done = append(done, finished)
		go func() { defer close(finished); New(repo).ServeHTTP(writer, nativeReadRequest()) }()
		select {
		case <-writer.started:
		case <-time.After(2 * time.Second):
			t.Fatal("read did not reach encoding/write")
		}
		if writer.deadline.IsZero() {
			t.Fatal("delivery has no deadline")
		}
	}
	defer func() {
		for i, w := range writers {
			select {
			case <-w.unblock:
			default:
				close(w.unblock)
			}
			<-done[i]
		}
	}()
	reads := repo.calls
	busy := httptest.NewRecorder()
	New(repo).ServeHTTP(busy, nativeReadRequest())
	if busy.Code != 503 || busy.Header().Get("Retry-After") != "1" || strings.Contains(busy.Body.String(), `"id"`) || repo.calls != reads {
		t.Fatal("third read bypassed encoding/delivery admission", busy.Body.String())
	}
	// A dashboard marker is small and independent of the native evidence slots.
	marker := postRPC(New(repo), `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_screenshot","arguments":{"scan_id":"`+testScanID+`","filename":"page.png"}}}`, nil)
	if !strings.Contains(marker.Body.String(), `"requires_dashboard":true`) {
		t.Fatal(marker.Body.String())
	}
	close(writers[0].unblock)
	<-done[0]
	replacement := httptest.NewRecorder()
	New(repo).ServeHTTP(replacement, nativeReadRequest())
	if responseObject(t, replacement)["result"].(map[string]any)["isError"] == true {
		t.Fatal("normal completion did not free read capacity")
	}
}

type cleanupReadRepository struct {
	*stubRepository
	beginErr error
	until    time.Time
	closed   int
}

func (r *cleanupReadRepository) BeginMCPRead(ctx context.Context) (context.Context, func() time.Time, error) {
	return ctx, func() time.Time { r.closed++; return r.until }, r.beginErr
}

func TestNativeReadFailedStartupCleanupAndUncertainLease(t *testing.T) {
	repo := &cleanupReadRepository{stubRepository: newStubRepository(), beginErr: errors.New("private SQL startup detail"), until: time.Now().Add(100 * time.Millisecond)}
	state := &readLifecycle{}
	_, admitted, err := state.begin(context.Background(), repo)
	if !admitted || err == nil {
		t.Fatal("startup control failed")
	}
	state.finish()
	state.finish()
	if repo.closed != 1 || len(nativeReadSlots) != 1 {
		t.Fatal("uncertain startup released early or cleaned twice")
	}
	deadline := time.Now().Add(time.Second)
	for len(nativeReadSlots) != 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if len(nativeReadSlots) != 0 {
		t.Fatal("uncertain lease never recovered")
	}
	repo.until = time.Time{}
	response := httptest.NewRecorder()
	New(repo).ServeHTTP(response, nativeReadRequest())
	if strings.Contains(response.Body.String(), "private SQL") || !strings.Contains(response.Body.String(), `"isError":true`) || len(nativeReadSlots) != 0 {
		t.Fatal("startup error leaked or admission not recovered")
	}
}

func TestNativeReadBudgetErrorAndValidationKeepToolContract(t *testing.T) {
	repo := newStubRepository()
	repo.err = repository.ErrMCPReadTooLarge
	response := httptest.NewRecorder()
	New(repo).ServeHTTP(response, nativeReadRequest())
	result := responseObject(t, response)["result"].(map[string]any)
	if response.Code != 200 || result["isError"] != true || result["structuredContent"].(map[string]any)["http_status"] != float64(413) || !strings.Contains(response.Body.String(), "no data was truncated") || len(nativeReadSlots) != 0 {
		t.Fatal("read budget contract changed", response.Body.String())
	}
	guard := &cleanupReadRepository{stubRepository: newStubRepository()}
	invalid := postRPC(New(guard), `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_scan","arguments":{"scan_id":"not-a-uuid"}}}`, nil)
	if !strings.Contains(invalid.Body.String(), "UUID") || guard.closed != 0 {
		t.Fatal("invalid arguments started a read transaction")
	}
}

func TestNativeReadRealSocketDeliveryDeadline(t *testing.T) {
	if os.Getenv("LIME_TEST_MCP_DELIVERY") != "1" {
		t.Skip("set LIME_TEST_MCP_DELIVERY=1 for the 30-second real socket deadline regression")
	}
	repo := newStubRepository()
	tag := strings.Repeat("x", 8<<20)
	repo.scan.Tag = &tag
	server := httptest.NewServer(New(repo))
	defer server.Close()
	address := strings.TrimPrefix(server.URL, "http://")
	connections := []net.Conn{}
	for i := 0; i < 2; i++ {
		conn, err := net.DialTimeout("tcp", address, time.Second)
		if err != nil {
			t.Fatal(err)
		}
		connections = append(connections, conn)
		defer conn.Close()
		body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_scan","arguments":{"scan_id":"` + testScanID + `"}}}`
		fmt.Fprintf(conn, "POST /mcp HTTP/1.1\r\nHost: %s\r\nAuthorization: Bearer %s\r\nContent-Length: %d\r\n\r\n%s", address, testToken, len(body), body)
		conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		response, err := http.ReadResponse(bufio.NewReader(conn), nil)
		if err != nil || response.StatusCode != 200 {
			t.Fatalf("wire response headers failed: %v", err)
		}
	}
	busy := httptest.NewRecorder()
	New(repo).ServeHTTP(busy, nativeReadRequest())
	if busy.Code != 503 || busy.Body.Len() > 1024 {
		t.Fatal("paused peer did not retain read capacity")
	}
	started := time.Now()
	deadline := started.Add(35 * time.Second)
	for len(nativeReadSlots) != 0 && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if len(nativeReadSlots) != 0 || time.Since(started) < 25*time.Second {
		t.Fatal("real delivery deadline missing or admission freed before paused transfer stopped")
	}
	// An unread large response could not finish through the TCP buffers. A new
	// read succeeds only after net/http's write deadline ended the blocked writes.
	replacement := postRPC(New(newStubRepository()), `{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"list_scans","arguments":{}}}`, nil)
	if strings.Contains(replacement.Body.String(), `"isError":true`) {
		t.Fatal("deadline did not recover capacity")
	}
}
