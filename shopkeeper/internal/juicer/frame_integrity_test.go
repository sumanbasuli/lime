package juicer

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/chromedp/cdproto/cdp"
	cdppage "github.com/chromedp/cdproto/page"
	"github.com/chromedp/cdproto/runtime"
	cdptarget "github.com/chromedp/cdproto/target"
	"github.com/chromedp/chromedp"
	"github.com/sumanbasuli/lime/shopkeeper/internal/viewport"
)

func TestIsolatedAxeFramesIgnorePageOwnedResults(t *testing.T) {
	chromePath := os.Getenv("LIME_TEST_CHROME")
	if chromePath == "" {
		t.Skip("set LIME_TEST_CHROME to a local Chrome binary")
	}
	for _, tc := range []struct {
		name              string
		label             string
		check             string
		wantFail          bool
		crossOrigin       bool
		nested            bool
		nestedCrossOrigin bool
		reverseTargets    bool
	}{
		{"forged failure ignored", "Real label", "false", false, false, false, false, false},
		{"forged pass ignored", "", "true", true, false, false, false, false},
		{"genuine child failure", "", "", true, false, false, false, false},
		{"cross origin child failure", "", "", true, true, false, false, false},
		{"nested same process under cross origin", "", "", true, true, true, false, false},
		{"nested out of process under cross origin", "", "", true, true, true, true, false},
		{"reversed nested out of process targets", "", "", true, true, true, true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var server *httptest.Server
			server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/axe.js":
					w.Header().Set("Content-Type", "application/javascript")
					_, _ = w.Write([]byte(axeMinJS))
				case "/child", "/grandchild":
					w.Header().Set("Content-Type", "text/html")
					if tc.nested && r.URL.Path == "/child" {
						grandchildURL := "/grandchild"
						if tc.nestedCrossOrigin {
							grandchildURL = server.URL + "/grandchild"
						}
						_, _ = fmt.Fprintf(w, `<!doctype html><html lang="en"><title>middle</title><body><iframe title="grandchild" src="%s"></iframe></body></html>`, grandchildURL)
						return
					}
					check := ""
					if tc.check != "" {
						check = fmt.Sprintf(",checks:[{id:'button-has-visible-text',evaluate:function(){return %s}}]", tc.check)
					}
					_, _ = fmt.Fprintf(w, `<!doctype html><html lang="en"><title>child</title><body><button id="victim">%s</button><script src="/axe.js"></script><script>axe.configure({branding:{application:'lime-lighthouse-aligned'}%s});window.childReady=true;</script></body></html>`, tc.label, check)
				default:
					w.Header().Set("Content-Type", "text/html")
					childURL := "/child"
					if tc.crossOrigin {
						childURL = strings.Replace(server.URL, "127.0.0.1", "localhost", 1) + "/child"
					}
					_, _ = fmt.Fprintf(w, `<!doctype html><html lang="en"><title>parent</title><body><iframe title="child" src="%s"></iframe></body></html>`, childURL)
				}
			}))
			defer server.Close()

			allocCtx, cancelAlloc := chromedp.NewExecAllocator(context.Background(), append(chromedp.DefaultExecAllocatorOptions[:], chromedp.ExecPath(chromePath))...)
			defer cancelAlloc()
			browserCtx, cancelBrowser := chromedp.NewContext(allocCtx)
			defer cancelBrowser()
			ctx, cancelTimeout := context.WithTimeout(browserCtx, 20*time.Second)
			defer cancelTimeout()
			tracker := &frameTopologyTracker{}
			tracker.watchTarget(ctx)
			tracker.watchBrowser(ctx)
			worldEvents := make(chan *runtime.ExecutionContextDescription, 128)
			chromedp.ListenTarget(ctx, func(event any) {
				created, ok := event.(*runtime.EventExecutionContextCreated)
				if ok && created.Context != nil && created.Context.Name == "lime-axe" {
					select {
					case worldEvents <- created.Context:
					default:
					}
				}
			})
			if err := chromedp.Run(ctx, chromedp.Navigate(server.URL), chromedp.WaitReady("iframe")); err != nil {
				t.Fatal(err)
			}
			if !tc.crossOrigin {
				if err := chromedp.Run(ctx, chromedp.Evaluate(`new Promise((resolve) => { const ready = () => { const f = document.querySelector('iframe'); if (f.contentWindow && f.contentWindow.childReady) resolve(true); else setTimeout(ready, 10); }; ready(); })`, nil, func(p *runtime.EvaluateParams) *runtime.EvaluateParams { return p.WithAwaitPromise(true) })); err != nil {
					t.Fatal(err)
				}
			}
			if err := waitForPageSettle(ctx); err != nil {
				t.Fatal(err)
			}
			frameRevision := tracker.revision.Load()
			var topID runtime.ExecutionContextID
			if err := chromedp.Run(ctx, chromedp.ActionFunc(func(actionCtx context.Context) error {
				tree, err := cdppage.GetFrameTree().Do(actionCtx)
				if err != nil {
					return err
				}
				topID, err = cdppage.CreateIsolatedWorld(tree.Frame.ID).WithWorldName("lime-axe").Do(actionCtx)
				return err
			})); err != nil {
				t.Fatal(err)
			}
			var topUnique string
			select {
			case world := <-worldEvents:
				if world.ID != topID {
					t.Fatalf("unexpected top context %d, want %d", world.ID, topID)
				}
				topUnique = world.UniqueID
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			script, err := lighthouseAxeRunScript()
			if err != nil {
				t.Fatal(err)
			}
			var raw string
			if err := chromedp.Run(ctx,
				chromedp.Evaluate(axeMinJS, nil, func(p *runtime.EvaluateParams) *runtime.EvaluateParams { return p.WithUniqueContextID(topUnique) }),
				chromedp.Evaluate(script, &raw, func(p *runtime.EvaluateParams) *runtime.EvaluateParams {
					return p.WithUniqueContextID(topUnique).WithAwaitPromise(true)
				}),
			); err != nil {
				t.Fatal(err)
			}
			var result axeResult
			if err := json.Unmarshal([]byte(raw), &result); err != nil {
				t.Fatal(err)
			}
			if tc.reverseTargets {
				var infos []*cdptarget.Info
				if err := chromedp.Run(ctx, chromedp.ActionFunc(func(actionCtx context.Context) error {
					var err error
					infos, err = cdptarget.GetTargets().Do(cdp.WithExecutor(actionCtx, chromedp.FromContext(actionCtx).Browser))
					return err
				})); err != nil {
					t.Fatal(err)
				}
				iframeInfos := make([]*cdptarget.Info, 0, 2)
				for _, info := range infos {
					if info.Type == "iframe" {
						iframeInfos = append(iframeInfos, info)
					}
				}
				if len(iframeInfos) != 2 {
					t.Fatalf("expected two OOPIF targets, got %d", len(iframeInfos))
				}
				sort.SliceStable(iframeInfos, func(i, j int) bool {
					return strings.Contains(iframeInfos[i].URL, "/grandchild")
				})
				usedRawBytes := len(raw)
				if err := auditSameProcessFrames(ctx, topID, worldEvents, script, &usedRawBytes, nil, &result); err != nil {
					t.Fatal(err)
				}
				if err := auditOOPIFTargets(ctx, topID, script, &usedRawBytes, &result, iframeInfos, tracker); err != nil {
					t.Fatal(err)
				}
			} else if err := auditChildFrames(ctx, topID, worldEvents, script, len(raw), &result, tracker); err != nil {
				t.Fatal(err)
			}
			if tracker.revision.Load() != frameRevision {
				t.Fatal("stable frame topology changed during isolated axe audit")
			}
			var failed bool
			for _, rule := range result.Violations {
				if rule.ID == "button-name" {
					failed = true
					wantTarget := []string{"iframe", "#victim"}
					if tc.nested {
						wantTarget = []string{"iframe", "iframe", "#victim"}
					}
					if len(rule.Nodes) != 1 || strings.Join(rule.Nodes[0].Target, "/") != strings.Join(wantTarget, "/") {
						t.Fatalf("unexpected child target: %+v", rule.Nodes)
					}
				}
			}
			if failed != tc.wantFail {
				t.Fatalf("button-name failure = %t, want %t; result = %+v", failed, tc.wantFail, result)
			}
			if !failed {
				passed := false
				for _, id := range result.Passes {
					passed = passed || strings.EqualFold(id.ID, "button-name")
				}
				if !passed {
					t.Fatal("labeled child button did not pass button-name")
				}
			}
		})
	}
}

