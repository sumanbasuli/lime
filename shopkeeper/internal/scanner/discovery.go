package scanner

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
	"github.com/sumanbasuli/lime/shopkeeper/internal/profiler"
	"github.com/sumanbasuli/lime/shopkeeper/internal/repository"
	"github.com/sumanbasuli/lime/shopkeeper/internal/rootdns"
	log "github.com/sumanbasuli/lime/shopkeeper/internal/safelog"
)

const discoverySlice = 10 * time.Minute
const discoveryHeartbeat = 30 * time.Second

// runDiscoveryAdmission owns the wall-clock fairness slice and monotonic active
// clock. The repository owns the durable reservation and the admission epoch.
// A returned ready value means publication and the guarded page transition both
// committed; the caller may start scanning the saved URLs immediately.
func (s *Scanner) runDiscoveryAdmission(runCtx context.Context, scan models.Scan, observe rootdns.Observer, guard rootdns.PrivateDialGuard) (bool, error) {
	beginCtx, beginCancel := context.WithTimeout(context.Background(), 10*time.Second)
	admission, err := s.repo.StartDiscoveryAdmission(beginCtx, scan.ID)
	beginCancel()
	if err != nil {
		return false, fmt.Errorf("start discovery admission: %w", err)
	}

	started := time.Now()
	limit := min(discoverySlice, admission.Remaining)
	workCtx, cancelWork := context.WithTimeout(runCtx, limit)
	defer cancelWork()
	stopHeartbeat := make(chan struct{})
	heartbeatDone := make(chan error, 1)
	go func() {
		ticker := time.NewTicker(discoveryHeartbeat)
		defer ticker.Stop()
		for {
			select {
			case <-stopHeartbeat:
				heartbeatDone <- nil
				return
			case <-ticker.C:
				renewCtx, renewCancel := context.WithTimeout(context.Background(), 10*time.Second)
				err := s.repo.RenewDiscoveryAdmission(renewCtx, scan.ID, admission.Epoch, time.Since(started))
				renewCancel()
				if err != nil {
					cancelWork()
					heartbeatDone <- err
					return
				}
			}
		}
	}()

	result, workErr := profiler.DiscoverCheckpointed(workCtx, scan.ID, scan.SitemapURL, admission.Epoch, s.repo, observe, guard)
	close(stopHeartbeat)
	heartbeatErr := <-heartbeatDone
	cancelWork()
	// Profiler has drained its fetch/probe workers before returning. Settle the
	// admission only after the heartbeat has stopped and all work is quiescent.
	endCtx, endCancel := context.WithTimeout(context.Background(), 10*time.Second)
	endErr := s.repo.EndDiscoveryAdmission(endCtx, scan.ID, admission.Epoch, time.Since(started))
	endCancel()
	if endErr != nil {
		return false, fmt.Errorf("settle discovery admission: %w", endErr)
	}
	if heartbeatErr != nil {
		if err := s.requeueDiscovery(scan.ID, admission.Epoch); err != nil {
			return false, errors.Join(fmt.Errorf("renew discovery admission: %w", heartbeatErr), err)
		}
		return false, fmt.Errorf("renew discovery admission: %w", heartbeatErr)
	}

	// A pause requested during publication can leave a fully published list and
	// a paused scan. The guarded transition resolves this under the scan lock.
	if result == profiler.DiscoveryComplete && workErr == nil {
		finishCtx, finishCancel := context.WithTimeout(context.Background(), 10*time.Second)
		status, err := s.repo.CompleteDiscoveryProfiling(finishCtx, scan.ID, admission.Epoch)
		finishCancel()
		if err != nil {
			return false, fmt.Errorf("complete discovery profiling: %w", err)
		}
		return status == "scanning", nil
	}

	if s.shouldPause(runCtx, context.Background(), scan.ID) {
		return false, s.requeueDiscovery(scan.ID, admission.Epoch)
	}
	if workErr == nil && result == profiler.DiscoveryYielded {
		return false, s.requeueDiscovery(scan.ID, admission.Epoch)
	}
	if workErr == nil {
		return false, repository.ErrDiscoveryInvariant
	}
	if profiler.IsDiscoveryPersistenceError(workErr) {
		if err := s.requeueDiscovery(scan.ID, admission.Epoch); err != nil {
			return false, errors.Join(workErr, err)
		}
		return false, workErr
	}
	log.Printf("Scanner: discovery failed for scan %s: %v", scan.ID, workErr)
	failCtx, failCancel := context.WithTimeout(context.Background(), 10*time.Second)
	failErr := s.repo.FailDiscoveryProfiling(failCtx, scan.ID, admission.Epoch)
	failCancel()
	if failErr != nil {
		return false, errors.Join(workErr, fmt.Errorf("mark discovery failed: %w", failErr))
	}
	return false, workErr
}

func (s *Scanner) requeueDiscovery(scanID string, epoch int64) error {
	requeueCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, err := s.repo.RequeueDiscoveryProfiling(requeueCtx, scanID, epoch)
	return err
}
