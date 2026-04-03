package scanner

import (
	"context"
	"errors"
	"log"
	"os"
	"path/filepath"
	"sync"

	"github.com/sumanbasuli/lime/shopkeeper/internal/juicer"
	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
	"github.com/sumanbasuli/lime/shopkeeper/internal/profiler"
	"github.com/sumanbasuli/lime/shopkeeper/internal/repository"
	"github.com/sumanbasuli/lime/shopkeeper/internal/sweetner"
	"github.com/sumanbasuli/lime/shopkeeper/internal/viewport"
)

// Scanner manages the async scan pipeline.
type Scanner struct {
	repo     *repository.Repository
	allocCtx context.Context
	mu       sync.Mutex
	cancels  map[string]context.CancelFunc
}

// New creates a new Scanner with the given repository and chromedp allocator context.
func New(repo *repository.Repository, allocCtx context.Context) *Scanner {
	return &Scanner{
		repo:     repo,
		allocCtx: allocCtx,
		cancels:  make(map[string]context.CancelFunc),
	}
}

// RequestPause interrupts a running scan so it can stop at the next safe point.
func (s *Scanner) RequestPause(scanID string) {
	s.mu.Lock()
	cancel := s.cancels[scanID]
	s.mu.Unlock()

	if cancel != nil {
		cancel()
	}
}

// RecoverInterruptedScans restarts any scan that was left in a non-terminal state.
// Since the previous process is gone, we reset partial DB/filesystem state and rerun it.
func (s *Scanner) RecoverInterruptedScans() error {
	ctx := context.Background()

	scans, err := s.repo.ListRecoverableScans(ctx)
	if err != nil {
		return err
	}

	if len(scans) == 0 {
		return nil
	}

	log.Printf("Scanner: recovering %d interrupted scan(s)", len(scans))

	for _, scan := range scans {
		if scan.PauseRequested {
			log.Printf("Scanner: finalizing interrupted pause for scan %s", scan.ID)
			if err := s.pauseScan(ctx, scan.ID); err != nil {
				log.Printf("Scanner: failed to finalize paused scan %s: %v", scan.ID, err)
			}
			continue
		}

		log.Printf("Scanner: resetting interrupted scan %s (status=%s)", scan.ID, scan.Status)

		if err := s.repo.ResetScan(ctx, scan.ID); err != nil {
			log.Printf("Scanner: failed to reset interrupted scan %s: %v", scan.ID, err)
			continue
		}

		if err := os.RemoveAll(filepath.Join(juicer.ScreenshotDir, scan.ID)); err != nil {
			log.Printf("Scanner: warning: failed to remove screenshots for recovered scan %s: %v", scan.ID, err)
		}

		go s.RunScan(scan)
	}

	return nil
}

