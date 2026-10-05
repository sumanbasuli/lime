package juicer

import (
	"reflect"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
)

func TestProgressRejectsOutOfOrderCounts(t *testing.T) {
	var persisted []int
	progress := synchronizedProgress(func(count int) {
		persisted = append(persisted, count)
	})
	for _, count := range []int{1, 8, 7, 8} {
		progress(count)
	}
	if !reflect.DeepEqual(persisted, []int{1, 8}) {
		t.Fatalf("progress must not regress after a later worker finishes: %v", persisted)
	}
}

func TestProgressSerializesConcurrentCallbacks(t *testing.T) {
	var active atomic.Int32
	var overlapping atomic.Bool
	var persisted []int
	progress := synchronizedProgress(func(count int) {
		if active.Add(1) != 1 {
			overlapping.Store(true)
		}
		runtime.Gosched()
		persisted = append(persisted, count)
		active.Add(-1)
	})
	var workers sync.WaitGroup
	start := make(chan struct{})
	for count := 1; count <= 100; count++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			<-start
			progress(count)
		}()
	}
	close(start)
	workers.Wait()
	if overlapping.Load() {
		t.Fatal("progress callbacks ran concurrently")
	}
	for index := 1; index < len(persisted); index++ {
		if persisted[index] <= persisted[index-1] {
			t.Fatalf("persisted progress regressed: %v", persisted)
		}
	}
	if len(persisted) == 0 || persisted[len(persisted)-1] != 100 {
		t.Fatalf("expected final progress 100, got %v", persisted)
	}
}
