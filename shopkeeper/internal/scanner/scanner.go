package scanner

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/sumanbasuli/lime/shopkeeper/internal/juicer"
	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
	"github.com/sumanbasuli/lime/shopkeeper/internal/repository"
	"github.com/sumanbasuli/lime/shopkeeper/internal/rootdns"
	log "github.com/sumanbasuli/lime/shopkeeper/internal/safelog"
	"github.com/sumanbasuli/lime/shopkeeper/internal/screenshots"
	"github.com/sumanbasuli/lime/shopkeeper/internal/sweetner"
	"github.com/sumanbasuli/lime/shopkeeper/internal/viewport"
)

// Scanner manages the async scan pipeline.
type Scanner struct {
	repo      *repository.Repository
	allocCtx  context.Context
	mu        sync.Mutex
	cancels   map[string]context.CancelFunc
	axeBudget map[string]*juicer.AxeResultBudget
	scheduler *scanScheduler
}

// New creates a new Scanner with the given repository and chromedp allocator context.
func New(repo *repository.Repository, allocCtx context.Context) *Scanner {
	s := &Scanner{
		repo:      repo,
		allocCtx:  allocCtx,
		cancels:   make(map[string]context.CancelFunc),
		axeBudget: make(map[string]*juicer.AxeResultBudget),
	}
	s.scheduler = newScanScheduler(allocCtx, repo.ListPendingScans, s.runScan, repo.FinalizeQueuedScanPause)
	s.scheduler.recoverOrphans = s.recoverInactiveScans
	return s
}

// RequestPause interrupts a running scan so it can stop at the next safe point.
func (s *Scanner) RequestPause(scanID string) {
	s.mu.Lock()
	cancel := s.cancels[scanID]
	s.mu.Unlock()

	if cancel != nil {
		cancel()
		return
	}
	// A queued scan has no running context to cancel. Finalize its persisted
	// pause now rather than leaving it pending behind the active scans.
	pauseCtx, pauseCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer pauseCancel()
	if err := s.repo.FinalizeQueuedScanPause(pauseCtx, scanID); err != nil {
		log.Printf("Scanner: failed to pause queued scan %s: %v", scanID, err)
	}
	s.scheduler.notify()
}

// RecoverInterruptedScans retains discovery and page checkpoints, preserves
// queued retries/resumes, then starts the bounded scheduler.
func (s *Scanner) RecoverInterruptedScans() error {
	if err := recoverInterruptedScans(context.Background(), s.repo, func(scanID string) error {
		return os.RemoveAll(screenshots.ScanDir(scanID))
	}); err != nil {
		return err
	}
	s.scheduler.start()
	s.scheduler.notify()
	return nil
}

type scanRecoveryRepository interface {
	ListRecoverableScans(context.Context) ([]models.Scan, error)
	GetScanURLs(context.Context, string) ([]models.URL, error)
	RecoverDiscoveryAdmission(context.Context, string) (bool, error)
	RecoverLegacyProfilingURLs(context.Context, string) (bool, error)
	ResetScan(context.Context, string) error
	RecoverScanPages(context.Context, string) error
	FinalizePausedScan(context.Context, string) error
}

