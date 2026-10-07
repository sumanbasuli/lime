package router

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/rs/cors"
	"github.com/sumanbasuli/lime/shopkeeper/internal/handler"
	"github.com/sumanbasuli/lime/shopkeeper/internal/linkchecker"
	"github.com/sumanbasuli/lime/shopkeeper/internal/mcp"
	"github.com/sumanbasuli/lime/shopkeeper/internal/repository"
)

// Setup creates and configures the Chi router with all routes.
func Setup(
	repo *repository.Repository,
	scanner handler.ScanRunner,
	reporter handler.IssueReportGenerator,
	linkRunner ...*linkchecker.Runner,
) http.Handler {
	r := chi.NewRouter()
	h := handler.New(repo, scanner, reporter)
	var lr handler.LinkRunner
	if len(linkRunner) > 0 {
		lr = linkRunner[0]
	}
	h.WithLinkChecker(repo, lr)

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
		AllowedHeaders:   []string{"Content-Type", "Authorization", "MCP-Protocol-Version"},
		AllowCredentials: true,
	})
	r.Use(c.Handler)

	// Routes
	api := chi.NewRouter()
	api.Use(rejectCrossOriginWrites)
	func(r chi.Router) {
		r.Get("/health", h.HealthCheck)
		r.Get("/version", h.Version)
		r.Get("/stats", h.GetStats)
		r.Route("/link-checks", func(r chi.Router) {
			r.Post("/", h.CreateLinkCheck)
			r.Get("/", h.ListLinkChecks)
			r.Get("/stats", h.LinkCheckStats)
			r.Get("/{id}", h.GetLinkCheck)
			r.Delete("/{id}", h.DeleteLinkCheck)
			r.Get("/{id}/results", h.LinkResults)
			r.Get("/{id}/results/{resultId}/sources", h.LinkSources)
			r.Get("/{id}/export.csv", h.ExportLinksCSV)
			r.Post("/{id}/cancel", h.CancelLinkCheck)
			r.Post("/{id}/recheck", h.RecheckLinks)
		})

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
			r.Get("/{id}/link-check", h.GetScanLinkCheck)
			r.Get("/{id}/issues/report.pdf", h.DownloadIssueReport)
			r.Post("/{id}/issues/{issueId}/false-positive", h.MarkIssueFalsePositive)
			r.Delete("/{id}/issues/{issueId}/false-positive", h.UnmarkIssueFalsePositive)
		})

		r.Get("/screenshots/{scanId}/{filename}", h.ServeScreenshot)
	}(api)
	r.Mount("/api", api)
	// MCP invokes the same handlers in-process, keeping lifecycle and validation
	// rules identical to the dashboard without a loopback network dependency.
	r.Handle("/mcp", mcp.New(repo, api))

	return r
}
