package profiler

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
	"github.com/sumanbasuli/lime/shopkeeper/internal/repository"
)

type checkpointTestStore struct {
	snapshot     repository.DiscoverySnapshot
	task         *repository.DiscoverySitemapTask
	candidates   []repository.DiscoveryCandidate
	probe        repository.DiscoveryProbeOutcome
	requests     int
	bytes        int64
	requestLimit int
	chargeErr    error
	commits      int
	commitFn     func(context.Context) error
	failures     int
	published    bool
}

func (s *checkpointTestStore) LoadOrCreateDiscovery(context.Context, string, string) (repository.DiscoverySnapshot, error) {
	return s.snapshot, nil
}
func (s *checkpointTestStore) ReserveDiscoveryRequest(context.Context, string, int64) error {
	if s.requestLimit > 0 && s.requests >= s.requestLimit {
		return repository.ErrDiscoveryBudget
	}
	s.requests++
	return nil
}
func (s *checkpointTestStore) ChargeDiscoveryXMLBytes(_ context.Context, _ string, _ int64, n int64) error {
	if s.chargeErr != nil {
		return s.chargeErr
	}
	s.bytes += n
	return nil
}
func (s *checkpointTestStore) NextDiscoverySitemap(context.Context, string, int64) (*repository.DiscoverySitemapTask, error) {
	return s.task, nil
}
func (s *checkpointTestStore) CommitDiscoverySitemap(ctx context.Context, _ string, _ int64, _ repository.DiscoverySitemapTask, _ repository.DiscoveryDocument) error {
	if s.commitFn != nil {
		if err := s.commitFn(ctx); err != nil {
			return err
		}
	}
	s.commits++
	s.task = nil
	return nil
}

func TestCheckpointCommitsParsedDocumentAfterSliceCancellation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `<urlset><url><loc>https://example.com/page</loc></url></urlset>`)
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	store := &checkpointTestStore{
		snapshot: repository.DiscoverySnapshot{Phase: "fetch", Epoch: 7},
		task:     &repository.DiscoverySitemapTask{CanonicalURL: canonicalizeURLString(server.URL + "/index.xml"), FetchURL: server.URL + "/index.xml"},
		commitFn: func(commitCtx context.Context) error {
			cancel()
			return commitCtx.Err()
		},
	}
	result, err := DiscoverCheckpointed(ctx, "scan", server.URL+"/index.xml", 7, store, nil)
	if err != nil || result != DiscoveryYielded || store.commits != 1 || store.published {
		t.Fatalf("result=%v err=%v commits=%d published=%t", result, err, store.commits, store.published)
	}
}

func TestCheckpointCommitFailureAfterSliceCancellationIsFatal(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `<urlset><url><loc>https://example.com/page</loc></url></urlset>`)
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	commitErr := errors.New("database unavailable")
	store := &checkpointTestStore{
		snapshot: repository.DiscoverySnapshot{Phase: "fetch", Epoch: 7},
		task:     &repository.DiscoverySitemapTask{CanonicalURL: canonicalizeURLString(server.URL + "/index.xml"), FetchURL: server.URL + "/index.xml"},
		commitFn: func(commitCtx context.Context) error {
			cancel()
			if commitCtx.Err() != nil {
				t.Fatal("commit context followed canceled slice")
			}
			return commitErr
		},
	}
	_, err := DiscoverCheckpointed(ctx, "scan", server.URL+"/index.xml", 7, store, nil)
	if !errors.Is(err, commitErr) || !IsDiscoveryPersistenceError(err) || store.published {
		t.Fatalf("err=%v published=%t", err, store.published)
	}
}
func (s *checkpointTestStore) FailDiscoverySitemap(context.Context, string, int64, repository.DiscoverySitemapTask, string) error {
	s.failures++
	s.task = nil
	return nil
}
func (s *checkpointTestStore) BeginDiscoveryProbes(context.Context, string, int64) (bool, error) {
	return true, nil
}
func (s *checkpointTestStore) PendingDiscoveryCandidates(context.Context, string, int64, int) ([]repository.DiscoveryCandidate, error) {
	return s.candidates, nil
}
func (s *checkpointTestStore) SaveDiscoveryProbe(_ context.Context, _ string, _ int64, o repository.DiscoveryProbeOutcome) error {
	if (o.Outcome == "eligible") != (o.FinalURL != "") {
		return repository.ErrDiscoveryInvariant
	}
	s.probe = o
	s.candidates = nil
	return nil
}
func (s *checkpointTestStore) PublishDiscoveryComplete(context.Context, string, int64) ([]models.URL, error) {
	s.published = true
	return nil, nil
}

