package juicer

import (
	"bytes"
	"context"
	"fmt"
	"image/png"
	"net/url"
	"os"
	"testing"
	"time"

	cdppage "github.com/chromedp/cdproto/page"
	"github.com/chromedp/chromedp"
)

// Run with LIME_TEST_CHROME set to a local Chrome/Chromium binary. This fixture
// compares the existing full-page capture against a fixed measured clip; it
// needs no server or network access.
func TestFullPageClipGeometry(t *testing.T) {
	chromePath := os.Getenv("LIME_TEST_CHROME")
	if chromePath == "" {
		t.Skip("set LIME_TEST_CHROME to a local Chrome/Chromium binary for screenshot geometry fixture")
	}
	allocCtx, allocCancel := chromedp.NewExecAllocator(context.Background(), append(chromedp.DefaultExecAllocatorOptions[:],
		chromedp.ExecPath(chromePath),
		chromedp.Flag("no-sandbox", false),
		chromedp.Flag("disable-background-networking", true),
	)...)
	defer allocCancel()

	for _, fixture := range []struct {
		name   string
		width  int64
		height int64
	}{
		{"viewport", 800, 600},
		{"tall", 800, 1600},
		{"wide", 1600, 600},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			browserCtx, browserCancel := chromedp.NewContext(allocCtx)
			defer browserCancel()
			ctx, cancel := context.WithTimeout(browserCtx, 30*time.Second)
			defer cancel()
			html := fmt.Sprintf(`<html><head><style>html,body{margin:0}.panel{width:%dpx;height:%dpx;background:linear-gradient(#123456,#abcdef)}</style></head><body><div class="panel"></div></body></html>`, fixture.width, fixture.height)
			if err := chromedp.Run(ctx,
				chromedp.EmulateViewport(800, 600),
				chromedp.Navigate("data:text/html,"+url.PathEscape(html)),
				chromedp.WaitReady("body"),
			); err != nil {
				t.Fatal(err)
			}

			var baseline []byte
			if err := chromedp.Run(ctx, chromedp.ActionFunc(func(ctx context.Context) error {
				var err error
				baseline, err = cdppage.CaptureScreenshot().
					WithCaptureBeyondViewport(true).
					WithFromSurface(true).
					WithFormat(cdppage.CaptureScreenshotFormatPng).
					Do(ctx)
				return err
			})); err != nil {
				t.Fatal(err)
			}
			clipped, err := captureFullPage(ctx)
			if err != nil {
				t.Fatal(err)
			}
			want, err := png.Decode(bytes.NewReader(baseline))
			if err != nil {
				t.Fatal(err)
			}
			got, err := png.Decode(bytes.NewReader(clipped))
			if err != nil {
				t.Fatal(err)
			}
			if got.Bounds() != want.Bounds() {
				t.Fatalf("clipped bounds %v differ from baseline %v", got.Bounds(), want.Bounds())
			}
			for y := want.Bounds().Min.Y; y < want.Bounds().Max.Y; y++ {
				for x := want.Bounds().Min.X; x < want.Bounds().Max.X; x++ {
					wr, wg, wb, wa := want.At(x, y).RGBA()
					gr, gg, gb, ga := got.At(x, y).RGBA()
					if wr != gr || wg != gg || wb != gb || wa != ga {
						t.Fatalf("clipped pixel differs from baseline at %d,%d", x, y)
					}
				}
			}
		})
	}
}
