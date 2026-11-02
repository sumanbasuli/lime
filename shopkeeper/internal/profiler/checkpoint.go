package profiler

import (
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
	"github.com/sumanbasuli/lime/shopkeeper/internal/repository"
	"github.com/sumanbasuli/lime/shopkeeper/internal/rootdns"
	log "github.com/sumanbasuli/lime/shopkeeper/internal/safelog"
)

// DiscoveryStore is the narrow durable boundary used by checkpointed discovery.
// The repository owns each transaction; Profiler never holds one during I/O.
type DiscoveryStore interface {
	LoadOrCreateDiscovery(context.Context, string, string) (repository.DiscoverySnapshot, error)
	ReserveDiscoveryRequest(context.Context, string, int64) error
	ChargeDiscoveryXMLBytes(context.Context, string, int64, int64) error
	NextDiscoverySitemap(context.Context, string, int64) (*repository.DiscoverySitemapTask, error)
	CommitDiscoverySitemap(context.Context, string, int64, repository.DiscoverySitemapTask, repository.DiscoveryDocument) error
	FailDiscoverySitemap(context.Context, string, int64, repository.DiscoverySitemapTask, string) error
	BeginDiscoveryProbes(context.Context, string, int64) (bool, error)
	PendingDiscoveryCandidates(context.Context, string, int64, int) ([]repository.DiscoveryCandidate, error)
	SaveDiscoveryProbe(context.Context, string, int64, repository.DiscoveryProbeOutcome) error
	PublishDiscoveryComplete(context.Context, string, int64) ([]models.URL, error)
}

type DiscoveryResult int

const (
	DiscoveryYielded DiscoveryResult = iota
	DiscoveryComplete
)

const checkpointCommitTimeout = 5 * time.Minute

type discoveryPersistenceError struct{ err error }

func (e *discoveryPersistenceError) Error() string { return e.err.Error() }
func (e *discoveryPersistenceError) Unwrap() error { return e.err }

func isPersistenceError(err error) bool {
	var target *discoveryPersistenceError
	return errors.As(err, &target)
}

// IsDiscoveryPersistenceError reports a store failure that should leave the
// scan recoverable for a later admission instead of marking it failed.
func IsDiscoveryPersistenceError(err error) bool { return isPersistenceError(err) }

func checkpointStoreError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, repository.ErrDiscoveryBudget) {
		return fmt.Errorf("%w: %w", errDiscoveryBudget, err)
	}
	if errors.Is(err, repository.ErrDiscoveryNestedFailure) || errors.Is(err, repository.ErrDiscoveryNoURLs) {
		return err
	}
	return &discoveryPersistenceError{err: err}
}

// DiscoverCheckpointed resumes committed sitemap and candidate work. The caller
// owns the admission clock and passes its fairness/deadline context here.
func DiscoverCheckpointed(ctx context.Context, scanID, rootURL string, epoch int64, store DiscoveryStore, observe rootdns.Observer, guards ...rootdns.PrivateDialGuard) (DiscoveryResult, error) {
	d, err := newDiscovery(rootURL)
	if err != nil {
		return DiscoveryYielded, log.Error(err)
	}
	d.observeRootDNS = observe
	if len(guards) > 0 {
		d.privateDialGuard = guards[0]
	}
	defer d.client.CloseIdleConnections()
	d.requestHook = func(ctx context.Context) error {
		return checkpointStoreError(store.ReserveDiscoveryRequest(ctx, scanID, epoch))
	}
	d.chargeHook = func(ctx context.Context, n int64) error {
		return checkpointStoreError(store.ChargeDiscoveryXMLBytes(ctx, scanID, epoch, n))
	}

	snapshot, err := store.LoadOrCreateDiscovery(ctx, scanID, rootURL)
	if err != nil {
		return discoveryStop(ctx, checkpointStoreError(err))
	}
	if snapshot.Epoch != epoch {
		return DiscoveryYielded, repository.ErrDiscoveryInvariant
	}
	d.sitemapBytes = snapshot.XMLBytesUsed
	if snapshot.Phase == "complete" {
		return DiscoveryComplete, nil
	}
	if snapshot.Phase != "fetch" && snapshot.Phase != "probe" {
		return DiscoveryYielded, repository.ErrDiscoveryInvariant
	}

	if snapshot.Phase == "fetch" {
		for {
			if ctx.Err() != nil {
				return DiscoveryYielded, nil
			}
			task, err := store.NextDiscoverySitemap(ctx, scanID, epoch)
			if err != nil {
				return discoveryStop(ctx, checkpointStoreError(err))
			}
			if task == nil {
				break
			}
			if kind := d.invalidCheckpointTask(*task); kind != "" {
				if err := store.FailDiscoverySitemap(ctx, scanID, epoch, *task, kind); err != nil {
					return discoveryStop(ctx, checkpointStoreError(err))
				}
				continue
			}
			doc, err := d.fetchCheckpointSitemap(ctx, task.FetchURL)
			if err != nil {
				if errors.Is(err, errDiscoveryBudget) || isPersistenceError(err) {
					return DiscoveryYielded, err
				}
				if ctx.Err() != nil {
					return DiscoveryYielded, nil
				}
				kind := "fetch"
				if errors.Is(err, errInvalidSitemap) {
					kind = "xml"
				}
				log.Printf("Profiler: failed sitemap task: %v", err)
				if err := store.FailDiscoverySitemap(ctx, scanID, epoch, *task, kind); err != nil {
					return discoveryStop(ctx, checkpointStoreError(err))
				}
				continue
			}
			// Once the XML is complete, checkpoint it even if the fairness
			// deadline expires here. Re-fetching would consume the request and
			// XML budgets again without adding any new information.
			commitCtx, cancelCommit := context.WithTimeout(context.WithoutCancel(ctx), checkpointCommitTimeout)
			err = store.CommitDiscoverySitemap(commitCtx, scanID, epoch, *task, doc)
			cancelCommit()
			if err != nil {
				return DiscoveryYielded, checkpointStoreError(err)
			}
		}
		ready, err := store.BeginDiscoveryProbes(ctx, scanID, epoch)
		if err != nil {
			return discoveryStop(ctx, checkpointStoreError(err))
		}
		if !ready {
			return DiscoveryYielded, repository.ErrDiscoveryInvariant
		}
	}

	if err := d.probeCheckpointCandidates(ctx, scanID, epoch, store); err != nil {
		return discoveryStop(ctx, err)
	}
	if ctx.Err() != nil {
		return DiscoveryYielded, nil
	}
	_, err = store.PublishDiscoveryComplete(ctx, scanID, epoch)
	if err != nil {
		return discoveryStop(ctx, checkpointStoreError(err))
	}
	return DiscoveryComplete, nil
}

