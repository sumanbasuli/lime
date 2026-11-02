package linkchecker

import (
	"bytes"
	"context"
	"errors"
	"log"
	"strings"
	"testing"
)

type failingQueueStore struct{ *memoryStore }

func (failingQueueStore) ReadyLinkCheckIDs(context.Context) ([]string, error) {
	return nil, errors.New("GET https://example.test/path?token=QUERY_TOKEN_CANARY: failed")
}

func TestLinkQueueErrorLogOmitsTargetQuery(t *testing.T) {
	var output bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&output)
	defer log.SetOutput(previous)

	NewRunner(failingQueueStore{newMemoryStore()}).poll(context.Background())
	message := output.String()
	if !strings.Contains(message, "[URL details omitted]") || strings.Contains(message, "QUERY_TOKEN_CANARY") {
		t.Fatalf("unsafe link queue error log: %q", message)
	}
}