func recoverInterruptedScans(ctx context.Context, repo scanRecoveryRepository, removeScreenshots func(string) error) error {
	scans, err := repo.ListRecoverableScans(ctx)
	if err != nil {
		return err
	}

	if len(scans) > 0 {
		log.Printf("Scanner: recovering %d non-terminal scan(s)", len(scans))
	}

	for _, scan := range scans {
		if scan.Status == "scanning" || scan.Status == "processing" {
			urls, err := repo.GetScanURLs(ctx, scan.ID)
			if err != nil {
				return fmt.Errorf("load interrupted URLs for scan %s: %w", scan.ID, err)
			}
			if err := pruneUnfinishedScreenshots(scan.ID, urls); err != nil {
				return fmt.Errorf("prune interrupted screenshots for scan %s: %w", scan.ID, err)
			}
			if err := repo.RecoverScanPages(ctx, scan.ID); err != nil {
				return fmt.Errorf("recover saved pages for scan %s: %w", scan.ID, err)
			}
			continue
		}
		if scan.PauseRequested {
			if scan.Status == "profiling" {
				recovered, err := repo.RecoverDiscoveryAdmission(ctx, scan.ID)
				if err != nil {
					return fmt.Errorf("recover paused discovery for scan %s: %w", scan.ID, err)
				}
				if recovered {
					continue
				}
				recovered, err = repo.RecoverLegacyProfilingURLs(ctx, scan.ID)
				if err != nil {
					return fmt.Errorf("recover paused legacy profiling for scan %s: %w", scan.ID, err)
				}
				if recovered {
					continue
				}
			}
			log.Printf("Scanner: finalizing interrupted pause for scan %s", scan.ID)
			if err := repo.FinalizePausedScan(ctx, scan.ID); err != nil {
				return fmt.Errorf("finalize paused scan %s: %w", scan.ID, err)
			}
			continue
		}
		// Pending rows have not entered the running pipeline (or are a retry or
		// resume with persisted URL/results). They are durable queued work; do
		// not erase their state before the scheduler picks them up.
		if scan.Status == "pending" {
			continue
		}
		if scan.Status == "profiling" {
			recovered, err := repo.RecoverDiscoveryAdmission(ctx, scan.ID)
			if err != nil {
				return fmt.Errorf("recover discovery for scan %s: %w", scan.ID, err)
			}
			if recovered {
				continue
			}
			recovered, err = repo.RecoverLegacyProfilingURLs(ctx, scan.ID)
			if err != nil {
				return fmt.Errorf("recover legacy profiling URLs for scan %s: %w", scan.ID, err)
			}
			if recovered {
				continue
			}
		}

		log.Printf("Scanner: resetting interrupted scan %s (status=%s)", scan.ID, scan.Status)

		if err := repo.ResetScan(ctx, scan.ID); err != nil {
			return fmt.Errorf("reset interrupted scan %s: %w", scan.ID, err)
		}

		if err := removeScreenshots(scan.ID); err != nil {
			log.Printf("Scanner: warning: failed to remove screenshots for recovered scan %s: %v", scan.ID, err)
		}

	}

	return nil
}

type inactiveScanRepository interface {
	ListRecoverableScans(context.Context) ([]models.Scan, error)
	RecoverDiscoveryAdmission(context.Context, string) (bool, error)
	RecoverLegacyProfilingURLs(context.Context, string) (bool, error)
	GetScanURLs(context.Context, string) ([]models.URL, error)
	RecoverScanPages(context.Context, string) error
}

// A database outage can strand a status transition after its worker exits.
// Repair only scans absent from the scheduler's active set. Page recovery
// removes unfinished evidence, as it does at startup.
func recoverInactiveScans(ctx context.Context, repo inactiveScanRepository, isActive func(string) bool, prune func(string, []models.URL) error) error {
	scans, err := repo.ListRecoverableScans(ctx)
	if err != nil {
		return err
	}
	for _, scan := range scans {
		if isActive(scan.ID) {
			continue
		}
		switch scan.Status {
		case "profiling":
			recovered, err := repo.RecoverDiscoveryAdmission(ctx, scan.ID)
			if err != nil {
				return fmt.Errorf("recover inactive discovery %s: %w", scan.ID, err)
			}
			if !recovered {
				if _, err := repo.RecoverLegacyProfilingURLs(ctx, scan.ID); err != nil {
					return fmt.Errorf("recover inactive legacy profiling %s: %w", scan.ID, err)
				}
			}
		case "scanning", "processing":
			urls, err := repo.GetScanURLs(ctx, scan.ID)
			if err != nil {
				return fmt.Errorf("load inactive scan URLs %s: %w", scan.ID, err)
			}
			if err := prune(scan.ID, urls); err != nil {
				return fmt.Errorf("prune inactive scan screenshots %s: %w", scan.ID, err)
			}
			if err := repo.RecoverScanPages(ctx, scan.ID); err != nil {
				return fmt.Errorf("recover inactive scan pages %s: %w", scan.ID, err)
			}
		}
	}
	return nil
}