func discoveryStop(ctx context.Context, err error) (DiscoveryResult, error) {
	if isPersistenceError(err) {
		return DiscoveryYielded, err
	}
	if ctx.Err() != nil && (errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)) {
		return DiscoveryYielded, nil
	}
	return DiscoveryYielded, err
}

func (d *discovery) invalidCheckpointTask(task repository.DiscoverySitemapTask) string {
	if task.Depth > maxDepth {
		return "depth"
	}
	if err := d.checkURL(task.FetchURL); err != nil {
		if errors.Is(err, errDifferentAuthority) {
			return "authority"
		}
		return "invalid_url"
	}
	return ""
}

func (d *discovery) fetchCheckpointSitemap(ctx context.Context, rawURL string) (repository.DiscoveryDocument, error) {
	var lastErr error
	for i, profile := range sitemapFetchProfiles {
		var lastStatusCode int
		for attempt := 1; attempt <= maxFetchRetries; attempt++ {
			if err := ctx.Err(); err != nil {
				return repository.DiscoveryDocument{}, err
			}
			var document repository.DiscoveryDocument
			statusCode, retry, err := d.fetchURLOnceConsume(ctx, rawURL, profile, func(body io.Reader) error {
				var parseErr error
				document, parseErr = decodeCheckpointSitemap(body)
				return parseErr
			})
			if err == nil {
				if i > 0 {
					log.Printf("Profiler: fetched %s using %s profile", rawURL, profile.name)
				}
				return document, nil
			}
			lastErr, lastStatusCode = err, statusCode
			if !retry || attempt == maxFetchRetries {
				break
			}
			timer := time.NewTimer(time.Duration(attempt) * fetchRetryDelay)
			select {
			case <-ctx.Done():
				timer.Stop()
				return repository.DiscoveryDocument{}, ctx.Err()
			case <-timer.C:
			}
		}
		if lastStatusCode == http.StatusForbidden && i < len(sitemapFetchProfiles)-1 {
			continue
		}
		break
	}
	return repository.DiscoveryDocument{}, lastErr
}

