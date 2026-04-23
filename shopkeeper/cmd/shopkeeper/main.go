package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"time"

	"github.com/chromedp/chromedp"
	"github.com/sumanbasuli/lime/shopkeeper/internal/config"
	"github.com/sumanbasuli/lime/shopkeeper/internal/database"
	"github.com/sumanbasuli/lime/shopkeeper/internal/reporter"
	"github.com/sumanbasuli/lime/shopkeeper/internal/repository"
	"github.com/sumanbasuli/lime/shopkeeper/internal/router"
	"github.com/sumanbasuli/lime/shopkeeper/internal/scanner"
)

func main() {
	migrateOnly := flag.Bool("migrate", false, "apply database migrations and exit")
	flag.Parse()

	cfg := config.Load()

	// Run migrations
	if err := database.RunMigrations(cfg.DatabaseURL); err != nil {
		log.Fatalf("Failed to run migrations: %v", err)
	}
	log.Println("Database migrations applied successfully")

	if *migrateOnly {
		log.Println("Migration-only run completed")
		return
	}

	// Connect to database
	pool, err := database.Connect(context.Background(), cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("Failed to connect to database: %v", err)
	}
	defer pool.Close()

	// Create repository
	repo := repository.New(pool)

	// Setup chromedp allocator for headless browser
	allocCtx, allocCancel := createChromeAllocator()
	defer allocCancel()

	// Create scanner
	sc := scanner.New(repo, allocCtx)
	pdfReporter := reporter.New(allocCtx, cfg.ReportBaseURL)

	if err := sc.RecoverInterruptedScans(); err != nil {
		log.Printf("Scanner recovery failed: %v", err)
	}

	// Setup router with scan and report handlers.
	mux := router.Setup(repo, sc, pdfReporter)

	// Create server
	srv := &http.Server{
		Addr:         ":" + cfg.Port,
		Handler:      mux,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 10 * time.Minute,
		IdleTimeout:  60 * time.Second,
	}

	// Graceful shutdown
	go func() {
		sigChan := make(chan os.Signal, 1)
		signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
		<-sigChan

		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		log.Println("Shutting down server...")
		if err := srv.Shutdown(ctx); err != nil {
			log.Fatalf("Server shutdown failed: %v", err)
		}
	}()

	log.Printf("Shopkeeper starting on port %s", cfg.Port)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("Server failed: %v", err)
	}
	log.Println("Server stopped gracefully")
}

// createChromeAllocator sets up a chromedp exec allocator with headless Chrome options.
// It auto-detects the Chrome/Chromium binary location.
func createChromeAllocator() (context.Context, context.CancelFunc) {
	// Find Chrome/Chromium binary
	chromePath := findChromeBinary()

	opts := append(chromedp.DefaultExecAllocatorOptions[:],
		chromedp.NoSandbox,
		chromedp.DisableGPU,
		chromedp.Flag("disable-dev-shm-usage", true),
		chromedp.Flag("disable-extensions", true),
		chromedp.Flag("disable-background-networking", true),
		chromedp.Flag("disable-sync", true),
		chromedp.Flag("no-first-run", true),
	)

	if chromePath != "" {
		opts = append(opts, chromedp.ExecPath(chromePath))
	}

	return chromedp.NewExecAllocator(context.Background(), opts...)
}

// findChromeBinary searches for Chrome/Chromium in common locations.
func findChromeBinary() string {
	candidates := []string{
		"chromium-browser",
		"chromium",
		"google-chrome",
		"google-chrome-stable",
		"/usr/bin/chromium-browser",
		"/usr/bin/chromium",
		"/usr/bin/google-chrome",
	}

	for _, c := range candidates {
		if path, err := exec.LookPath(c); err == nil {
			log.Printf("Found Chrome/Chromium at: %s", path)
			return path
		}
	}

	log.Println("Chrome/Chromium binary not found in PATH, using chromedp default")
	return ""
}
