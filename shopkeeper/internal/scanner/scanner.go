package scanner

import (
	"context"
	"log"
	"os"
	"path/filepath"

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

		go s.RunScan(scan)
	}

	return nil
}

// RunScan executes the full scan pipeline asynchronously.
// It is designed to be called as a goroutine from the handler.
// Pipeline: pending → [profiling] → scanning → processing → completed/failed
// For single URL scans, the profiling step is skipped.
func (s *Scanner) RunScan(scan models.Scan) {
	ctx := context.Background()
	log.Printf(
		"Scanner: starting %s scan %s for %s at %s (%dx%d)",
		scan.ScanType,
		scan.ID,
		scan.SitemapURL,
		scan.ViewportPreset,
		scan.ViewportWidth,
		scan.ViewportHeight,
	)

	var urlRecords []models.URL

	if scan.ScanType == "single" {
		// Single URL scan — skip profiler, directly insert the URL
		records, err := s.repo.BulkInsertURLs(ctx, scan.ID, []string{scan.SitemapURL})
		if err != nil {
			log.Printf("Scanner: failed to insert URL for scan %s: %v", scan.ID, err)
			s.failScan(ctx, scan.ID)
			return
		}
		urlRecords = records

		// Update scan progress with total URLs (1)
		if err := s.repo.UpdateScanProgress(ctx, scan.ID, 0, 1); err != nil {
			log.Printf("Scanner: failed to update progress for scan %s: %v", scan.ID, err)
		}

		log.Printf("Scanner: single URL scan %s — scanning %s", scan.ID, scan.SitemapURL)
	} else {
		// Sitemap scan — use profiler to discover URLs
		if err := s.repo.UpdateScanStatus(ctx, scan.ID, "profiling"); err != nil {
			log.Printf("Scanner: failed to update status to profiling for scan %s: %v", scan.ID, err)
			s.failScan(ctx, scan.ID)
			return
		}

		discoveredURLs, err := profiler.Discover(scan.SitemapURL)
		if err != nil {
			log.Printf("Scanner: profiler failed for scan %s: %v", scan.ID, err)
			s.failScan(ctx, scan.ID)
			return
		}

		if len(discoveredURLs) == 0 {
			log.Printf("Scanner: no URLs discovered for scan %s", scan.ID)
			s.failScan(ctx, scan.ID)
			return
		}

		// Insert discovered URLs into the database
		records, err := s.repo.BulkInsertURLs(ctx, scan.ID, discoveredURLs)
		if err != nil {
			log.Printf("Scanner: failed to insert URLs for scan %s: %v", scan.ID, err)
			s.failScan(ctx, scan.ID)
			return
		}
		urlRecords = records

		// Update scan progress with total URLs
		if err := s.repo.UpdateScanProgress(ctx, scan.ID, 0, len(urlRecords)); err != nil {
			log.Printf("Scanner: failed to update progress for scan %s: %v", scan.ID, err)
		}

		log.Printf("Scanner: discovered %d URLs for scan %s", len(urlRecords), scan.ID)
	}

	// Step 2: Scanning — run axe-core on each URL
	if err := s.repo.UpdateScanStatus(ctx, scan.ID, "scanning"); err != nil {
		log.Printf("Scanner: failed to update status to scanning for scan %s: %v", scan.ID, err)
		s.failScan(ctx, scan.ID)
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
		if err := s.repo.UpdateScanProgress(ctx, scan.ID, scannedCount, len(urlRecords)); err != nil {
			log.Printf("Scanner: failed to update progress for scan %s: %v", scan.ID, err)
		}
	}

	rawResults, err := juicer.ScanPages(
		ctx,
		s.allocCtx,
		pages,
		scan.ID,
		viewport.SettingsFromStored(scan.ViewportPreset, scan.ViewportWidth, scan.ViewportHeight),
		onProgress,
	)
	if err != nil {
		log.Printf("Scanner: juicer failed for scan %s: %v", scan.ID, err)
		s.failScan(ctx, scan.ID)
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

	successfulPages, failedPages := summarizePageResults(rawResults)
	if failedPages > 0 {
		log.Printf("Scanner: scan %s finished scanning with %d failed page(s) out of %d", scan.ID, failedPages, len(rawResults))
	}
	if successfulPages == 0 {
		log.Printf("Scanner: scan %s failed because no pages scanned successfully", scan.ID)
		s.failScan(ctx, scan.ID)
		return
	}

	// Step 3: Processing — deduplicate and store results
	if err := s.repo.UpdateScanStatus(ctx, scan.ID, "processing"); err != nil {
		log.Printf("Scanner: failed to update status to processing for scan %s: %v", scan.ID, err)
		s.failScan(ctx, scan.ID)
		return
	}

	if err := sweetner.Process(ctx, s.repo, scan.ID, rawResults); err != nil {
		log.Printf("Scanner: sweetner failed for scan %s: %v", scan.ID, err)
		s.failScan(ctx, scan.ID)
		return
	}

	// Step 4: Complete
	if err := s.repo.UpdateScanStatus(ctx, scan.ID, "completed"); err != nil {
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
