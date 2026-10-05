package mcp

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
)

type blockingScanRepository struct {
	*stubRepository
	started chan struct{}
	err     error
}

func (r *blockingScanRepository) GetScan(ctx context.Context, _ string) (*models.Scan, error) {
	r.calls++
	close(r.started)
	<-ctx.Done()
	r.err = ctx.Err()
	return nil, r.err
}

func TestInFlightToolReadHonorsRequestCancellation(t *testing.T) {
	for _, deadline := range []bool{false, true} {
		name := "canceled"
		if deadline {
			name = "deadline exceeded"
		}
		t.Run(name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			if deadline {
				cancel()
				ctx, cancel = context.WithTimeout(context.Background(), 100*time.Millisecond)
			}
			defer cancel()
			repo := &blockingScanRepository{stubRepository: newStubRepository(), started: make(chan struct{})}
			request := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_scan","arguments":{"scan_id":"`+testScanID+`"}}}`)).WithContext(ctx)
			request.Header.Set("Authorization", "Bearer "+testToken)
			response := httptest.NewRecorder()
			finished := make(chan struct{})
			go func() {
				defer close(finished)
				New(repo).ServeHTTP(response, request)
			}()
			select {
			case <-repo.started:
			case <-time.After(time.Second):
				t.Fatal("tool did not reach the in-flight data read")
			}
			if !deadline {
				cancel()
			}
			select {
			case <-finished:
			case <-time.After(time.Second):
				t.Fatal("request cancellation did not reach the repository")
			}
			if !errors.Is(repo.err, ctx.Err()) || repo.calls != 1 {
				t.Fatalf("canceled read should stop before score lookup: cause=%v reads=%d", repo.err, repo.calls)
			}
			result := responseObject(t, response)["result"].(map[string]any)
			if result["isError"] != true || strings.Contains(response.Body.String(), ctx.Err().Error()) {
				t.Fatalf("interrupted read should return only a generic tool error: %s", response.Body.String())
			}
		})
	}
}
