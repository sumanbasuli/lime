package router

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/rs/cors"
	"github.com/sumanbasuli/lime/shopkeeper/internal/handler"
	"github.com/sumanbasuli/lime/shopkeeper/internal/repository"
)

// Setup creates and configures the Chi router with all routes.
func Setup(
	repo *repository.Repository,
	scanner handler.ScanRunner,
	reporter handler.IssueReportGenerator,
) http.Handler {
	r := chi.NewRouter()
	h := handler.New(repo, scanner, reporter)

	// Middleware
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(middleware.RequestID)

	// CORS — allow any localhost port for development
	c := cors.New(cors.Options{
		AllowOriginFunc: func(origin string) bool {
			// Allow any localhost origin (any port) for development
			return origin == "http://localhost:3000" ||
				len(origin) > 17 && origin[:17] == "http://localhost:"
		},
		AllowedMethods:   []string{"GET", "POST", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Content-Type", "Authorization"},
		AllowCredentials: true,
	})
	r.Use(c.Handler)

	// Routes
	r.Route("/api", func(r chi.Router) {
		r.Get("/health", h.HealthCheck)
		r.Get("/stats", h.GetStats)

		r.Route("/scans", func(r chi.Router) {
			r.Post("/", h.CreateScan)
			r.Get("/", h.ListScans)
			r.Post("/{id}/pause", h.PauseScan)
			r.Post("/{id}/resume", h.ResumeScan)
			r.Post("/{id}/rescan", h.RescanScan)
			r.Post("/{id}/retry-failed", h.RetryFailedPages)
			r.Get("/{id}", h.GetScan)
			r.Delete("/{id}", h.DeleteScan)
			r.Get("/{id}/issues", h.GetScanIssues)
			r.Get("/{id}/issues/report.pdf", h.DownloadIssueReport)
			r.Post("/{id}/issues/{issueId}/false-positive", h.MarkIssueFalsePositive)
			r.Delete("/{id}/issues/{issueId}/false-positive", h.UnmarkIssueFalsePositive)
		})

		r.Get("/screenshots/{scanId}/{filename}", h.ServeScreenshot)
	})

	return r
}
