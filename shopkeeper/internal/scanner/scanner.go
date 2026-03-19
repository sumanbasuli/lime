package scanner

import (
	"context"
	"log"
	"os"
	"path/filepath"

	"github.com/campuspress/lime/shopkeeper/internal/juicer"
	"github.com/campuspress/lime/shopkeeper/internal/models"
	"github.com/campuspress/lime/shopkeeper/internal/profiler"
	"github.com/campuspress/lime/shopkeeper/internal/repository"
	"github.com/campuspress/lime/shopkeeper/internal/sweetner"
)

// Scanner manages the async scan pipeline.
type Scanner struct {
	repo     *repository.Repository
	allocCtx context.Context
}

// New creates a new Scanner with the given repository and chromedp allocator context.
func New(repo *repository.Repository, allocCtx context.Context) *Scanner {
	return &Scanner{
		repo:     repo,
		allocCtx: allocCtx,
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
		log.Printf("Scanner: resetting interrupted scan %s (status=%s)", scan.ID, scan.Status)

		if err := s.repo.ResetScan(ctx, scan.ID); err != nil {
			log.Printf("Scanner: failed to reset interrupted scan %s: %v", scan.ID, err)
			continue
		}

		if err := os.RemoveAll(filepath.Join(juicer.ScreenshotDir, scan.ID)); err != nil {
			log.Printf("Scanner: warning: failed to remove screenshots for recovered scan %s: %v", scan.ID, err)
		}

		go s.RunScan(scan.ID, scan.SitemapURL, scan.ScanType)
	}

	return nil
}

// RunScan executes the full scan pipeline asynchronously.
// It is designed to be called as a goroutine from the handler.
// Pipeline: pending → [profiling] → scanning → processing → completed/failed
// For single URL scans, the profiling step is skipped.
func (s *Scanner) RunScan(scanID, targetURL, scanType string) {
	ctx := context.Background()
	log.Printf("Scanner: starting %s scan %s for %s", scanType, scanID, targetURL)

	var urlRecords []models.URL

	if scanType == "single" {
		// Single URL scan — skip profiler, directly insert the URL
		records, err := s.repo.BulkInsertURLs(ctx, scanID, []string{targetURL})
		if err != nil {
			log.Printf("Scanner: failed to insert URL for scan %s: %v", scanID, err)
			s.failScan(ctx, scanID)
			return
		}
		urlRecords = records

		// Update scan progress with total URLs (1)
		if err := s.repo.UpdateScanProgress(ctx, scanID, 0, 1); err != nil {
			log.Printf("Scanner: failed to update progress for scan %s: %v", scanID, err)
		}

		log.Printf("Scanner: single URL scan %s — scanning %s", scanID, targetURL)
	} else {
		// Sitemap scan — use profiler to discover URLs
		if err := s.repo.UpdateScanStatus(ctx, scanID, "profiling"); err != nil {
			log.Printf("Scanner: failed to update status to profiling for scan %s: %v", scanID, err)
			s.failScan(ctx, scanID)
			return
		}

		discoveredURLs, err := profiler.Discover(targetURL)
		if err != nil {
			log.Printf("Scanner: profiler failed for scan %s: %v", scanID, err)
			s.failScan(ctx, scanID)
			return
		}

		if len(discoveredURLs) == 0 {
			log.Printf("Scanner: no URLs discovered for scan %s", scanID)
			s.failScan(ctx, scanID)
			return
		}

		// Insert discovered URLs into the database
		records, err := s.repo.BulkInsertURLs(ctx, scanID, discoveredURLs)
		if err != nil {
			log.Printf("Scanner: failed to insert URLs for scan %s: %v", scanID, err)
			s.failScan(ctx, scanID)
			return
		}
		urlRecords = records

		// Update scan progress with total URLs
		if err := s.repo.UpdateScanProgress(ctx, scanID, 0, len(urlRecords)); err != nil {
			log.Printf("Scanner: failed to update progress for scan %s: %v", scanID, err)
		}

		log.Printf("Scanner: discovered %d URLs for scan %s", len(urlRecords), scanID)
	}

	// Step 2: Scanning — run axe-core on each URL
	if err := s.repo.UpdateScanStatus(ctx, scanID, "scanning"); err != nil {
		log.Printf("Scanner: failed to update status to scanning for scan %s: %v", scanID, err)
		s.failScan(ctx, scanID)
		return
	}

	// Convert URL records to PageInput for the juicer
	pages := make([]juicer.PageInput, len(urlRecords))
	for i, u := range urlRecords {
		pages[i] = juicer.PageInput{
			URLID: u.ID,
			URL:   u.URL,
		}
	}

	// Progress callback to update scanned_urls count
	onProgress := func(scannedCount int) {
		if err := s.repo.UpdateScanProgress(ctx, scanID, scannedCount, len(urlRecords)); err != nil {
			log.Printf("Scanner: failed to update progress for scan %s: %v", scanID, err)
		}
	}

	rawResults, err := juicer.ScanPages(ctx, s.allocCtx, pages, scanID, onProgress)
	if err != nil {
		log.Printf("Scanner: juicer failed for scan %s: %v", scanID, err)
		s.failScan(ctx, scanID)
		return
	}

	// Update URL statuses based on results
	for _, result := range rawResults {
		status := "completed"
		if result.Error != "" {
			status = "failed"
		}
		if err := s.repo.UpdateURLStatus(ctx, result.URLID, status); err != nil {
			log.Printf("Scanner: failed to update URL status for %s: %v", result.URLID, err)
		}
	}

	// Step 3: Processing — deduplicate and store results
	if err := s.repo.UpdateScanStatus(ctx, scanID, "processing"); err != nil {
		log.Printf("Scanner: failed to update status to processing for scan %s: %v", scanID, err)
		s.failScan(ctx, scanID)
		return
	}

	if err := sweetner.Process(ctx, s.repo, scanID, rawResults); err != nil {
		log.Printf("Scanner: sweetner failed for scan %s: %v", scanID, err)
		s.failScan(ctx, scanID)
		return
	}

	// Step 4: Complete
	if err := s.repo.UpdateScanStatus(ctx, scanID, "completed"); err != nil {
		log.Printf("Scanner: failed to update status to completed for scan %s: %v", scanID, err)
		return
	}

	log.Printf("Scanner: scan %s completed successfully", scanID)
}

func (s *Scanner) failScan(ctx context.Context, scanID string) {
	if err := s.repo.UpdateScanStatus(ctx, scanID, "failed"); err != nil {
		log.Printf("Scanner: failed to mark scan %s as failed: %v", scanID, err)
	}
}
