package juicer

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

const (
	maxAxeNodes             = 2_000
	maxAxeRules             = 512
	maxAxeHTMLChars         = 4_096
	maxAxeSummaryChars      = 2_048
	maxAxeSelectorChars     = 1_024
	maxAxeTargetParts       = 8
	maxPageAxeResultBytes   = 16 << 20
	maxScanAxeResultBytes   = 128 << 20
	maxPageScreenshotFiles  = 64
	maxPageScreenshotBytes  = 32 << 20
	maxScanScreenshotFiles  = 50_000
	maxScanScreenshotBytes  = 2 << 30
	maxSingleScreenshotSize = 20 << 20
	maxFullPagePixels       = 24_000_000
	maxCaptureCandidates    = 64
	maxCaptureCandidateSize = 4_096
	maxCaptureResultBytes   = 4 << 20
	maxOuterHTMLNodes       = 4_096
	maxOuterHTMLChars       = 64 << 10
)

const screenshotBudgetWarning = "<!-- LIME evidence warning: screenshot omitted because the capture budget was reached -->"
const fullPageScreenshotBudgetWarning = "<!-- LIME evidence warning: full-page screenshot omitted because the capture budget was reached -->"
const fullPageScreenshotChangedWarning = "<!-- LIME evidence warning: full-page screenshot omitted because the page grew during capture -->"
const outerHTMLBudgetWarning = "<!-- LIME evidence warning: HTML snippet omitted because the element exceeds the DOM budget -->"

var errFullPagePixelBudget = errors.New("full-page screenshot exceeds the pixel budget")
var errFullPageLayoutChanged = errors.New("page grew during full-page screenshot capture")
var errCaptureCandidateBudget = errors.New("element screenshot matching exceeds the evidence budget")

// scanEvidenceBudget bounds the results retained by ScanPages and the files
// created for one scan. A resumed scan starts with its existing file usage.
type scanEvidenceBudget struct {
	mu              sync.Mutex
	axeBytes        int64
	sharedAxe       *AxeResultBudget
	screenshotFiles int64
	screenshotBytes int64
}

// AxeResultBudget carries the raw-result byte cap across automatic slices of
// one scan in the same process.
type AxeResultBudget struct {
	mu    sync.Mutex
	bytes int64
}

type pageScreenshotBudget struct {
	files     int64
	bytes     int64
	exhausted bool
	staged    map[string]int64
}

type fullPageScreenshotReservation struct {
	bytes  int64
	active bool
}

func newScanEvidenceBudget(screenshotDir string) (*scanEvidenceBudget, error) {
	budget := &scanEvidenceBudget{}
	err := filepath.WalkDir(screenshotDir, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			// Only a previous interrupted worker can leave a staged page here.
			// Do not charge discarded, unpublished screenshots on resume.
			if path != screenshotDir && strings.HasPrefix(entry.Name(), ".pending-") {
				if err := os.RemoveAll(path); err != nil {
					return err
				}
				return filepath.SkipDir
			}
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.Mode().IsRegular() {
			budget.screenshotFiles++
			budget.screenshotBytes += info.Size()
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("failed to inspect existing screenshots: %w", err)
	}
	return budget, nil
}

func (b *scanEvidenceBudget) reserveAxeResult(bytes int) bool {
	if bytes > maxPageAxeResultBytes || bytes < 0 {
		return false
	}
	if b.sharedAxe != nil {
		b.sharedAxe.mu.Lock()
		defer b.sharedAxe.mu.Unlock()
		if b.sharedAxe.bytes+int64(bytes) > maxScanAxeResultBytes {
			return false
		}
		b.sharedAxe.bytes += int64(bytes)
		return true
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.axeBytes+int64(bytes) > maxScanAxeResultBytes {
		return false
	}
	b.axeBytes += int64(bytes)
	return true
}

func (b *scanEvidenceBudget) releaseUncheckpointedAxeResult(bytes int) {
	if b.sharedAxe == nil || bytes <= 0 {
		return
	}
	b.sharedAxe.mu.Lock()
	b.sharedAxe.bytes -= int64(bytes)
	b.sharedAxe.mu.Unlock()
}

func (b *scanEvidenceBudget) canCaptureScreenshot(page *pageScreenshotBudget) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return !page.exhausted && page.files < maxPageScreenshotFiles && page.bytes < maxPageScreenshotBytes &&
		b.screenshotFiles < maxScanScreenshotFiles && b.screenshotBytes < maxScanScreenshotBytes
}

func (b *scanEvidenceBudget) reserveScreenshot(page *pageScreenshotBudget, bytes int) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if page.exhausted || bytes > maxSingleScreenshotSize || bytes < 0 ||
		page.files >= maxPageScreenshotFiles || page.bytes+int64(bytes) > maxPageScreenshotBytes ||
		b.screenshotFiles >= maxScanScreenshotFiles || b.screenshotBytes+int64(bytes) > maxScanScreenshotBytes {
		page.exhausted = true
		return false
	}
	page.files++
	page.bytes += int64(bytes)
	b.screenshotFiles++
	b.screenshotBytes += int64(bytes)
	return true
}