func (s *Scanner) recoverInactiveScans(ctx context.Context) {
	if err := recoverInactiveScans(ctx, s.repo, s.scheduler.isActive, pruneUnfinishedScreenshots); err != nil && ctx.Err() == nil {
		log.Printf("Scanner: failed to recover inactive scan: %v", err)
	}
}

// RunScan wakes the bounded scheduler after a scan has been persisted. The
// database remains the queue of record if several requests arrive at once.
func (s *Scanner) RunScan(_ models.Scan) {
	s.scheduler.start()
	s.scheduler.notify()
}

// runScan executes the full scan pipeline for an admitted scan.
// Fresh scans discover URLs first; resumed scans reuse persisted URL state and only
// continue work for pages that are still pending.
func (s *Scanner) runScan(scan models.Scan) {
	persistCtx := context.Background()
	runCtx, cancel := context.WithCancel(context.Background())
	s.trackScan(scan.ID, cancel)
	defer cancel()
	defer s.untrackScan(scan.ID)

	reloadCtx, reloadCancel := context.WithTimeout(context.Background(), 10*time.Second)
	currentScan, err := s.repo.GetScan(reloadCtx, scan.ID)
	reloadCancel()
	if err != nil {
		log.Printf("Scanner: failed to reload scan %s before start: %v", scan.ID, err)
		s.failScan(persistCtx, scan.ID)
		return
	}
	if currentScan == nil {
		log.Printf("Scanner: scan %s disappeared before it could start", scan.ID)
		s.dropAxeBudget(scan.ID)
		return
	}
	if currentScan.Status == "paused" {
		return
	}
	if currentScan.PauseRequested {
		if err := s.pauseScan(persistCtx, scan.ID); err != nil {
			log.Printf("Scanner: failed to pause scan %s before start: %v", scan.ID, err)
			s.failScan(persistCtx, scan.ID)
		}
		return
	}
	scan = *currentScan
	// Each network stage validates the exact root IPs it will dial. The
	// repository makes a public observation sticky across workers, restarts,
	// link-check companions, and later rescans before any connection is made.
	observeRootDNS := func(ctx context.Context, public, nonPublic bool) error {
		return s.repo.ObserveScanRootDNS(ctx, scan.ID, public, nonPublic)
	}
	guardPrivateDial := func(ctx context.Context) (func(), error) {
		return s.repo.GuardScanPrivateRootDial(ctx, scan.ID)
	}

	log.Printf(
		"Scanner: starting %s scan %s for %s at %s (%dx%d)",
		scan.ScanType,
		scan.ID,
		scan.SitemapURL,
		scan.ViewportPreset,
		scan.ViewportWidth,
		scan.ViewportHeight,
	)

	urlsCtx, urlsCancel := context.WithTimeout(context.Background(), 10*time.Second)
	urlRecords, err := s.repo.GetScanURLs(urlsCtx, scan.ID)
	urlsCancel()
	if err != nil {
		log.Printf("Scanner: failed to load existing URLs for scan %s: %v", scan.ID, err)
		s.failScan(persistCtx, scan.ID)
		return
	}
	if err := pruneUnfinishedScreenshotsWithRetry(scan.ID, urlRecords); err != nil {
		log.Printf("Scanner: failed to prune unfinished screenshots before scan %s: %v", scan.ID, err)
		s.failScan(persistCtx, scan.ID)
		return
	}

	discoveryCtx, discoveryCancel := context.WithTimeout(context.Background(), 10*time.Second)
	discovery, hasDiscovery, err := s.repo.GetDiscoverySnapshot(discoveryCtx, scan.ID)
	discoveryCancel()
	if err != nil {
		log.Printf("Scanner: failed to load discovery state for scan %s: %v", scan.ID, err)
		return
	}
	invalidPhase := hasDiscovery && discovery.Phase != "fetch" && discovery.Phase != "probe" && discovery.Phase != "complete"
	partialList := hasDiscovery && ((discovery.Phase == "complete") != (len(urlRecords) > 0))
	if invalidPhase || scan.ScanType == "single" && hasDiscovery || scan.ScanType != "single" && partialList {
		log.Printf("Scanner: contradictory discovery state for scan %s", scan.ID)
		return
	}
	pageAlreadyScanning := false
	if len(urlRecords) == 0 {
		if scan.ScanType == "single" {
			records, err := s.repo.BulkInsertURLs(persistCtx, scan.ID, []string{scan.SitemapURL})
			if err != nil {
				log.Printf("Scanner: failed to insert URL for scan %s: %v", scan.ID, err)
				s.failScan(persistCtx, scan.ID)
				return
			}
			urlRecords = records

			if s.shouldPause(runCtx, persistCtx, scan.ID) {
				if err := s.pauseScan(persistCtx, scan.ID); err != nil {
					log.Printf("Scanner: failed to pause single URL scan %s before page scan: %v", scan.ID, err)
					s.failScan(persistCtx, scan.ID)
				}
				return
			}

			log.Printf("Scanner: single URL scan %s — scanning %s", scan.ID, scan.SitemapURL)
		} else {
			if !hasDiscovery {
				createCtx, createCancel := context.WithTimeout(context.Background(), 10*time.Second)
				_, err := s.repo.LoadOrCreateDiscovery(createCtx, scan.ID, scan.SitemapURL)
				createCancel()
				if err != nil {
					log.Printf("Scanner: failed to create discovery state for scan %s: %v", scan.ID, err)
					return
				}
			}
			ready, err := s.runDiscoveryAdmission(runCtx, scan, observeRootDNS, guardPrivateDial)
			if err != nil {
				log.Printf("Scanner: discovery admission stopped for scan %s: %v", scan.ID, err)
				return
			}
			if !ready {
				return
			}
			pageAlreadyScanning = true
			publishedCtx, publishedCancel := context.WithTimeout(context.Background(), 10*time.Second)
			urlRecords, err = s.repo.GetScanURLs(publishedCtx, scan.ID)
			publishedCancel()
			if err != nil || len(urlRecords) == 0 {
				log.Printf("Scanner: failed to load published URLs for scan %s: %v", scan.ID, err)
				return
			}
			log.Printf("Scanner: discovered %d URLs for scan %s", len(urlRecords), scan.ID)
		}
	} else {
		log.Printf("Scanner: resuming scan %s with %d persisted URL(s)", scan.ID, len(urlRecords))
	}

	completedBeforeScan, failedBeforeScan := summarizePersistedURLStatuses(urlRecords)
	processedBeforeScan := completedBeforeScan + failedBeforeScan
	pages := buildPendingPages(urlRecords)

	if err := s.repo.UpdateScanProgress(persistCtx, scan.ID, processedBeforeScan, len(urlRecords)); err != nil {
		log.Printf("Scanner: failed to update progress for scan %s: %v", scan.ID, err)
	}

	if len(pages) == 0 {
		if completedBeforeScan == 0 {
			log.Printf("Scanner: scan %s has no pending pages and no successful completed pages", scan.ID)
			s.failScan(persistCtx, scan.ID)
			return
		}

		completeCtx, completeCancel := context.WithTimeout(context.Background(), 10*time.Second)
		status, err := s.repo.CompleteReadyScan(completeCtx, scan.ID)
		completeCancel()
		if err != nil {
			log.Printf("Scanner: failed to mark fully resumed scan %s as completed: %v", scan.ID, err)
			return
		}
		if status == "paused" {
			return
		}

		log.Printf("Scanner: scan %s completed with persisted results and no remaining pending pages", scan.ID)
		s.dropAxeBudget(scan.ID)
		return
	}

	if s.shouldPause(runCtx, persistCtx, scan.ID) {
		if err := s.pauseScan(persistCtx, scan.ID); err != nil {
			log.Printf("Scanner: failed to pause scan %s before page scanning: %v", scan.ID, err)
			s.failScan(persistCtx, scan.ID)
		}
		return
	}

	startCtx, startCancel := context.WithTimeout(context.Background(), 10*time.Second)
	if scan.ScanType != "single" && !pageAlreadyScanning {
		var status string
		status, err = s.repo.StartReadyPageScanning(startCtx, scan.ID)
		if err == nil && status == "paused" {
			startCancel()
			return
		}
	} else if !pageAlreadyScanning {
		err = s.repo.UpdateScanStatus(startCtx, scan.ID, "scanning")
	}
	startCancel()
	if err != nil {
		log.Printf("Scanner: failed to update status to scanning for scan %s: %v", scan.ID, err)
		if scan.ScanType == "single" {
			s.failScan(persistCtx, scan.ID)
		}
		return
	}

	onProgress := func(scannedCount int) {
		progressCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := s.repo.UpdateScanProgress(progressCtx, scan.ID, processedBeforeScan+scannedCount, len(urlRecords)); err != nil {
			log.Printf("Scanner: failed to update progress for scan %s: %v", scan.ID, err)
		}
	}

	// Each admission scans pages for at most ten minutes. Juicer then drains its
	// workers; up to five serialized checkpoints can extend the occupied slot.
	sliceCtx, stopSlice := context.WithTimeout(runCtx, 10*time.Minute)
	defer stopSlice()
	onResult := func(result juicer.RawResult) error {
		checkpointCtx, checkpointCancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer checkpointCancel()
		return checkpointPageResult(checkpointCtx, result,
			func(ctx context.Context, result juicer.RawResult) error {
				return sweetner.Process(ctx, s.repo, scan.ID, []juicer.RawResult{result})
			}, s.repo.UpdateURLStatus)
	}
	rawResults, err := juicer.ScanPagesWithResults(
		sliceCtx,
		s.allocCtx,
		pages,
		scan.ID,
		viewport.SettingsFromStored(scan.ViewportPreset, scan.ViewportWidth, scan.ViewportHeight),
		onProgress,
		onResult,
		s.scanAxeBudget(scan.ID),
		rootdns.Policy{Observe: observeRootDNS, GuardPrivateDial: guardPrivateDial},
	)
	pauseRequested := s.shouldPause(runCtx, persistCtx, scan.ID)
	sliceExpired := isScanSliceDeadline(err, sliceCtx, runCtx)
	if err != nil && (errors.Is(err, juicer.ErrResultCheckpoint) || (!sliceExpired && !(pauseRequested && errors.Is(err, context.Canceled)))) {
		log.Printf("Scanner: juicer failed for scan %s: %v", scan.ID, err)
		if errors.Is(err, juicer.ErrResultCheckpoint) {
			if cleanupErr := s.failCheckpointedScan(scan.ID); cleanupErr != nil {
				log.Printf("Scanner: failed to clean incomplete page evidence for scan %s; leaving scan recoverable: %v", scan.ID, cleanupErr)
			} else {
				s.dropAxeBudget(scan.ID)
			}
		} else {
			s.failScan(persistCtx, scan.ID)
		}
		return
	}
	checkpointCtx, checkpointCancel := context.WithTimeout(context.Background(), 10*time.Second)
	checkpointedURLs, err := s.repo.GetScanURLs(checkpointCtx, scan.ID)
	checkpointCancel()
	if err != nil {
		log.Printf("Scanner: failed to reload saved URLs before screenshot cleanup for scan %s: %v", scan.ID, err)
		s.failScan(persistCtx, scan.ID)
		return
	}
	if err := pruneUnfinishedScreenshotsWithRetry(scan.ID, checkpointedURLs); err != nil {
		log.Printf("Scanner: failed to prune unfinished screenshots before releasing scan %s: %v", scan.ID, err)
		s.failScan(persistCtx, scan.ID)
		return
	}

	totalSuccessfulPages, totalFailedPages := summarizePersistedURLStatuses(checkpointedURLs)

	// Each URL became terminal only after its evidence was saved by onResult.
	progressCtx, progressCancel := context.WithTimeout(context.Background(), 10*time.Second)
	err = s.repo.UpdateScanProgress(progressCtx, scan.ID, totalSuccessfulPages+totalFailedPages, len(urlRecords))
	progressCancel()
	if err != nil {
		log.Printf("Scanner: failed to checkpoint progress for scan %s: %v", scan.ID, err)
		s.failScan(persistCtx, scan.ID)
		return
	}

	if pauseRequested {
		if err := s.pauseScan(persistCtx, scan.ID); err != nil {
			log.Printf("Scanner: failed to finalize paused scan %s: %v", scan.ID, err)
			s.failScan(persistCtx, scan.ID)
			return
		}

		log.Printf("Scanner: scan %s paused after %d completed page(s) and %d failed page(s)", scan.ID, totalSuccessfulPages, totalFailedPages)
		return
	}
	if sliceExpired && len(rawResults) < len(pages) {
		requeueCtx, requeueCancel := context.WithTimeout(context.Background(), 10*time.Second)
		err := s.repo.RequeueScanSlice(requeueCtx, scan.ID)
		requeueCancel()
		if err != nil {
			log.Printf("Scanner: failed to requeue scan %s after slice: %v", scan.ID, err)
			s.failScan(persistCtx, scan.ID)
		}
		return
	}

	if totalFailedPages > 0 {
		log.Printf("Scanner: scan %s finished scanning with %d failed page(s) out of %d", scan.ID, totalFailedPages, len(urlRecords))
	}
	if totalSuccessfulPages == 0 {
		log.Printf("Scanner: scan %s failed because no pages scanned successfully", scan.ID)
		s.failScan(persistCtx, scan.ID)
		return
	}

	completeCtx, completeCancel := context.WithTimeout(context.Background(), 10*time.Second)
	status, err := s.repo.CompleteReadyScan(completeCtx, scan.ID)
	completeCancel()
	if err != nil {
		log.Printf("Scanner: failed to update status to completed for scan %s: %v", scan.ID, err)
		return
	}
	if status == "paused" {
		return
	}

	log.Printf("Scanner: scan %s completed successfully", scan.ID)
	s.dropAxeBudget(scan.ID)
}