// RunScan executes the full scan pipeline asynchronously.
// It is designed to be called as a goroutine from the handler.
// Fresh scans discover URLs first; resumed scans reuse persisted URL state and only
// continue work for pages that are still pending.
func (s *Scanner) RunScan(scan models.Scan) {
	persistCtx := context.Background()
	runCtx, cancel := context.WithCancel(context.Background())
	s.trackScan(scan.ID, cancel)
	defer cancel()
	defer s.untrackScan(scan.ID)

	currentScan, err := s.repo.GetScan(persistCtx, scan.ID)
	if err != nil {
		log.Printf("Scanner: failed to reload scan %s before start: %v", scan.ID, err)
		s.failScan(persistCtx, scan.ID)
		return
	}
	if currentScan == nil {
		log.Printf("Scanner: scan %s disappeared before it could start", scan.ID)
		return
	}
	if currentScan.PauseRequested || currentScan.Status == "paused" {
		if err := s.pauseScan(persistCtx, scan.ID); err != nil {
			log.Printf("Scanner: failed to pause scan %s before start: %v", scan.ID, err)
			s.failScan(persistCtx, scan.ID)
		}
		return
	}
	scan = *currentScan

	log.Printf(
		"Scanner: starting %s scan %s for %s at %s (%dx%d)",
		scan.ScanType,
		scan.ID,
		scan.SitemapURL,
		scan.ViewportPreset,
		scan.ViewportWidth,
		scan.ViewportHeight,
	)

	urlRecords, err := s.repo.GetScanURLs(persistCtx, scan.ID)
	if err != nil {
		log.Printf("Scanner: failed to load existing URLs for scan %s: %v", scan.ID, err)
		s.failScan(persistCtx, scan.ID)
		return
	}

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
			if err := s.repo.UpdateScanStatus(persistCtx, scan.ID, "profiling"); err != nil {
				log.Printf("Scanner: failed to update status to profiling for scan %s: %v", scan.ID, err)
				s.failScan(persistCtx, scan.ID)
				return
			}

			discoveredURLs, err := profiler.Discover(runCtx, scan.SitemapURL)
			if err != nil {
				if errors.Is(err, context.Canceled) && s.shouldPause(runCtx, persistCtx, scan.ID) {
					if err := s.pauseScan(persistCtx, scan.ID); err != nil {
						log.Printf("Scanner: failed to pause scan %s during profiling: %v", scan.ID, err)
						s.failScan(persistCtx, scan.ID)
					}
					return
				}

				log.Printf("Scanner: profiler failed for scan %s: %v", scan.ID, err)
				s.failScan(persistCtx, scan.ID)
				return
			}

			if s.shouldPause(runCtx, persistCtx, scan.ID) {
				if err := s.pauseScan(persistCtx, scan.ID); err != nil {
					log.Printf("Scanner: failed to pause scan %s after profiling: %v", scan.ID, err)
					s.failScan(persistCtx, scan.ID)
				}
				return
			}

			if len(discoveredURLs) == 0 {
				log.Printf("Scanner: no URLs discovered for scan %s", scan.ID)
				s.failScan(persistCtx, scan.ID)
				return
			}

			records, err := s.repo.BulkInsertURLs(persistCtx, scan.ID, discoveredURLs)
			if err != nil {
				log.Printf("Scanner: failed to insert URLs for scan %s: %v", scan.ID, err)
				s.failScan(persistCtx, scan.ID)
				return
			}
			urlRecords = records

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

		if err := s.repo.UpdateScanStatus(persistCtx, scan.ID, "completed"); err != nil {
			log.Printf("Scanner: failed to mark fully resumed scan %s as completed: %v", scan.ID, err)
			return
		}

		log.Printf("Scanner: scan %s completed with persisted results and no remaining pending pages", scan.ID)
		return
	}

	if s.shouldPause(runCtx, persistCtx, scan.ID) {
		if err := s.pauseScan(persistCtx, scan.ID); err != nil {
			log.Printf("Scanner: failed to pause scan %s before page scanning: %v", scan.ID, err)
			s.failScan(persistCtx, scan.ID)
		}
		return
	}

	if err := s.repo.UpdateScanStatus(persistCtx, scan.ID, "scanning"); err != nil {
		log.Printf("Scanner: failed to update status to scanning for scan %s: %v", scan.ID, err)
		s.failScan(persistCtx, scan.ID)
		return
	}

	onProgress := func(scannedCount int) {
		if err := s.repo.UpdateScanProgress(persistCtx, scan.ID, processedBeforeScan+scannedCount, len(urlRecords)); err != nil {
			log.Printf("Scanner: failed to update progress for scan %s: %v", scan.ID, err)
		}
	}

	rawResults, err := juicer.ScanPages(
		runCtx,
		s.allocCtx,
		pages,
		scan.ID,
		viewport.SettingsFromStored(scan.ViewportPreset, scan.ViewportWidth, scan.ViewportHeight),
		onProgress,
	)
	pauseRequested := s.shouldPause(runCtx, persistCtx, scan.ID)
	if err != nil && !(pauseRequested && errors.Is(err, context.Canceled)) {
		log.Printf("Scanner: juicer failed for scan %s: %v", scan.ID, err)
		s.failScan(persistCtx, scan.ID)
		return
	}

	// Update URL statuses based on results
	for _, result := range rawResults {
		status := "completed"
		if result.Error != "" {
			status = "failed"
		}
		if err := s.repo.UpdateURLStatus(persistCtx, result.URLID, status); err != nil {
			log.Printf("Scanner: failed to update URL status for %s: %v", result.URLID, err)
		}
	}

	successfulPages, failedPages := summarizePageResults(rawResults)
	totalSuccessfulPages := completedBeforeScan + successfulPages
	totalFailedPages := failedBeforeScan + failedPages

	if pauseRequested {
		if successfulPages > 0 {
			if err := sweetner.Process(persistCtx, s.repo, scan.ID, rawResults); err != nil {
				log.Printf("Scanner: failed to persist partial results for paused scan %s: %v", scan.ID, err)
				s.failScan(persistCtx, scan.ID)
				return
			}
		}

		if err := s.pauseScan(persistCtx, scan.ID); err != nil {
			log.Printf("Scanner: failed to finalize paused scan %s: %v", scan.ID, err)
			s.failScan(persistCtx, scan.ID)
			return
		}

		log.Printf("Scanner: scan %s paused after %d completed page(s) and %d failed page(s)", scan.ID, totalSuccessfulPages, totalFailedPages)
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

	if successfulPages > 0 {
		if err := s.repo.UpdateScanStatus(persistCtx, scan.ID, "processing"); err != nil {
			log.Printf("Scanner: failed to update status to processing for scan %s: %v", scan.ID, err)
			s.failScan(persistCtx, scan.ID)
			return
		}

		if err := sweetner.Process(persistCtx, s.repo, scan.ID, rawResults); err != nil {
			log.Printf("Scanner: sweetner failed for scan %s: %v", scan.ID, err)
			s.failScan(persistCtx, scan.ID)
			return
		}
	}

	if err := s.repo.UpdateScanStatus(persistCtx, scan.ID, "completed"); err != nil {
		log.Printf("Scanner: failed to update status to completed for scan %s: %v", scan.ID, err)
		return
	}

	log.Printf("Scanner: scan %s completed successfully", scan.ID)
}

func (s *Scanner) failScan(ctx context.Context, scanID string) {
	if err := s.repo.UpdateScanStatus(ctx, scanID, "failed"); err != nil {
		log.Printf("Scanner: failed to mark scan %s as failed: %v", scanID, err)
	}
}

func (s *Scanner) pauseScan(ctx context.Context, scanID string) error {
	return s.repo.FinalizePausedScan(ctx, scanID)
}

func (s *Scanner) shouldPause(runCtx, persistCtx context.Context, scanID string) bool {
	if runCtx.Err() == nil {
		return false
	}

	scan, err := s.repo.GetScan(persistCtx, scanID)
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