// Element screenshots are captured first because a full-page capture changes
// Chrome's viewport metrics. Reserve room for the full-page image before those
// element captures can spend the entire page or scan budget.
func (b *scanEvidenceBudget) reserveFullPageScreenshot(page *pageScreenshotBudget) fullPageScreenshotReservation {
	b.mu.Lock()
	defer b.mu.Unlock()
	if page.exhausted || page.files >= maxPageScreenshotFiles || b.screenshotFiles >= maxScanScreenshotFiles {
		return fullPageScreenshotReservation{}
	}
	reserved := int64(maxSingleScreenshotSize)
	if available := int64(maxPageScreenshotBytes) - page.bytes; available < reserved {
		reserved = available
	}
	if available := int64(maxScanScreenshotBytes) - b.screenshotBytes; available < reserved {
		reserved = available
	}
	if reserved <= 0 {
		return fullPageScreenshotReservation{}
	}
	page.files++
	page.bytes += reserved
	b.screenshotFiles++
	b.screenshotBytes += reserved
	return fullPageScreenshotReservation{bytes: reserved, active: true}
}

// A failed or empty capture releases its reservation. A successful capture
// pays for its actual bytes, including any extra capacity still available.
func (b *scanEvidenceBudget) settleFullPageScreenshot(page *pageScreenshotBudget, reservation *fullPageScreenshotReservation, bytes int) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if !reservation.active {
		return false
	}
	reservation.active = false
	delta := int64(bytes) - reservation.bytes
	if bytes <= 0 || bytes > maxSingleScreenshotSize ||
		(delta > 0 && (page.bytes+delta > maxPageScreenshotBytes || b.screenshotBytes+delta > maxScanScreenshotBytes)) {
		page.files--
		page.bytes -= reservation.bytes
		b.screenshotFiles--
		b.screenshotBytes -= reservation.bytes
		return false
	}
	page.bytes += delta
	b.screenshotBytes += delta
	return true
}

func (b *scanEvidenceBudget) releasePageScreenshots(page *pageScreenshotBudget) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.screenshotFiles -= page.files
	b.screenshotBytes -= page.bytes
}

func (b *scanEvidenceBudget) releaseScreenshot(page *pageScreenshotBudget, bytes int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	page.files--
	page.bytes -= int64(bytes)
	b.screenshotFiles--
	b.screenshotBytes -= int64(bytes)
}

// Replace staged-file charges with only the files actually published. A
// resumed page can overwrite existing images that were counted at startup.
func (b *scanEvidenceBudget) reconcilePublishedScreenshots(page *pageScreenshotBudget, published []publishedScreenshot) {
	publishedNames := make(map[string]bool, len(published))
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, file := range published {
		publishedNames[file.name] = true
		if file.replacedRegular {
			b.screenshotFiles--
			b.screenshotBytes -= file.replacedBytes
		}
	}
	for name, size := range page.staged {
		if publishedNames[name] {
			continue
		}
		page.files--
		page.bytes -= size
		b.screenshotFiles--
		b.screenshotBytes -= size
	}
}

func withinFullPagePixelBudget(width, height float64) bool {
	return width > 0 && height > 0 && width <= maxFullPagePixels/height
}

// This preflight bounds the DOM nodes and estimated serialization size before
// outerHTML is read. Escaped character data and attribute values are charged at
// six characters each, above the largest ordinary HTML entity expansion.
func outerHTMLPreflightScript() string {
	return fmt.Sprintf(`
		const maxOuterHTMLNodes = %d;
		const maxOuterHTMLChars = %d;
		const canSerializeOuterHTML = (element) => {
			if (!element) return false;
			const stack = [element];
			let queued = 1;
			let estimated = 0;
			while (stack.length > 0) {
				const node = stack.pop();
				estimated += (node.nodeName ? node.nodeName.length * 4 : 0) + 16;
				if (node.nodeType === 3 || node.nodeType === 4 || node.nodeType === 7 || node.nodeType === 8) {
					estimated += (node.length || 0) * 6;
				}
				if (node.attributes) {
					for (const attr of node.attributes) {
						estimated += attr.name.length * 2 + attr.value.length * 6 + 4;
						if (estimated > maxOuterHTMLChars) return false;
					}
				}
				if (estimated > maxOuterHTMLChars) return false;
				const children = node.localName === "template" && node.content ? node.content.childNodes : node.childNodes;
				if (!children) continue;
				if (queued + children.length > maxOuterHTMLNodes) return false;
				queued += children.length;
				for (let index = 0; index < children.length; index++) stack.push(children[index]);
			}
			return true;
		};
	`, maxOuterHTMLNodes, maxOuterHTMLChars)
}
