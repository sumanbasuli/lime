package mcp

import (
	"context"
	"time"
)

var nativeActionSlots = make(chan struct{}, 2)

type actionLifecycleKey struct{}

// Actions share the read lifecycle's cleanup and delivery lease, but must not
// hold a read-only transaction across mutations or compete for read slots.
type actionLifecycle struct{ readLifecycle }

func (state *actionLifecycle) begin(ctx context.Context, repo Repository) (context.Context, bool, error) {
	select {
	case nativeActionSlots <- struct{}{}:
		state.release = func() { <-nativeActionSlots }
	default:
		state.busy = true
		return ctx, false, nil
	}
	ctx, state.cancel = context.WithTimeout(ctx, 30*time.Second)
	var err error
	ctx, state.cleanup, err = repo.BeginMCPActionCall(ctx)
	return ctx, true, err
}
