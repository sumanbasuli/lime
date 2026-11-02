package scanner

import (
	"context"
	"sync"
	"time"

	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
	log "github.com/sumanbasuli/lime/shopkeeper/internal/safelog"
)

const maxConcurrentScans = 2

// scanScheduler uses pending database rows as its durable queue. Handler calls
// only wake it; no goroutine waits for an admission slot per submitted scan.
type scanScheduler struct {
	ctx            context.Context
	listPending    func(context.Context, int) ([]models.Scan, error)
	run            func(models.Scan)
	pause          func(context.Context, string) error
	recoverOrphans func(context.Context)

	startOnce sync.Once
	wake      chan struct{}
	mu        sync.Mutex
	active    map[string]struct{}
}

func newScanScheduler(
	ctx context.Context,
	listPending func(context.Context, int) ([]models.Scan, error),
	run func(models.Scan),
	pause func(context.Context, string) error,
) *scanScheduler {
	return &scanScheduler{
		ctx:         ctx,
		listPending: listPending,
		run:         run,
		pause:       pause,
		wake:        make(chan struct{}, 1),
		active:      make(map[string]struct{}),
	}
}

func (q *scanScheduler) start() {
	q.startOnce.Do(func() { go q.loop() })
}

func (q *scanScheduler) notify() {
	select {
	case q.wake <- struct{}{}:
	default:
	}
}

func (q *scanScheduler) loop() {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	orphanTicker := time.NewTicker(30 * time.Second)
	defer orphanTicker.Stop()
	for {
		q.dispatch()
		select {
		case <-q.ctx.Done():
			return
		case <-q.wake:
		case <-ticker.C:
		case <-orphanTicker.C:
			if q.recoverOrphans != nil {
				recoverCtx, cancel := context.WithTimeout(q.ctx, 10*time.Second)
				q.recoverOrphans(recoverCtx)
				cancel()
			}
		}
	}
}

func (q *scanScheduler) dispatch() {
	q.mu.Lock()
	full := len(q.active) >= maxConcurrentScans
	q.mu.Unlock()
	if full || q.ctx.Err() != nil {
		return
	}

	queryCtx, cancel := context.WithTimeout(q.ctx, 10*time.Second)
	defer cancel()
	// Active scans can still be pending briefly while their pipeline starts.
	// Fetch enough rows to see past those at the head of the queue.
	scans, err := q.listPending(queryCtx, maxConcurrentScans*2)
	if err != nil {
		if q.ctx.Err() == nil {
			log.Printf("Scanner: failed to load pending scans: %v", err)
		}
		return
	}

	paused := false
	for _, scan := range scans {
		if q.isActive(scan.ID) {
			continue
		}
		if scan.PauseRequested {
			if err := q.pause(queryCtx, scan.ID); err != nil {
				log.Printf("Scanner: failed to pause queued scan %s: %v", scan.ID, err)
			} else {
				paused = true
			}
			continue
		}
		if !q.admit(scan.ID) {
			continue
		}
		go func(scan models.Scan) {
			defer q.finish(scan.ID)
			q.run(scan)
		}(scan)
	}
	if paused {
		q.notify()
	}
}

func (q *scanScheduler) isActive(id string) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	_, active := q.active[id]
	return active
}

func (q *scanScheduler) admit(id string) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.active) >= maxConcurrentScans {
		return false
	}
	if _, running := q.active[id]; running {
		return false
	}
	q.active[id] = struct{}{}
	return true
}

func (q *scanScheduler) finish(id string) {
	q.mu.Lock()
	delete(q.active, id)
	q.mu.Unlock()
	q.notify()
}
