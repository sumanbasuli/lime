package juicer

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestAxeEvidenceBudgetKeepsOrdinaryResultAndRejectsOversize(t *testing.T) {
	budget := &scanEvidenceBudget{}
	ordinary := []byte(`{"violations":[],"incomplete":[],"passes":[],"version":"4.10.2"}`)
	if !budget.reserveAxeResult(len(ordinary)) {
		t.Fatal("ordinary axe result was rejected")
	}
	var parsed axeResult
	if err := json.Unmarshal(ordinary, &parsed); err != nil || parsed.Version != "4.10.2" {
		t.Fatalf("ordinary axe result changed: %v, err=%v", parsed, err)
	}
	if budget.reserveAxeResult(maxPageAxeResultBytes + 1) {
		t.Fatal("oversized page result was admitted")
	}
	for budget.reserveAxeResult(maxPageAxeResultBytes) {
	}
	if budget.axeBytes > maxScanAxeResultBytes {
		t.Fatalf("scan result budget exceeded: %d", budget.axeBytes)
	}
}

func TestAxeResultBudgetCarriesAcrossAutomaticSlices(t *testing.T) {
	shared := &AxeResultBudget{}
	first := &scanEvidenceBudget{sharedAxe: shared}
	second := &scanEvidenceBudget{sharedAxe: shared}
	for range maxScanAxeResultBytes / maxPageAxeResultBytes {
		if !first.reserveAxeResult(maxPageAxeResultBytes) {
			t.Fatal("first slice rejected allowed axe evidence")
		}
	}
	if second.reserveAxeResult(1) {
		t.Fatal("requeued slice reset the scan-wide axe budget")
	}
}

func TestAxeResultBudgetReleasesUncheckpointedPageForRetry(t *testing.T) {
	shared := &AxeResultBudget{}
	first := &scanEvidenceBudget{sharedAxe: shared}
	if !first.reserveAxeResult(maxPageAxeResultBytes) {
		t.Fatal("first page rejected")
	}
	first.releaseUncheckpointedAxeResult(maxPageAxeResultBytes)
	second := &scanEvidenceBudget{sharedAxe: shared}
	for range maxScanAxeResultBytes / maxPageAxeResultBytes {
		if !second.reserveAxeResult(maxPageAxeResultBytes) {
			t.Fatal("canceled page charge prevented retry")
		}
	}
	if shared.bytes != maxScanAxeResultBytes {
		t.Fatalf("shared budget = %d, want %d", shared.bytes, maxScanAxeResultBytes)
	}
}

func TestScreenshotBudgetCountsExistingFilesAndCapsPerPage(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "previous.png"), make([]byte, 256), 0600); err != nil {
		t.Fatal(err)
	}
	budget, err := newScanEvidenceBudget(dir)
	if err != nil {
		t.Fatal(err)
	}
	if budget.screenshotFiles != 1 || budget.screenshotBytes != 256 {
		t.Fatalf("resumed screenshot usage = %d files / %d bytes", budget.screenshotFiles, budget.screenshotBytes)
	}
	page := &pageScreenshotBudget{}
	if !budget.reserveScreenshot(page, 1_024) {
		t.Fatal("ordinary screenshot was rejected")
	}
	oversizedPage := &pageScreenshotBudget{}
	if budget.reserveScreenshot(oversizedPage, maxSingleScreenshotSize+1) {
		t.Fatal("oversized screenshot was admitted")
	}
	if budget.canCaptureScreenshot(oversizedPage) {
		t.Fatal("oversized screenshot did not stop further captures for the page")
	}
	for page.files < maxPageScreenshotFiles {
		if !budget.reserveScreenshot(page, 1) {
			t.Fatalf("page budget rejected file %d", page.files+1)
		}
	}
	if budget.canCaptureScreenshot(page) || budget.reserveScreenshot(page, 1) {
		t.Fatal("page screenshot count limit was bypassed")
	}
}

