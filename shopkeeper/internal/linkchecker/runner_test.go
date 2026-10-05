package linkchecker

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
)

type memoryStore struct {
	mu        sync.Mutex
	jobs      map[string]models.LinkCheck
	recovered bool
	claims    map[string]int
	completed chan string
}

func newMemoryStore(jobs ...models.LinkCheck) *memoryStore {
	s := &memoryStore{jobs: map[string]models.LinkCheck{}, claims: map[string]int{}, completed: make(chan string, 10)}
	for _, j := range jobs {
		s.jobs[j.ID] = j
	}
	return s
}
func (s *memoryStore) RecoverLinkChecks(context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.recovered = true
	for id, j := range s.jobs {
		if j.Status == "running" {
			j.Status = "queued"
			s.jobs[id] = j
		}
	}
	return nil
}
func (s *memoryStore) ReadyLinkCheckIDs(context.Context) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ids := []string{}
	for id, j := range s.jobs {
		if j.Status == "queued" {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	if len(ids) > 2 {
		ids = ids[:2]
	}
	return ids, nil
}
func (s *memoryStore) ClaimLinkCheck(_ context.Context, id string) (*models.LinkCheck, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	j := s.jobs[id]
	if j.Status != "queued" {
		return nil, nil
	}
	j.Status = "running"
	s.jobs[id] = j
	s.claims[id]++
	return &j, nil
}
func (s *memoryStore) SaveLinkCheck(_ context.Context, j models.LinkCheck, _ []models.LinkResult) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.jobs[j.ID].Status != "running" {
		return nil
	}
	s.jobs[j.ID] = j
	if j.Status == "completed" || j.Status == "failed" {
		s.completed <- j.ID
	}
	return nil
}

func TestRunnerRecoversDurableInterruptedJob(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, "<html></html>")
	}))
	defer server.Close()
	store := newMemoryStore(models.LinkCheck{ID: "recover", URL: server.URL, CheckType: "single", MaxPages: 1, Status: "running"})
	runner := NewRunner(store)
	if err := runner.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer runner.Stop()
	select {
	case id := <-store.completed:
		if id != "recover" {
			t.Fatal("wrong recovered job")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("recovered job did not finish")
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if !store.recovered || store.claims["recover"] != 1 || store.jobs["recover"].Status != "completed" {
		t.Fatalf("recovery=%+v", store)
	}
}

func TestRunnerLimitsWorkersAndStopsInFlightRequests(t *testing.T) {
	entered := make(chan struct{}, 3)
	var mu sync.Mutex
	active, maxActive := 0, 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		active++
		if active > maxActive {
			maxActive = active
		}
		mu.Unlock()
		entered <- struct{}{}
		<-r.Context().Done()
		mu.Lock()
		active--
		mu.Unlock()
	}))
	defer server.Close()
	jobs := []models.LinkCheck{}
	for i := 0; i < 3; i++ {
		jobs = append(jobs, models.LinkCheck{ID: fmt.Sprint(i), URL: server.URL, CheckType: "single", MaxPages: 1, Status: "queued"})
	}
	store := newMemoryStore(jobs...)
	runner := NewRunner(store)
	if err := runner.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		select {
		case <-entered:
		case <-time.After(3 * time.Second):
			runner.Stop()
			t.Fatal("worker did not start")
		}
	}
	select {
	case <-entered:
		runner.Stop()
		t.Fatal("third worker exceeded concurrency limit")
	case <-time.After(50 * time.Millisecond):
	}
	stopped := make(chan struct{})
	go func() { runner.Stop(); close(stopped) }()
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("shutdown did not cancel HTTP requests")
	}
	mu.Lock()
	defer mu.Unlock()
	if maxActive != 2 {
		t.Fatalf("max concurrent HTTP requests=%d", maxActive)
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if len(store.claims) != 2 {
		t.Fatalf("shutdown started additional jobs: %v", store.claims)
	}
}

func TestRunnerCancelCannotResurrectPersistedCancellation(t *testing.T) {
	entered := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { entered <- struct{}{}; <-r.Context().Done() }))
	defer server.Close()
	store := newMemoryStore(models.LinkCheck{ID: "cancel", URL: server.URL, CheckType: "single", MaxPages: 1, Status: "queued"})
	runner := NewRunner(store)
	if err := runner.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		runner.Stop()
		t.Fatal("worker did not start")
	}
	store.mu.Lock()
	j := store.jobs["cancel"]
	j.Status = "cancelled"
	store.jobs["cancel"] = j
	store.mu.Unlock()
	runner.Cancel("cancel")
	runner.Stop()
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.jobs["cancel"].Status != "cancelled" {
		t.Fatal("late worker resurrected cancellation")
	}
}