func TestChildFrameNodeDoesNotCaptureIframeAsElement(t *testing.T) {
	child := axeResult{Violations: []Violation{{ID: "button-name", Nodes: []Node{{HTML: "<button></button>", Target: []string{"#victim"}}}}}}
	prefixAxeTargets(&child, []string{"iframe"})
	node := &child.Violations[0].Nodes[0]
	if !node.CaptureSuppressed || strings.Join(node.Target, "/") != "iframe/#victim" {
		t.Fatalf("child target was not marked for screenshot suppression: %+v", node)
	}
	if selectors := uniqueCaptureSelectors(child.Violations); len(selectors) != 0 {
		t.Fatalf("child selector was sent to top-frame capture matching: %v", selectors)
	}
	captureViolationNodeScreenshots(context.Background(), child.Violations, "scan", t.TempDir(), PageInput{}, 0, nil, nil, true)
	if node.ElementScreenshotPath != "" || strings.Contains(node.HTML, screenshotBudgetWarning) || !strings.Contains(node.HTML, frameScreenshotWarning) {
		t.Fatalf("child node received misleading screenshot evidence: %+v", node)
	}
	top := axeResult{Violations: []Violation{{ID: "button-name", Nodes: []Node{{Target: []string{"#top"}}}}}}
	if top.Violations[0].Nodes[0].CaptureSuppressed || len(uniqueCaptureSelectors(top.Violations)) != 1 {
		t.Fatal("top-level screenshot matching changed")
	}
}