func (s *Scanner) failCheckpointedScan(scanID string) error {
	var err error
	for attempt := 0; attempt < 3; attempt++ {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		var urls []models.URL
		urls, err = s.repo.GetScanURLs(cleanupCtx, scanID)
		if err == nil {
			err = pruneUnfinishedScreenshots(scanID, urls)
		}
		if err == nil {
			err = s.repo.FailScanWithPageCleanup(cleanupCtx, scanID)
		}
		cancel()
		if err == nil {
			return nil
		}
		if attempt < 2 {
			time.Sleep(time.Second)
		}
	}
	return err
}

func pruneUnfinishedScreenshots(scanID string, urls []models.URL) error {
	completedIDs := make([]string, 0, len(urls))
	for _, u := range urls {
		if u.Status == "completed" {
			completedIDs = append(completedIDs, u.ID)
		}
	}
	return screenshots.PruneUnfinished(scanID, completedIDs)
}

func pruneUnfinishedScreenshotsWithRetry(scanID string, urls []models.URL) error {
	var err error
	for attempt := 0; attempt < 3; attempt++ {
		err = pruneUnfinishedScreenshots(scanID, urls)
		if err == nil {
			return nil
		}
		if attempt < 2 {
			time.Sleep(time.Second)
		}
	}
	return err
}

