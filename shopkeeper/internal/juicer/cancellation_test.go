package juicer

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/chromedp/chromedp"
)

func TestBrowserCancelBeforeAllocationIsOneShot(t *testing.T) {
	_, rawCancel := chromedp.NewContext(context.Background())
	cancel := onceBrowserCancel(rawCancel)
	done := make(chan struct{})
	go func() {
		cancel()
		cancel()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("second browser cancellation blocked before allocation")
	}
}

func TestShouldTreatAsCanceledUsesParentRunState(t *testing.T) {
	activeRun := context.Background()
	canceledRun, cancel := context.WithCancel(activeRun)
	cancel()
	expiredRun, expire := context.WithDeadline(activeRun, time.Now().Add(-time.Second))
	defer expire()
	expiredPage, expirePage := context.WithDeadline(activeRun, time.Now().Add(-time.Second))
	defer expirePage()
	startupErr := fmt.Errorf("browser startup: %w", errors.New("chrome failed to start:\n[182:295:ERROR:dbus/bus.cc:405] Failed to connect to the bus"))
	if errors.Is(startupErr, context.Canceled) || errors.Is(startupErr, context.DeadlineExceeded) {
		t.Fatal("regression fixture must reproduce Chromium's lost cancellation cause")
	}

	for _, test := range []struct {
		name string
		run  context.Context
		err  error
		want bool
	}{
		{"wrapped startup after pause", canceledRun, startupErr, true},
		{"blank startup after pause", canceledRun, errors.New("chrome failed to start:\n"), true},
		{"parent deadline with lost cause", expiredRun, startupErr, true},
		{"explicit canceled cause", canceledRun, fmt.Errorf("navigate: %w", context.Canceled), true},
		{"startup genuinely failed while active", activeRun, startupErr, false},
		{"navigation genuinely failed while active", activeRun, errors.New("net::ERR_CONNECTION_REFUSED"), false},
		{"local page deadline while parent active", activeRun, expiredPage.Err(), false},
		{"wrapped local page deadline while parent active", activeRun, fmt.Errorf("navigate: %w", expiredPage.Err()), false},
		{"local cancellation while parent active", activeRun, context.Canceled, false},
		{"completed result after pause", canceledRun, nil, false},
		{"completed result while active", activeRun, nil, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := shouldTreatAsCanceled(test.run, test.err); got != test.want {
				t.Fatalf("canceled = %v, want %v (run error=%v, operation error=%v)", got, test.want, test.run.Err(), test.err)
			}
		})
	}
}