func TestScreenshotBudgetDiscardsInterruptedPageStaging(t *testing.T) {
	dir := t.TempDir()
	staging, err := os.MkdirTemp(dir, ".pending-")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(staging, "unpublished.png"), make([]byte, 256), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "saved.png"), make([]byte, 128), 0600); err != nil {
		t.Fatal(err)
	}
	budget, err := newScanEvidenceBudget(dir)
	if err != nil {
		t.Fatal(err)
	}
	if budget.screenshotFiles != 1 || budget.screenshotBytes != 128 {
		t.Fatalf("resumed budget counted staged files: %d files / %d bytes", budget.screenshotFiles, budget.screenshotBytes)
	}
	if _, err := os.Stat(staging); !os.IsNotExist(err) {
		t.Fatalf("interrupted staging directory was not removed: %v", err)
	}
	page := &pageScreenshotBudget{}
	if !budget.reserveScreenshot(page, 512) {
		t.Fatal("ordinary page screenshot was rejected")
	}
	budget.releasePageScreenshots(page)
	if budget.screenshotFiles != 1 || budget.screenshotBytes != 128 {
		t.Fatalf("discarded page kept budget reservation: %d files / %d bytes", budget.screenshotFiles, budget.screenshotBytes)
	}
}

func TestScreenshotBudgetReconcilesReplacedPageOnResume(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "page.png"), make([]byte, 256), 0600); err != nil {
		t.Fatal(err)
	}
	budget, err := newScanEvidenceBudget(dir)
	if err != nil {
		t.Fatal(err)
	}
	staging, err := os.MkdirTemp(dir, ".pending-")
	if err != nil {
		t.Fatal(err)
	}
	page := &pageScreenshotBudget{}
	reservation := budget.reserveFullPageScreenshot(page)
	if !budget.settleFullPageScreenshot(page, &reservation, 128) {
		t.Fatal("replacement full-page screenshot was not admitted")
	}
	if err := writeReservedScreenshot(filepath.Join(staging, "page.png"), make([]byte, 128), budget, page); err != nil {
		t.Fatal(err)
	}
	published, err := publishPageScreenshots(staging, dir, page.staged)
	if err != nil {
		t.Fatal(err)
	}
	budget.reconcilePublishedScreenshots(page, published)
	if err := os.Remove(staging); err != nil {
		t.Fatal(err)
	}
	if len(published) != 1 || !published[0].replacedRegular || published[0].replacedBytes != 256 {
		t.Fatalf("replacement was not recorded: %+v", published)
	}
	if budget.screenshotFiles != 1 || budget.screenshotBytes != 128 {
		t.Fatalf("replaced screenshot was charged twice: %+v", budget)
	}
	assertScreenshotBudgetMatchesDisk(t, dir, budget)
}

func TestScreenshotBudgetReconcilesPartialPublishFailure(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a.png"), make([]byte, 9), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "b.png"), 0700); err != nil {
		t.Fatal(err)
	}
	budget, err := newScanEvidenceBudget(dir)
	if err != nil {
		t.Fatal(err)
	}
	staging, err := os.MkdirTemp(dir, ".pending-")
	if err != nil {
		t.Fatal(err)
	}
	page := &pageScreenshotBudget{}
	for _, file := range []struct {
		name string
		size int
	}{{"a.png", 30}, {"b.png", 40}} {
		if !budget.reserveScreenshot(page, file.size) {
			t.Fatalf("could not reserve %s", file.name)
		}
		if err := writeReservedScreenshot(filepath.Join(staging, file.name), make([]byte, file.size), budget, page); err != nil {
			t.Fatal(err)
		}
	}
	published, err := publishPageScreenshots(staging, dir, page.staged)
	if err == nil || len(published) != 1 || published[0].name != "a.png" {
		t.Fatalf("expected first replacement followed by a failed rename: published=%+v, err=%v", published, err)
	}
	budget.reconcilePublishedScreenshots(page, published)
	if err := os.RemoveAll(staging); err != nil {
		t.Fatal(err)
	}
	if page.files != 1 || page.bytes != 30 || budget.screenshotFiles != 1 || budget.screenshotBytes != 30 {
		t.Fatalf("partial publication retained staged charges: page=%+v, scan=%+v", page, budget)
	}
	assertScreenshotBudgetMatchesDisk(t, dir, budget)
	next := &pageScreenshotBudget{}
	reservation := budget.reserveFullPageScreenshot(next)
	if !reservation.active {
		t.Fatal("a later page could not reserve full-page screenshot capacity")
	}
	if budget.settleFullPageScreenshot(next, &reservation, 0) {
		t.Fatal("an empty screenshot was retained")
	}
	assertScreenshotBudgetMatchesDisk(t, dir, budget)
}

