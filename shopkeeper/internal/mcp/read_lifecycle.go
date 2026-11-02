package mcp

import (
	"context"
	"net/http"
	"time"
)

// Encoding and a slow HTTP reader must share admission with database work.
var nativeReadSlots = make(chan struct{}, 2)

type readLifecycleKey struct{}
type readLifecycle struct {
	cleanup     func() time.Time
	cancel      context.CancelFunc
	release     func()
	retainUntil time.Time
	busy        bool
}

func (state *readLifecycle) begin(ctx context.Context, repo Repository) (context.Context, bool, error) {
	select {
	case nativeReadSlots <- struct{}{}:
		state.release = func() { <-nativeReadSlots }
	default:
		state.busy = true
		return ctx, false, nil
	}
	ctx, state.cancel = context.WithTimeout(ctx, 30*time.Second)
	var err error
	ctx, state.cleanup, err = repo.BeginMCPRead(ctx)
	return ctx, true, err
}

func (state *readLifecycle) finishRead() {
	if state.cleanup != nil {
		state.retainUntil = state.cleanup()
		state.cleanup = nil
	}
	if state.cancel != nil {
		state.cancel()
		state.cancel = nil
	}
}

func (state *readLifecycle) finish() {
	state.finishRead()
	if release := state.release; release != nil {
		state.release = nil
		if remaining := time.Until(state.retainUntil); remaining > 0 {
			time.AfterFunc(remaining, release)
		} else {
			release()
		}
	}
}

func finishReadDelivery(w http.ResponseWriter) func() {
	controller := http.NewResponseController(w)
	// net/http supports this; custom adapters must preserve ResponseController.
	_ = controller.SetWriteDeadline(time.Now().Add(30 * time.Second))
	return func() { _ = controller.Flush(); _ = controller.SetWriteDeadline(time.Time{}) }
}

func readToolError(message string, status int, retry bool) map[string]any {
	result := toolError(message)
	data := map[string]any{"http_status": status}
	if retry {
		data["retry_after_seconds"] = 1
	}
	result["structuredContent"] = data
	return result
}