func (s *Scanner) failScan(ctx context.Context, scanID string) {
	statusCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := s.repo.UpdateScanStatus(statusCtx, scanID, "failed"); err != nil {
		log.Printf("Scanner: failed to mark scan %s as failed: %v", scanID, err)
		return
	}
	s.dropAxeBudget(scanID)
}

func (s *Scanner) scanAxeBudget(scanID string) *juicer.AxeResultBudget {
	s.mu.Lock()
	defer s.mu.Unlock()
	budget := s.axeBudget[scanID]
	if budget == nil {
		budget = &juicer.AxeResultBudget{}
		s.axeBudget[scanID] = budget
	}
	return budget
}

func (s *Scanner) dropAxeBudget(scanID string) {
	s.mu.Lock()
	delete(s.axeBudget, scanID)
	s.mu.Unlock()
}

func (s *Scanner) pauseScan(ctx context.Context, scanID string) error {
	pauseCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return s.repo.FinalizePausedScan(pauseCtx, scanID)
}

func (s *Scanner) shouldPause(runCtx, persistCtx context.Context, scanID string) bool {
	if runCtx.Err() == nil {
		return false
	}

	readCtx, cancel := context.WithTimeout(persistCtx, 10*time.Second)
	defer cancel()
	scan, err := s.repo.GetScan(readCtx, scanID)
	if err != nil {
		log.Printf("Scanner: failed to reload scan %s while checking pause state: %v", scanID, err)
		return false
	}

	return scan != nil && (scan.PauseRequested || scan.Status == "paused")
}