func assertScreenshotBudgetMatchesDisk(t *testing.T, dir string, budget *scanEvidenceBudget) {
	t.Helper()
	actual, err := newScanEvidenceBudget(dir)
	if err != nil {
		t.Fatal(err)
	}
	if budget.screenshotFiles != actual.screenshotFiles || budget.screenshotBytes != actual.screenshotBytes {
		t.Fatalf("budget usage = %d files / %d bytes, disk = %d files / %d bytes", budget.screenshotFiles, budget.screenshotBytes, actual.screenshotFiles, actual.screenshotBytes)
	}
}

func TestScreenshotBudgetIsSharedAcrossWorkers(t *testing.T) {
	budget := &scanEvidenceBudget{screenshotFiles: maxScanScreenshotFiles - 1}
	var wg sync.WaitGroup
	var admitted int
	var mu sync.Mutex
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if budget.reserveScreenshot(&pageScreenshotBudget{}, 1) {
				mu.Lock()
				admitted++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if admitted != 1 || budget.screenshotFiles != maxScanScreenshotFiles {
		t.Fatalf("shared screenshot limit admitted %d new files, total=%d", admitted, budget.screenshotFiles)
	}
}

func TestFullPageScreenshotKeepsCapacityAfterElementCaptures(t *testing.T) {
	budget := &scanEvidenceBudget{}
	page := &pageScreenshotBudget{}
	reservation := budget.reserveFullPageScreenshot(page)
	if !reservation.active {
		t.Fatal("full-page screenshot could not reserve an ordinary page budget")
	}
	elementFiles := 0
	for range 32 {
		for range 2 {
			if budget.reserveScreenshot(page, 1_024) {
				elementFiles++
			}
		}
	}
	if elementFiles != maxPageScreenshotFiles-1 {
		t.Fatalf("element files = %d, want %d remaining after full-page reservation", elementFiles, maxPageScreenshotFiles-1)
	}
	if !budget.settleFullPageScreenshot(page, &reservation, 2_048) {
		t.Fatal("full-page image was rejected after element files filled the remaining slots")
	}
	if reservation.active || page.files != maxPageScreenshotFiles || budget.screenshotFiles != maxPageScreenshotFiles ||
		page.bytes > maxPageScreenshotBytes || budget.screenshotBytes > maxScanScreenshotBytes {
		t.Fatalf("invalid screenshot usage: page=%+v, scan=%+v", page, budget)
	}
}

func TestFullPageScreenshotReservationReleasesFailureAndUnusedBytes(t *testing.T) {
	budget := &scanEvidenceBudget{screenshotBytes: maxScanScreenshotBytes - 512}
	page := &pageScreenshotBudget{}
	reservation := budget.reserveFullPageScreenshot(page)
	if !reservation.active || reservation.bytes != 512 {
		t.Fatalf("reservation did not use remaining scan capacity: %+v", reservation)
	}
	if budget.settleFullPageScreenshot(page, &reservation, 513) {
		t.Fatal("full-page image exceeded remaining scan capacity")
	}
	if page.files != 0 || page.bytes != 0 || budget.screenshotFiles != 0 || budget.screenshotBytes != maxScanScreenshotBytes-512 {
		t.Fatalf("failed capture leaked reservation: page=%+v, scan=%+v", page, budget)
	}
	reservation = budget.reserveFullPageScreenshot(page)
	if !budget.settleFullPageScreenshot(page, &reservation, 256) {
		t.Fatal("ordinary full-page image was rejected after failed capture")
	}
	if page.files != 1 || page.bytes != 256 || budget.screenshotFiles != 1 || budget.screenshotBytes != maxScanScreenshotBytes-256 {
		t.Fatalf("unused reserved bytes were not released: page=%+v, scan=%+v", page, budget)
	}
	canceledPage := &pageScreenshotBudget{}
	reservation = budget.reserveFullPageScreenshot(canceledPage)
	if !reservation.active {
		t.Fatal("cancellation test could not reserve a screenshot")
	}
	if budget.settleFullPageScreenshot(canceledPage, &reservation, 0) {
		t.Fatal("a canceled full-page capture was recorded as successful")
	}
	if canceledPage.files != 0 || canceledPage.bytes != 0 || budget.screenshotFiles != 1 || budget.screenshotBytes != maxScanScreenshotBytes-256 {
		t.Fatalf("canceled capture leaked reservation: page=%+v, scan=%+v", canceledPage, budget)
	}
}

func TestFullPageScreenshotReservationIsSharedAcrossWorkers(t *testing.T) {
	budget := &scanEvidenceBudget{screenshotFiles: maxScanScreenshotFiles - 1}
	var wg sync.WaitGroup
	var admitted int
	var mu sync.Mutex
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			page := &pageScreenshotBudget{}
			reservation := budget.reserveFullPageScreenshot(page)
			if !reservation.active {
				return
			}
			mu.Lock()
			admitted++
			mu.Unlock()
		}()
	}
	wg.Wait()
	if admitted != 1 || budget.screenshotFiles != maxScanScreenshotFiles || budget.screenshotBytes > maxScanScreenshotBytes {
		t.Fatalf("shared full-page reservation admitted %d files, totals=%+v", admitted, budget)
	}
}

