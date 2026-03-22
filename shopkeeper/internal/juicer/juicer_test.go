package juicer

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"strings"
	"testing"

	cdppage "github.com/chromedp/cdproto/page"
)

func TestLighthouseAxeRunConfigMatchesExpectedShape(t *testing.T) {
	configJSON, err := lighthouseAxeRunConfigJSON()
	if err != nil {
		t.Fatalf("marshal config: %v", err)
	}

	var config axeRunOptions
	if err := json.Unmarshal([]byte(configJSON), &config); err != nil {
		t.Fatalf("unmarshal config: %v", err)
	}

	if !config.ElementRef {
		t.Fatal("expected Lighthouse-aligned run to enable elementRef")
	}
	if config.RunOnly.Type != "tag" {
		t.Fatalf("expected runOnly type tag, got %q", config.RunOnly.Type)
	}
	if len(config.RunOnly.Values) != 2 || config.RunOnly.Values[0] != "wcag2a" || config.RunOnly.Values[1] != "wcag2aa" {
		t.Fatalf("unexpected runOnly values: %#v", config.RunOnly.Values)
	}
	if len(config.ResultTypes) != 2 || config.ResultTypes[0] != "violations" || config.ResultTypes[1] != "inapplicable" {
		t.Fatalf("unexpected result types: %#v", config.ResultTypes)
	}

	assertRuleEnabledState(t, config, "meta-viewport", true)
	assertRuleEnabledState(t, config, "target-size", true)
	assertRuleEnabledState(t, config, "nested-interactive", false)
	assertRuleEnabledState(t, config, "scrollable-region-focusable", false)
}

func TestLighthouseAxeRunScriptSerializesFailureSummaryAndRelatedNodes(t *testing.T) {
	script, err := lighthouseAxeRunScript()
	if err != nil {
		t.Fatalf("build script: %v", err)
	}

	for _, fragment := range []string{
		`failureSummary`,
		`relatedNodes`,
		`noHtml: true`,
		`window.scrollTo(originalScrollPosition.x, originalScrollPosition.y)`,
	} {
		if !strings.Contains(script, fragment) {
			t.Fatalf("expected script to contain %q", fragment)
		}
	}
}

func TestSelectCaptureIndexUsesExactMatchOrder(t *testing.T) {
	candidates := []captureCandidate{
		{Index: 0, HTML: `<button class="cta">Read more</button>`},
		{Index: 1, HTML: `<button class="cta">Read more</button>`},
		{Index: 2, HTML: `<button class="cta">Contact</button>`},
	}
	state := &captureAssignmentState{
		exactCursor:    make(map[string]int),
		selectorCursor: make(map[string]int),
	}

	first, ok := selectCaptureIndex(".cta", `<button class="cta">Read more</button>`, candidates, state)
	if !ok {
		t.Fatal("expected first duplicate exact match to resolve")
	}
	second, ok := selectCaptureIndex(".cta", `<button class="cta">Read more</button>`, candidates, state)
	if !ok {
		t.Fatal("expected second duplicate exact match to resolve")
	}
	unique, ok := selectCaptureIndex(".cta", `<button class="cta">Contact</button>`, candidates, state)
	if !ok {
		t.Fatal("expected unique exact match to resolve")
	}

	if first != 0 || second != 1 {
		t.Fatalf("expected duplicate exact matches to use ordered indices 0 then 1, got %d then %d", first, second)
	}
	if unique != 2 {
		t.Fatalf("expected unique exact match to reuse index 2, got %d", unique)
	}
}

func TestSelectCaptureIndexFallsBackToSelectorOrder(t *testing.T) {
	candidates := []captureCandidate{
		{Index: 0, HTML: `<div class="item">One</div>`},
		{Index: 1, HTML: `<div class="item">Two</div>`},
	}
	state := &captureAssignmentState{
		exactCursor:    make(map[string]int),
		selectorCursor: make(map[string]int),
	}

	first, ok := selectCaptureIndex(".item", `<div class="item">Missing</div>`, candidates, state)
	if !ok {
		t.Fatal("expected selector fallback to resolve first candidate")
	}
	second, ok := selectCaptureIndex(".item", `<div class="item">Still missing</div>`, candidates, state)
	if !ok {
		t.Fatal("expected selector fallback to resolve second candidate")
	}

	if first != 0 || second != 1 {
		t.Fatalf("expected selector fallback order 0 then 1, got %d then %d", first, second)
	}
}

func TestHoverBoundsForPreparationUsesVisibleAncestor(t *testing.T) {
	preparation := capturePreparation{
		Found: true,
		Target: elementBounds{
			Visible: false,
		},
		HoverTarget: elementBounds{
			Visible: true,
			Width:   120,
			Height:  40,
		},
		HasHoverTarget: true,
	}

	hoverBounds, ok := hoverBoundsForPreparation(preparation)
	if !ok {
		t.Fatal("expected hidden target to use visible ancestor hover bounds")
	}
	if hoverBounds.Width != 120 || hoverBounds.Height != 40 {
		t.Fatalf("unexpected hover bounds: %+v", hoverBounds)
	}
}