func TestFrameTopologyTrackerDetectsLateFrame(t *testing.T) {
	chromePath := os.Getenv("LIME_TEST_CHROME")
	if chromePath == "" {
		t.Skip("set LIME_TEST_CHROME to a local Chrome binary")
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		if r.URL.Path == "/child" {
			_, _ = w.Write([]byte(`<!doctype html><html lang="en"><title>child</title><body>child</body></html>`))
			return
		}
		_, _ = w.Write([]byte(`<!doctype html><html lang="en"><title>parent</title><body>parent</body></html>`))
	}))
	defer server.Close()
	allocCtx, cancelAlloc := chromedp.NewExecAllocator(context.Background(), append(chromedp.DefaultExecAllocatorOptions[:], chromedp.ExecPath(chromePath))...)
	defer cancelAlloc()
	browserCtx, cancelBrowser := chromedp.NewContext(allocCtx)
	defer cancelBrowser()
	ctx, cancelTimeout := context.WithTimeout(browserCtx, 10*time.Second)
	defer cancelTimeout()
	tracker := &frameTopologyTracker{}
	tracker.watchTarget(ctx)
	tracker.watchBrowser(ctx)
	if err := chromedp.Run(ctx, chromedp.Navigate(server.URL)); err != nil {
		t.Fatal(err)
	}
	baseline := tracker.revision.Load()
	if err := chromedp.Run(ctx, chromedp.Evaluate(`(() => { const frame = document.createElement('iframe'); frame.src = '/child'; document.body.appendChild(frame); return true; })()`, nil)); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for tracker.revision.Load() == baseline && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if tracker.revision.Load() == baseline {
		t.Fatal("late same-process iframe did not invalidate the audit")
	}
	baseline = tracker.revision.Load()
	crossOriginURL := strings.Replace(server.URL, "127.0.0.1", "localhost", 1) + "/child"
	if err := chromedp.Run(ctx, chromedp.Evaluate(fmt.Sprintf(`(() => { const frame = document.createElement('iframe'); frame.src = %q; document.body.appendChild(frame); return true; })()`, crossOriginURL), nil)); err != nil {
		t.Fatal(err)
	}
	deadline = time.Now().Add(2 * time.Second)
	for tracker.revision.Load() == baseline && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if tracker.revision.Load() == baseline {
		t.Fatal("late out-of-process iframe did not invalidate the audit")
	}
	seenOOPIF := false
	for time.Now().Before(deadline) {
		tracker.mu.Lock()
		for _, targetURL := range tracker.targets {
			seenOOPIF = seenOOPIF || targetURL == crossOriginURL
		}
		tracker.mu.Unlock()
		if seenOOPIF {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !seenOOPIF {
		t.Fatal("browser OOPIF target event was not tracked")
	}
}

func TestScanSinglePageFrameIntegrity(t *testing.T) {
	if os.Getenv("LIME_TEST_CHROME") == "" {
		t.Skip("set LIME_TEST_CHROME to a local Chrome binary")
	}
	for _, tc := range []struct {
		name string
		mode string
	}{
		{"stable same-origin frame", "same"},
		{"stable opaque-origin frame", "opaque"},
		{"late inserted frame", "late"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/html")
				if r.URL.Path == "/child" {
					_, _ = w.Write([]byte(`<!doctype html><html lang="en"><title>child</title><body><button id="victim"></button></body></html>`))
					return
				}
				switch tc.mode {
				case "same":
					_, _ = w.Write([]byte(`<!doctype html><html lang="en"><title>parent</title><body><iframe title="child" src="/child"></iframe></body></html>`))
				case "opaque":
					_, _ = w.Write([]byte(`<!doctype html><html lang="en"><title>parent</title><body><iframe sandbox="allow-scripts" title="child" src="/child"></iframe></body></html>`))
				case "late":
					_, _ = w.Write([]byte(`<!doctype html><html lang="en"><title>parent</title><body><main>parent</main><script>setTimeout(() => { const frame = document.createElement('iframe'); frame.src = '/child'; frame.title = 'late child'; document.body.appendChild(frame); }, 500);</script></body></html>`))
				}
			}))
			defer server.Close()
			if tc.mode == "opaque" {
				chromePath := os.Getenv("LIME_TEST_CHROME")
				allocCtx, cancelAlloc := chromedp.NewExecAllocator(context.Background(), append(chromedp.DefaultExecAllocatorOptions[:], chromedp.ExecPath(chromePath))...)
				defer cancelAlloc()
				browserCtx, cancelBrowser := chromedp.NewContext(allocCtx)
				defer cancelBrowser()
				var infos []*cdptarget.Info
				if err := chromedp.Run(browserCtx, chromedp.Navigate(server.URL), chromedp.ActionFunc(func(actionCtx context.Context) error {
					var err error
					infos, err = cdptarget.GetTargets().Do(cdp.WithExecutor(actionCtx, chromedp.FromContext(actionCtx).Browser))
					return err
				})); err != nil {
					t.Fatal(err)
				}
				opaqueOOPIF := false
				for _, info := range infos {
					opaqueOOPIF = opaqueOOPIF || info.Type == "iframe" && strings.HasSuffix(info.URL, "/child")
				}
				if !opaqueOOPIF {
					t.Fatal("opaque-origin fixture did not create an OOPIF target")
				}
			}
			screenshotDir := t.TempDir()
			result := scanSinglePage(context.Background(), context.Background(), PageInput{URLID: "page", URL: server.URL}, "scan", screenshotDir, viewport.Settings{Width: 800, Height: 600}, &scanEvidenceBudget{})
			if tc.mode == "late" {
				if !strings.Contains(result.Error, "accessibility frame tree changed during audit") || result.Version != "" || len(result.Violations) != 0 || result.ScreenshotPath != "" {
					t.Fatalf("late frame retained evidence or wrong error: %+v", result)
				}
				if _, err := os.Stat(filepath.Join(screenshotDir, "page.png")); !os.IsNotExist(err) {
					t.Fatalf("late frame published screenshot: %v", err)
				}
				return
			}
			if result.Error != "" || result.Version == "" || result.ScreenshotPath == "" {
				t.Fatalf("stable frame scan failed: error=%q version=%q screenshot=%q", result.Error, result.Version, result.ScreenshotPath)
			}
			found := false
			for _, rule := range result.Violations {
				if rule.ID != "button-name" {
					continue
				}
				for _, node := range rule.Nodes {
					if len(node.Target) == 2 && node.Target[1] == "#victim" && node.ElementScreenshotPath == "" && strings.Contains(node.HTML, frameScreenshotWarning) {
						found = true
					}
				}
			}
			if !found {
				t.Fatalf("stable child issue or frame screenshot warning missing: %+v", result.Violations)
			}
		})
	}
}