func (s *Scanner) trackScan(scanID string, cancel context.CancelFunc) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cancels[scanID] = cancel
}

func (s *Scanner) untrackScan(scanID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.cancels, scanID)
}

func summarizePageResults(results []juicer.RawResult) (successfulPages, failedPages int) {
	for _, result := range results {
		if result.Error != "" {
			failedPages++
			continue
		}
		successfulPages++
	}

	return successfulPages, failedPages
}

func persistURLStatuses(ctx context.Context, results []juicer.RawResult, update func(context.Context, string, string) error) error {
	for _, result := range results {
		status := "completed"
		if result.Error != "" {
			status = "failed"
		}
		if err := update(ctx, result.URLID, status); err != nil {
			return fmt.Errorf("update URL %s status to %s: %w", result.URLID, status, err)
		}
	}
	return nil
}

func checkpointPageResult(ctx context.Context, result juicer.RawResult, persistEvidence func(context.Context, juicer.RawResult) error, updateStatus func(context.Context, string, string) error) error {
	if result.Error == "" {
		if err := persistEvidence(ctx, result); err != nil {
			return fmt.Errorf("persist page evidence for URL %s: %w", result.URLID, err)
		}
	}
	return persistURLStatuses(ctx, []juicer.RawResult{result}, updateStatus)
}

func isScanSliceDeadline(err error, sliceCtx, runCtx context.Context) bool {
	return errors.Is(err, context.DeadlineExceeded) &&
		sliceCtx.Err() == context.DeadlineExceeded && runCtx.Err() == nil &&
		!errors.Is(err, juicer.ErrResultCheckpoint)
}

func summarizePersistedURLStatuses(urls []models.URL) (completedPages, failedPages int) {
	for _, u := range urls {
		switch u.Status {
		case "completed":
			completedPages++
		case "failed":
			failedPages++
		}
	}

	return completedPages, failedPages
}

func buildPendingPages(urls []models.URL) []juicer.PageInput {
	pages := make([]juicer.PageInput, 0, len(urls))
	for _, u := range urls {
		if u.Status != "pending" && u.Status != "scanning" {
			continue
		}

		pages = append(pages, juicer.PageInput{
			URLID: u.ID,
			URL:   u.URL,
		})
	}

	return pages
}
