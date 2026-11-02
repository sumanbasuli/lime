package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
)

const publicLinkID = "11111111-1111-4111-8111-111111111111"
const publicLinkResultID = "22222222-2222-4222-8222-222222222222"
const publicLinkRaw = "https://example.test/path?token=QUERY_TOKEN_CANARY"

type publicLinkRepo struct {
	LinkRepository
	job     models.LinkCheck
	result  models.LinkResult
	source  models.LinkSource
	created string
	recheck string
}

func (r *publicLinkRepo) CreateLinkCheck(_ context.Context, target, _ string, _ int, _ []string) (*models.LinkCheck, error) {
	r.created = target
	return &r.job, nil
}
func (r *publicLinkRepo) GetLinkCheck(context.Context, string) (*models.LinkCheck, error) {
	return &r.job, nil
}
func (r *publicLinkRepo) GetScanLinkCheck(context.Context, string) (*models.LinkCheck, error) {
	return &r.job, nil
}
func (r *publicLinkRepo) ListLinkChecks(context.Context, int, int) ([]models.LinkCheck, int, error) {
	return []models.LinkCheck{r.job}, 1, nil
}
func (r *publicLinkRepo) GetLinkResults(context.Context, string, string, int, int) ([]models.LinkResult, int, error) {
	return []models.LinkResult{r.result}, 1, nil
}
func (r *publicLinkRepo) GetLinkSources(context.Context, string, string, int, int) ([]models.LinkSource, int, bool, error) {
	return []models.LinkSource{r.source}, 1, true, nil
}
func (r *publicLinkRepo) CreateLinkCheckFrom(_ context.Context, id string) (*models.LinkCheck, error) {
	r.recheck = id
	return &r.job, nil
}

func TestLinkRESTResponsesHideQueriesButKeepExecutionAndRecheckTargets(t *testing.T) {
	errText := "GET " + publicLinkRaw + ": timeout"
	final := "https://other.test/final?token=QUERY_TOKEN_CANARY"
	repo := &publicLinkRepo{
		job: models.LinkCheck{ID: publicLinkID, URL: publicLinkRaw, CheckType: "single", Status: "completed", Error: &errText},
		result: models.LinkResult{ID: publicLinkResultID, TargetURL: publicLinkRaw, FinalURL: &final, Error: &errText,
			Sources: []models.LinkSource{{PageURL: publicLinkRaw}}},
		source: models.LinkSource{PageURL: publicLinkRaw},
	}
	h := &Handler{repo: &publicResponseRepo{scan: models.Scan{ID: publicLinkID}}, links: repo}
	for _, tc := range []struct {
		name, method, path string
		status             int
		call               func(http.ResponseWriter, *http.Request)
	}{
		{"create", http.MethodPost, "/api/link-checks", 201, h.CreateLinkCheck},
		{"list", http.MethodGet, "/api/link-checks", 200, h.ListLinkChecks},
		{"get", http.MethodGet, "/api/link-checks/" + publicLinkID, 200, h.GetLinkCheck},
		{"scan companion", http.MethodGet, "/api/scans/" + publicLinkID + "/link-check", 200, h.GetScanLinkCheck},
		{"results", http.MethodGet, "/api/link-checks/" + publicLinkID + "/results", 200, h.LinkResults},
		{"sources", http.MethodGet, "/api/link-checks/" + publicLinkID + "/results/" + publicLinkResultID + "/sources", 200, h.LinkSources},
		{"recheck", http.MethodPost, "/api/link-checks/" + publicLinkID + "/recheck", 201, h.RecheckLinks},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body := ""
			if tc.name == "create" {
				body = `{"url":"` + publicLinkRaw + `","check_type":"single"}`
			}
			request := httptest.NewRequest(tc.method, tc.path, strings.NewReader(body))
			route := chi.NewRouteContext()
			route.URLParams.Add("id", publicLinkID)
			route.URLParams.Add("resultId", publicLinkResultID)
			request = request.WithContext(context.WithValue(request.Context(), chi.RouteCtxKey, route))
			response := httptest.NewRecorder()
			tc.call(response, request)
			if response.Code != tc.status || strings.Contains(response.Body.String(), "QUERY_TOKEN_CANARY") || strings.Contains(response.Body.String(), "?token=") {
				t.Fatalf("status=%d public response=%q", response.Code, response.Body.String())
			}
			if !strings.Contains(response.Body.String(), "https://example.test/path") {
				t.Fatalf("public path missing: %q", response.Body.String())
			}
		})
	}
	if repo.created != publicLinkRaw || repo.recheck != publicLinkID || repo.job.URL != publicLinkRaw ||
		repo.result.TargetURL != publicLinkRaw || *repo.result.FinalURL != final || repo.source.PageURL != publicLinkRaw {
		t.Fatal("execution, recheck, or stored link URLs were changed")
	}
}
