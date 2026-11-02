package linkchecker

import (
	"context"
	"sync"
	"time"

	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
	log "github.com/sumanbasuli/lime/shopkeeper/internal/safelog"
)

type Store interface {
	RecoverLinkChecks(context.Context) error
	ReadyLinkCheckIDs(context.Context) ([]string, error)
	ClaimLinkCheck(context.Context, string) (*models.LinkCheck, error)
	ObserveLinkCheckRootDNS(context.Context, string, bool, bool) error
	GuardLinkCheckPrivateRootDial(context.Context, string) (func(), error)
	// SaveLinkCheck atomically merges changed result rows with job progress.
	SaveLinkCheck(context.Context, models.LinkCheck, []models.LinkResult) error
}

// Runner polls durable jobs and owns at most two HTTP-only workers per process.
// As with the existing accessibility scanner, run one Shopkeeper per database.
type Runner struct {
	store   Store
	checker *Checker
	mu      sync.Mutex
	cancels map[string]context.CancelFunc
	stop    context.CancelFunc
	wg      sync.WaitGroup
	slots   chan struct{}
}

func NewRunner(store Store) *Runner {
	return &Runner{store: store, checker: New(), cancels: map[string]context.CancelFunc{}, slots: make(chan struct{}, 2)}
}

func (r *Runner) Start(parent context.Context) error {
	if err := r.store.RecoverLinkChecks(parent); err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(parent)
	r.stop = cancel
	r.wg.Add(1)
	go func() {
		defer r.wg.Done()
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			r.poll(ctx)
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	return nil
}

func (r *Runner) poll(ctx context.Context) {
	ids, err := r.store.ReadyLinkCheckIDs(ctx)
	if err != nil {
		if ctx.Err() == nil {
			log.Printf("Link checker queue: %v", err)
		}
		return
	}
	for _, id := range ids {
		select {
		case r.slots <- struct{}{}:
		default:
			return
		}
		r.wg.Add(1)
		go func(id string) {
			defer r.wg.Done()
			defer func() { <-r.slots }()
			runCtx, cancel := context.WithCancel(ctx)
			r.mu.Lock()
			if _, alreadyRunning := r.cancels[id]; alreadyRunning {
				r.mu.Unlock()
				cancel()
				return
			}
			r.cancels[id] = cancel
			r.mu.Unlock()
			defer cancel()
			defer func() { r.mu.Lock(); delete(r.cancels, id); r.mu.Unlock() }()
			job, err := r.store.ClaimLinkCheck(runCtx, id)
			if err != nil {
				log.Printf("Claim link check %s: %v", id, err)
				return
			}
			if job == nil {
				return
			}
			final, results, err := r.checker.RunObservedDelta(runCtx, *job, func(j models.LinkCheck, results []models.LinkResult) error {
				persistCtx, persistCancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer persistCancel()
				return r.store.SaveLinkCheck(persistCtx, j, results)
			}, func(ctx context.Context, public, nonPublic bool) error {
				return r.store.ObserveLinkCheckRootDNS(ctx, job.ID, public, nonPublic)
			}, func(ctx context.Context) (func(), error) {
				return r.store.GuardLinkCheckPrivateRootDial(ctx, job.ID)
			})
			if err != nil && runCtx.Err() == nil {
				log.Printf("Link check %s: %v", id, err)
				final.Status = "failed"
				final.Error = pointer("Link checking stopped because results could not be persisted")
				persistCtx, persistCancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer persistCancel()
				if saveErr := r.store.SaveLinkCheck(persistCtx, final, results); saveErr != nil {
					log.Printf("Fail link check %s: %v", id, saveErr)
				}
			}
		}(id)
	}
}

// Cancel only interrupts in-flight requests. The HTTP handler commits cancelled
// status first, so even a completion racing with this call cannot undo it.
func (r *Runner) Cancel(id string) {
	r.mu.Lock()
	cancel := r.cancels[id]
	r.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (r *Runner) Stop() {
	if r.stop != nil {
		r.stop()
	}
	r.wg.Wait()
}