func TestAxeBudgetIsSharedAcrossWorkers(t *testing.T) {
	budget := &scanEvidenceBudget{axeBytes: maxScanAxeResultBytes - 1}
	var wg sync.WaitGroup
	var admitted int
	var mu sync.Mutex
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if budget.reserveAxeResult(1) {
				mu.Lock()
				admitted++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if admitted != 1 || budget.axeBytes != maxScanAxeResultBytes {
		t.Fatalf("shared axe limit admitted %d results, total=%d", admitted, budget.axeBytes)
	}
}

func TestFullPagePixelBudgetAndVisibleTruncationMarkers(t *testing.T) {
	if !withinFullPagePixelBudget(1_440, 900) {
		t.Fatal("ordinary desktop page exceeded pixel budget")
	}
	if withinFullPagePixelBudget(50_000, 50_000) || withinFullPagePixelBudget(math.NaN(), 900) {
		t.Fatal("oversized or invalid page dimensions were admitted")
	}
	node := &Node{HTML: "<button>Save</button>"}
	markScreenshotOmitted(node)
	markScreenshotOmitted(node)
	if strings.Count(node.HTML, screenshotBudgetWarning) != 1 {
		t.Fatalf("element screenshot warning is not inspectable exactly once: %q", node.HTML)
	}
	otherNode := &Node{HTML: "<a>More</a>"}
	markScreenshotOmitted(otherNode)
	if !strings.Contains(otherNode.HTML, screenshotBudgetWarning) {
		t.Fatal("another omitted node lost its own screenshot warning")
	}
	result := RawResult{Violations: []Violation{{Nodes: []Node{{HTML: "<a>More</a>"}}}}}
	markFullPageScreenshotOmitted(&result, fullPageScreenshotBudgetWarning)
	if !strings.Contains(result.Violations[0].Nodes[0].HTML, fullPageScreenshotBudgetWarning) {
		t.Fatal("full-page screenshot warning was not retained on an issue node")
	}
	markFullPageScreenshotOmitted(&result, fullPageScreenshotChangedWarning)
	if !strings.Contains(result.Violations[0].Nodes[0].HTML, fullPageScreenshotChangedWarning) {
		t.Fatal("page-growth screenshot warning was not retained on an issue node")
	}
}

func TestAxeSerializerContainsPreReturnLimits(t *testing.T) {
	script, err := lighthouseAxeRunScript()
	if err != nil {
		t.Fatal(err)
	}
	for _, fragment := range []string{
		"const maxNodes = 2000",
		"const maxHTMLChars = 4096",
		"const maxOuterHTMLNodes = 4096",
		"const maxOuterHTMLChars = 65536",
		"!canSerializeOuterHTML(element)",
		"boundedTarget(fallbackTarget)",
		"HTML snippet truncated",
		outerHTMLBudgetWarning,
		"encoder.encode(serialized).length > maxResultBytes",
		"limitError",
	} {
		if !strings.Contains(script, fragment) {
			t.Fatalf("axe serializer lacks bound %q", fragment)
		}
	}
	if strings.Index(script, "canSerializeOuterHTML(element)") > strings.Index(script, "element.outerHTML") {
		t.Fatal("axe script reads outerHTML before the DOM preflight")
	}
}

func TestCaptureCandidateScriptPreflightsOuterHTML(t *testing.T) {
	script := captureCandidateScript([]byte(`[".cta"]`))
	for _, fragment := range []string{
		"const maxCandidates = 64",
		"const maxOuterHTMLNodes = 4096",
		"const maxOuterHTMLChars = 65536",
		"if (!canSerializeOuterHTML(nodes[index]))",
		"if (html.length > maxHTMLChars)",
		"encoder.encode(result).length > maxResultBytes",
	} {
		if !strings.Contains(script, fragment) {
			t.Fatalf("capture candidate script lacks bound %q", fragment)
		}
	}
	if strings.Index(script, "canSerializeOuterHTML(nodes[index])") > strings.Index(script, "nodes[index].outerHTML") {
		t.Fatal("capture candidate script reads outerHTML before the DOM preflight")
	}
}

func TestCaptureCandidatePayloadRejectsLimitInsteadOfUsingPartialIndices(t *testing.T) {
	ordinary, err := decodeCaptureCandidates(`{"candidates":{".cta":[{"index":2,"html":"<button class=\"cta\">Save</button>"}]}}`)
	if err != nil || len(ordinary[".cta"]) != 1 || ordinary[".cta"][0].Index != 2 {
		t.Fatalf("ordinary capture candidates changed: %v, err=%v", ordinary, err)
	}
	if _, err := decodeCaptureCandidates(`{"limitError":"element screenshot matching exceeds the evidence budget"}`); err == nil {
		t.Fatal("capture candidate limit was treated as an empty successful match set")
	}
	if _, err := decodeCaptureCandidates(strings.Repeat("x", maxCaptureResultBytes+1)); err == nil {
		t.Fatal("oversized capture candidate payload was admitted")
	}
}

func TestCaptureCandidateSuppressionIsPerSelector(t *testing.T) {
	candidates, err := decodeCaptureCandidates(`{"candidates":{".large":null,".small":[{"index":3,"html":"<button class=\"small\">Save</button>"}]}}`)
	if err != nil {
		t.Fatal(err)
	}
	violations := []Violation{{Nodes: []Node{
		{HTML: "<div>Large</div>", Target: []string{".large"}},
		{HTML: `<button class="small">Save</button>`, Target: []string{".small"}},
	}}}
	assignCaptureIndicesFromCandidates(violations, candidates)
	if !violations[0].Nodes[0].CaptureSuppressed {
		t.Fatal("large selector was not suppressed")
	}
	if violations[0].Nodes[1].CaptureSuppressed || !violations[0].Nodes[1].HasCaptureIndex || violations[0].Nodes[1].CaptureIndex != 3 {
		t.Fatalf("unrelated small selector lost its exact capture: %+v", violations[0].Nodes[1])
	}
}
