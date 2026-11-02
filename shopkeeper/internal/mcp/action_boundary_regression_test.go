package mcp

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestMCPActionReplayNullSavedResponseFailsClosed(t *testing.T) {
	r := newActionRepository()
	calls := 0
	s := New(r, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		writeJSON(w, http.StatusCreated, map[string]any{"id": testScanID})
	}))
	args := `{"request_id":"` + testRequestID + `","sitemap_url":"https://example.test"}`
	if result := callAction(t, s, "create_scan", args); result["isError"] == true {
		t.Fatalf("could not seed action: %v", result)
	}
	saved := []byte("null")
	r.entries[testRequestID].Response = append([]byte(nil), saved...)

	defer func() {
		if value := recover(); value != nil {
			t.Errorf("null saved response panicked during replay: %v", value)
		}
		if calls != 1 {
			t.Errorf("null replay reran action: calls=%d", calls)
		}
		if string(r.entries[testRequestID].Response) != string(saved) {
			t.Error("null replay changed permanent ledger bytes")
		}
	}()
	result := callAction(t, s, "create_scan", args)
	if result["isError"] != true || len(resultText(result)) > 1024 {
		t.Fatalf("null saved response was not a small error: %v", result)
	}
}

func TestMCPActionReplayOversizeProjectionAndConflictFirst(t *testing.T) {
	r := newActionRepository()
	calls := 0
	s := New(r, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		writeJSON(w, http.StatusCreated, map[string]any{"id": testScanID})
	}))
	args := `{"request_id":"` + testRequestID + `","sitemap_url":"https://example.test"}`
	callAction(t, s, "create_scan", args)
	original := append([]byte(nil), r.entries[testRequestID].Response...)
	r.entries[testRequestID].Response = nil
	r.entries[testRequestID].ResponseTooLarge = true

	conflict := callAction(t, s, "create_scan", `{"request_id":"`+testRequestID+`","sitemap_url":"https://different.test"}`)
	if conflict["isError"] != true || !strings.Contains(resultText(conflict), "different") {
		t.Fatalf("oversized ID hid argument conflict: %v", conflict)
	}
	replay := callAction(t, s, "create_scan", args)
	if replay["isError"] != true || len(resultText(replay)) > 1024 {
		t.Fatalf("oversized saved response escaped as replay: %v", replay)
	}
	if !strings.Contains(strings.ToLower(resultText(replay)), "large") {
		t.Fatalf("oversized saved response lacks clear size error: %v", replay)
	}
	if calls != 1 || len(r.entries[testRequestID].Response) != 0 || !r.entries[testRequestID].ResponseTooLarge {
		t.Fatalf("oversized replay reran or rewrote action: calls=%d entry=%+v", calls, r.entries[testRequestID])
	}
	if len(original) == 0 {
		t.Fatal("seeded result was empty")
	}
}

func TestMCPActionReplayNestedSavedResponseIsBounded(t *testing.T) {
	r := newActionRepository()
	calls := 0
	s := New(r, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		writeJSON(w, http.StatusCreated, map[string]any{"id": testScanID})
	}))
	args := `{"request_id":"` + testRequestID + `","sitemap_url":"https://example.test"}`
	callAction(t, s, "create_scan", args)
	const depth = 1600
	nested := strings.Repeat(`{"x":`, depth) + "1" + strings.Repeat("}", depth)
	saved := []byte(`{"action":"create_scan","http_status":201,"data":` + nested + `,"request_id":"` + testRequestID + `","replayed":false}`)
	if len(saved) > 32<<10 {
		t.Fatalf("fixture is not compact: %d bytes", len(saved))
	}
	r.entries[testRequestID].Response = append([]byte(nil), saved...)

	result := callAction(t, s, "create_scan", args)
	if result["isError"] != true || len(resultText(result)) > 1024 {
		t.Fatalf("compact nested replay expanded into %d bytes of text", len(resultText(result)))
	}
	if calls != 1 || string(r.entries[testRequestID].Response) != string(saved) {
		t.Fatal("nested replay reran action or changed permanent ledger bytes")
	}
}

func TestMCPActionSmallReplayStillWorksAfterBound(t *testing.T) {
	r := newActionRepository()
	calls := 0
	s := New(r, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		writeJSON(w, http.StatusCreated, map[string]any{"id": testScanID})
	}))
	args := `{"request_id":"` + testRequestID + `","sitemap_url":"https://example.test"}`
	first := callAction(t, s, "create_scan", args)
	saved := append([]byte(nil), r.entries[testRequestID].Response...)
	replay := callAction(t, s, "create_scan", args)
	if first["isError"] == true || replay["isError"] == true || replay["structuredContent"].(map[string]any)["replayed"] != true || calls != 1 {
		t.Fatalf("small result did not replay without rerunning: calls=%d result=%v", calls, replay)
	}
	if string(r.entries[testRequestID].Response) != string(saved) {
		t.Fatal("small replay rewrote permanent ledger")
	}
}

func TestActionJSONFitsBoundsActualToolEncoding(t *testing.T) {
	const depth = 1600
	var nested any = 1
	for i := 0; i < depth; i++ {
		nested = map[string]any{"x": nested}
	}
	cases := []struct {
		name string
		data any
	}{
		{"empty object", map[string]any{}},
		{"empty array", []any{}},
		{"mixed containers", []any{map[string]any{"a": []any{1, true, nil}}, map[string]any{}}},
		{"plain long string", strings.Repeat("a", 1<<20)},
		{"escaped long string", strings.Repeat("\"\\", 250000)},
		{"unicode and controls", strings.Repeat("é\n\t\"\\", 10000)},
		{"deep nesting", nested},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			payload := map[string]any{"http_status": http.StatusOK, "data": tc.data}
			compact, err := json.Marshal(payload)
			if err != nil {
				t.Fatal(err)
			}
			fits := actionJSONFits(compact)
			result := actionResult(payload)
			encoded, err := json.Marshal(result)
			if err != nil {
				t.Fatal(err)
			}
			if fits && (result["isError"] == true || len(encoded) > maxActionToolBytes) {
				t.Fatalf("estimator admitted an oversized or rejected tool result: compact=%d wire=%d", len(compact), len(encoded))
			}
			if !fits && (result["isError"] != true || len(encoded) > 2048) {
				t.Fatalf("estimator rejection did not produce a small error: compact=%d wire=%d", len(compact), len(encoded))
			}
		})
	}
}