func TestHoverBoundsForPreparationRejectsUnavailableFocusShot(t *testing.T) {
	preparation := capturePreparation{
		Found: true,
		Target: elementBounds{
			Visible: false,
		},
	}

	if hoverBounds, ok := hoverBoundsForPreparation(preparation); ok {
		t.Fatalf("expected no hover bounds, got %+v", hoverBounds)
	}
}

func TestBuildViewportClipExpandsAndClamps(t *testing.T) {
	clip := buildViewportClip(elementBounds{
		X:              4,
		Y:              6,
		Width:          12,
		Height:         10,
		ViewportWidth:  120,
		ViewportHeight: 90,
	}, elementContextPadding, elementContextMinWidth, elementContextMinHeight)

	if clip == nil {
		t.Fatal("expected clip")
	}
	if clip.X != 0 || clip.Y != 0 {
		t.Fatalf("expected clip to clamp to viewport origin, got x=%v y=%v", clip.X, clip.Y)
	}
	if clip.Width != 120 || clip.Height != 90 {
		t.Fatalf("expected clip to clamp to viewport size, got width=%v height=%v", clip.Width, clip.Height)
	}
	if clip.Scale != elementScreenshotScale {
		t.Fatalf("unexpected scale: %v", clip.Scale)
	}
}

func TestBuildViewportClipKeepsMinimumSizeNearViewportEdge(t *testing.T) {
	clip := buildViewportClip(elementBounds{
		X:              1180,
		Y:              -62,
		Width:          24,
		Height:         18,
		ViewportWidth:  1280,
		ViewportHeight: 900,
	}, elementPreviewPadding, elementPreviewMinWidth, elementPreviewMinHeight)

	if clip == nil {
		t.Fatal("expected clip")
	}
	if clip.Height < elementPreviewMinHeight {
		t.Fatalf("expected preview clip to keep min height %v, got %v", elementPreviewMinHeight, clip.Height)
	}
	if clip.Y != 0 {
		t.Fatalf("expected preview clip to clamp to top edge without shrinking below min size, got y=%v", clip.Y)
	}
}

func TestCropPNGUsesViewportCoordinates(t *testing.T) {
	screenshot := encodePNG(t, 200, 100, color.RGBA{255, 255, 255, 255}, func(img *image.RGBA) {
		for y := 20; y < 60; y++ {
			for x := 40; x < 120; x++ {
				img.Set(x, y, color.RGBA{255, 237, 0, 255})
			}
		}
	})

	clip := viewportRect(40, 20, 80, 40)
	cropped, err := cropPNG(screenshot, &clip, 200, 100)
	if err != nil {
		t.Fatalf("crop png: %v", err)
	}

	img, err := png.Decode(bytes.NewReader(cropped))
	if err != nil {
		t.Fatalf("decode cropped png: %v", err)
	}
	if img.Bounds().Dx() != 80 || img.Bounds().Dy() != 40 {
		t.Fatalf("unexpected cropped size: %v", img.Bounds())
	}
}

func TestScreenshotNeedsContextRejectsTinyUniformImages(t *testing.T) {
	blank := encodePNG(t, 40, 20, color.RGBA{255, 255, 255, 255}, nil)
	if !screenshotNeedsContext(blank) {
		t.Fatal("expected tiny blank screenshot to need context")
	}
}

func TestScreenshotNeedsContextAcceptsDetailedImages(t *testing.T) {
	detailed := encodePNG(t, 160, 120, color.RGBA{255, 255, 255, 255}, func(img *image.RGBA) {
		for y := 20; y < 90; y++ {
			for x := 24; x < 132; x++ {
				img.Set(x, y, color.RGBA{34, 34, 34, 255})
			}
		}
	})
	if screenshotNeedsContext(detailed) {
		t.Fatal("expected detailed screenshot to be accepted")
	}
}

func encodePNG(t *testing.T, width, height int, background color.RGBA, draw func(*image.RGBA)) []byte {
	t.Helper()

	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			img.SetRGBA(x, y, background)
		}
	}

	if draw != nil {
		draw(img)
	}

	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	return buf.Bytes()
}

func assertRuleEnabledState(t *testing.T, config axeRunOptions, ruleID string, expected bool) {
	t.Helper()

	rule, ok := config.Rules[ruleID]
	if !ok {
		t.Fatalf("expected rule override for %q", ruleID)
	}
	if rule.Enabled != expected {
		t.Fatalf("expected %q enabled=%t, got %t", ruleID, expected, rule.Enabled)
	}
}

func viewportRect(x, y, width, height float64) cdppage.Viewport {
	return cdppage.Viewport{
		X:      x,
		Y:      y,
		Width:  width,
		Height: height,
		Scale:  elementScreenshotScale,
	}
}