// decodeCheckpointSitemap preserves XML child indexes. It drops local
// duplicates and invalid page URLs, and bounds the parsed document to the
// global raw page cap. Cross-document dedup and the remaining page budget are
// checked by CommitDiscoverySitemap's atomic transaction.
func decodeCheckpointSitemap(body io.Reader) (repository.DiscoveryDocument, error) {
	decoder := xml.NewDecoder(body)
	var root xml.StartElement
	for {
		token, err := decoder.Token()
		if err != nil {
			return repository.DiscoveryDocument{}, invalidSitemap(err)
		}
		if start, ok := token.(xml.StartElement); ok {
			root = start
			break
		}
		if data, ok := token.(xml.CharData); ok && !isXMLWhitespace(data) {
			return repository.DiscoveryDocument{}, invalidSitemap(errors.New("text before root element"))
		}
	}
	if root.Name.Local != "urlset" && root.Name.Local != "sitemapindex" {
		return repository.DiscoveryDocument{}, invalidSitemap(fmt.Errorf("unexpected root element %s", root.Name.Local))
	}
	doc := repository.DiscoveryDocument{IsIndex: root.Name.Local == "sitemapindex"}
	localSeen := make(map[string]bool)
	count := 0
	for {
		token, err := decoder.Token()
		if err != nil {
			return repository.DiscoveryDocument{}, invalidSitemap(err)
		}
		switch element := token.(type) {
		case xml.StartElement:
			if doc.IsIndex && element.Name.Local == "sitemap" {
				var entry sitemapEntry
				if err := decoder.DecodeElement(&entry, &element); err != nil {
					return repository.DiscoveryDocument{}, invalidSitemap(err)
				}
				index := count
				count++
				loc := strings.TrimSpace(entry.Loc)
				if loc == "" {
					continue
				}
				key := canonicalizeURLString(loc)
				if localSeen[key] {
					continue
				}
				if len(localSeen) >= maxDiscoveryRequests {
					return repository.DiscoveryDocument{}, fmt.Errorf("%w: at most %d distinct sitemap URLs", errDiscoveryBudget, maxDiscoveryRequests)
				}
				localSeen[key] = true
				doc.Children = append(doc.Children, repository.DiscoverySitemapTask{CanonicalURL: key, FetchURL: loc, EntryIndex: index})
			} else if !doc.IsIndex && element.Name.Local == "url" {
				var entry urlEntry
				if err := decoder.DecodeElement(&entry, &element); err != nil {
					return repository.DiscoveryDocument{}, invalidSitemap(err)
				}
				count++
				loc := strings.TrimSpace(entry.Loc)
				if loc == "" || !isValidURL(loc) || localSeen[loc] {
					continue
				}
				if len(localSeen) >= maxDiscoveredURLs {
					return repository.DiscoveryDocument{}, fmt.Errorf("%w: at most %d distinct page URLs", errDiscoveryBudget, maxDiscoveredURLs)
				}
				localSeen[loc] = true
				doc.Candidates = append(doc.Candidates, loc)
			} else if err := decoder.Skip(); err != nil {
				return repository.DiscoveryDocument{}, invalidSitemap(err)
			}
		case xml.EndElement:
			if element.Name == root.Name {
				if count == 0 {
					return repository.DiscoveryDocument{}, invalidSitemap(errors.New("no sitemap entries"))
				}
				for {
					token, err := decoder.Token()
					if errors.Is(err, io.EOF) {
						return doc, nil
					}
					if err != nil {
						return repository.DiscoveryDocument{}, invalidSitemap(err)
					}
					if data, ok := token.(xml.CharData); ok && isXMLWhitespace(data) {
						continue
					}
					if _, ok := token.(xml.Comment); ok {
						continue
					}
					if _, ok := token.(xml.ProcInst); ok {
						continue
					}
					return repository.DiscoveryDocument{}, invalidSitemap(errors.New("content after root element"))
				}
			}
		}
	}
}

func (d *discovery) probeCheckpointCandidates(ctx context.Context, scanID string, epoch int64, store DiscoveryStore) error {
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		candidates, err := store.PendingDiscoveryCandidates(ctx, scanID, epoch, resolveURLWorkerCount)
		if err != nil {
			return checkpointStoreError(err)
		}
		if len(candidates) == 0 {
			return nil
		}
		workerCtx, cancel := context.WithCancel(ctx)
		var wg sync.WaitGroup
		var firstErr error
		var once sync.Once
		for _, candidate := range candidates {
			candidate := candidate
			wg.Add(1)
			go func() {
				defer wg.Done()
				outcome, err := d.evaluateURLEligibility(workerCtx, discoveredURL{index: candidate.Ordinal, rawURL: candidate.RawURL})
				if err == nil {
					state := "unresolved"
					if outcome.eligible {
						state = "eligible"
					} else if outcome.external {
						state = "external"
					}
					finalURL := ""
					if outcome.eligible {
						finalURL = outcome.finalURL
					}
					saveCtx, saveCancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
					err = checkpointStoreError(store.SaveDiscoveryProbe(saveCtx, scanID, epoch, repository.DiscoveryProbeOutcome{
						Ordinal: candidate.Ordinal, RawURL: candidate.RawURL, Outcome: state,
						FinalURL: finalURL, Redirected: outcome.redirected,
					}))
					saveCancel()
				}
				if err != nil {
					once.Do(func() { firstErr = err; cancel() })
				}
			}()
		}
		wg.Wait()
		cancel()
		if firstErr != nil {
			return firstErr
		}
	}
}
