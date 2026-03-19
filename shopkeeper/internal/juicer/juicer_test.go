package juicer

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"testing"
)

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