func TestCheckpointParserKeepsOriginalChildIndexes(t *testing.T) {
	body := `<sitemapindex><sitemap><loc> </loc></sitemap><sitemap><loc>https://example.com/a</loc></sitemap><sitemap><loc>https://example.com/a</loc></sitemap><sitemap><loc>https://example.com/b</loc></sitemap></sitemapindex>`
	doc, err := decodeCheckpointSitemap(strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if !doc.IsIndex || len(doc.Children) != 2 || doc.Children[0].EntryIndex != 1 || doc.Children[1].EntryIndex != 3 {
		t.Fatalf("unexpected checkpoint children: %+v", doc.Children)
	}
}

type countingCheckpointReader struct {
	source io.Reader
	read   int
}

func (r *countingCheckpointReader) Read(p []byte) (int, error) {
	n, err := r.source.Read(p)
	r.read += n
	return n, err
}

func TestCheckpointParserBoundsDistinctPageCandidates(t *testing.T) {
	var body strings.Builder
	body.WriteString("<urlset>")
	for i := range maxDiscoveredURLs {
		fmt.Fprintf(&body, "<url><loc>https://example.com/page/%d</loc></url>", i)
	}
	// Repeats do not consume the distinct-page budget.
	body.WriteString("<url><loc>https://example.com/page/0</loc></url>")
	body.WriteString("</urlset>")
	doc, err := decodeCheckpointSitemap(strings.NewReader(body.String()))
	if err != nil || len(doc.Candidates) != maxDiscoveredURLs {
		t.Fatalf("exact boundary: candidates=%d err=%v", len(doc.Candidates), err)
	}

	// The next distinct URL must stop parsing before the remaining XML is read.
	body.Reset()
	body.WriteString("<urlset>")
	for i := range maxDiscoveredURLs {
		fmt.Fprintf(&body, "<url><loc>https://example.com/page/%d</loc></url>", i)
	}
	body.WriteString("<url><loc>https://example.com/page/0</loc></url>")
	body.WriteString("<url><loc>https://example.com/page/overflow</loc></url>")
	const trailingBytes = 1 << 20
	body.WriteString(strings.Repeat(" ", trailingBytes))
	body.WriteString("</urlset>")
	reader := &countingCheckpointReader{source: strings.NewReader(body.String())}
	_, err = decodeCheckpointSitemap(reader)
	if !errors.Is(err, errDiscoveryBudget) {
		t.Fatalf("10,001st distinct URL: err=%v", err)
	}
	// xml.Decoder may read ahead into the trailing whitespace by a few KiB.
	if reader.read >= body.Len()-trailingBytes+(64<<10) {
		t.Fatalf("parser read trailing XML after budget was exceeded: read=%d total=%d", reader.read, body.Len())
	}
}

func TestCheckpointProbeChargesRedirectAndPublishes(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/a" {
			http.Redirect(w, r, "/final", http.StatusFound)
			return
		}
		fmt.Fprint(w, "ok")
	}))
	defer server.Close()
	store := &checkpointTestStore{
		snapshot:   repository.DiscoverySnapshot{Phase: "probe", Epoch: 7},
		candidates: []repository.DiscoveryCandidate{{RawURL: server.URL + "/a", Ordinal: 3}},
	}
	result, err := DiscoverCheckpointed(context.Background(), "scan", server.URL+"/index.xml", 7, store, nil)
	if err != nil || result != DiscoveryComplete {
		t.Fatalf("result=%v err=%v", result, err)
	}
	if store.requests != 2 || !store.published || store.probe.Outcome != "eligible" || store.probe.Ordinal != 3 || store.probe.FinalURL != server.URL+"/final" || !store.probe.Redirected {
		t.Fatalf("requests=%d published=%t probe=%+v", store.requests, store.published, store.probe)
	}
}

func TestCheckpointExternalRedirectDoesNotReprobeAfterResume(t *testing.T) {
	external := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, "external")
	}))
	defer external.Close()
	rootHits := 0
	root := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rootHits++
		http.Redirect(w, r, external.URL+"/final", http.StatusFound)
	}))
	defer root.Close()
	d, err := newDiscovery(root.URL + "/index.xml")
	if err != nil {
		t.Fatal(err)
	}
	defer d.client.CloseIdleConnections()
	// Force a successful cross-authority resolution to exercise the storage
	// boundary; production's redirect policy normally rejects this earlier.
	d.client.CheckRedirect = func(req *http.Request, _ []*http.Request) error {
		return d.reserveRequest(req.Context())
	}
	store := &checkpointTestStore{
		candidates: []repository.DiscoveryCandidate{{RawURL: root.URL + "/page", Ordinal: 3}},
	}
	d.requestHook = func(context.Context) error {
		store.requests++
		return nil
	}
	if err := d.probeCheckpointCandidates(context.Background(), "scan", 7, store); err != nil {
		t.Fatal(err)
	}
	if store.probe.Outcome != "external" || store.probe.FinalURL != "" || !store.probe.Redirected || rootHits != 1 {
		t.Fatalf("probe=%+v rootHits=%d", store.probe, rootHits)
	}
	if err := d.probeCheckpointCandidates(context.Background(), "scan", 8, store); err != nil {
		t.Fatal(err)
	}
	if rootHits != 1 || store.requests != 2 {
		t.Fatalf("saved external candidate was reprobed: rootHits=%d requests=%d", rootHits, store.requests)
	}
}

func TestCheckpointRequestBudgetStopsRedirectBeforeSecondGET(t *testing.T) {
	requestsSeen := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestsSeen++
		http.Redirect(w, r, "/final", http.StatusFound)
	}))
	defer server.Close()
	store := &checkpointTestStore{
		snapshot:     repository.DiscoverySnapshot{Phase: "probe", Epoch: 7},
		candidates:   []repository.DiscoveryCandidate{{RawURL: server.URL + "/a", Ordinal: 0}},
		requestLimit: 1,
	}
	_, err := DiscoverCheckpointed(context.Background(), "scan", server.URL+"/index.xml", 7, store, nil)
	if !errors.Is(err, errDiscoveryBudget) || requestsSeen != 1 || store.published {
		t.Fatalf("err=%v requestsSeen=%d published=%t", err, requestsSeen, store.published)
	}
}

func TestCheckpointChargeFailureStopsBeforeRetryOrCommit(t *testing.T) {
	requestsSeen := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestsSeen++
		fmt.Fprint(w, `<urlset><url><loc>https://example.com/page</loc></url></urlset>`)
	}))
	defer server.Close()
	chargeErr := errors.New("database unavailable")
	store := &checkpointTestStore{
		snapshot:  repository.DiscoverySnapshot{Phase: "fetch", Epoch: 7},
		task:      &repository.DiscoverySitemapTask{CanonicalURL: canonicalizeURLString(server.URL + "/index.xml"), FetchURL: server.URL + "/index.xml"},
		chargeErr: chargeErr,
	}
	_, err := DiscoverCheckpointed(context.Background(), "scan", server.URL+"/index.xml", 7, store, nil)
	if !errors.Is(err, chargeErr) || requestsSeen != 1 || store.commits != 0 || store.failures != 0 || store.published {
		t.Fatalf("err=%v requestsSeen=%d commits=%d failures=%d published=%t", err, requestsSeen, store.commits, store.failures, store.published)
	}
}

func TestCheckpointSitemapFallbackChargesBothRequestsAndReadBytes(t *testing.T) {
	requestsSeen := 0
	body := `<urlset><url><loc>https://example.com/page</loc></url></urlset>`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestsSeen++
		if strings.Contains(r.UserAgent(), "LIME Accessibility Scanner") {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		fmt.Fprint(w, body)
	}))
	defer server.Close()
	store := &checkpointTestStore{
		snapshot: repository.DiscoverySnapshot{Phase: "fetch", Epoch: 7},
		task:     &repository.DiscoverySitemapTask{CanonicalURL: canonicalizeURLString(server.URL + "/index.xml"), FetchURL: server.URL + "/index.xml"},
	}
	result, err := DiscoverCheckpointed(context.Background(), "scan", server.URL+"/index.xml", 7, store, nil)
	if err != nil || result != DiscoveryComplete || requestsSeen != 2 || store.requests != 2 || store.bytes != int64(len(body)) || store.commits != 1 || !store.published {
		t.Fatalf("result=%v err=%v requests=%d reserved=%d bytes=%d commits=%d published=%t", result, err, requestsSeen, store.requests, store.bytes, store.commits, store.published)
	}
}
