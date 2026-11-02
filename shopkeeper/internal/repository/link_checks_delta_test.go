package repository

import (
	"encoding/json"
	"testing"

	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
)

func TestEncodeLinkSourceDeltaBoundsHotTargetWriteVolume(t *testing.T) {
	const pages, referencesPerPage = 500, 19
	result := models.LinkResult{TargetURL: "https://example.test/shared", Sources: make([]models.LinkSource, 0, pages*referencesPerPage)}
	persistedCount := 0
	encodedSources := 0
	for page := 0; page < pages; page++ {
		for ref := 0; ref < referencesPerPage; ref++ {
			result.Sources = append(result.Sources, models.LinkSource{PageURL: "https://example.test/page", Element: "a", Attribute: "href"})
		}
		result.OccurrenceCount = len(result.Sources)
		encoded, err := encodeLinkSourceDelta(result, persistedCount)
		if err != nil {
			t.Fatal(err)
		}
		var delta []models.LinkSource
		if err := json.Unmarshal(encoded, &delta); err != nil {
			t.Fatal(err)
		}
		if len(delta) != referencesPerPage {
			t.Fatalf("page %d encoded %d sources, want %d", page, len(delta), referencesPerPage)
		}
		encodedSources += len(delta)
		persistedCount = result.OccurrenceCount
	}
	if encodedSources != pages*referencesPerPage {
		t.Fatalf("encoded %d sources, want only the %d new sources", encodedSources, pages*referencesPerPage)
	}
	// Encoding the complete growing prefix on every publication would pass
	// 2,379,750 source objects through JSON and the database for this case.
	fullPrefixVolume := referencesPerPage * pages * (pages + 1) / 2
	if fullPrefixVolume < 200*encodedSources {
		t.Fatalf("hot-target fixture no longer exercises substantial amplification: %d", fullPrefixVolume)
	}
	replayed, err := encodeLinkSourceDelta(result, persistedCount)
	if err != nil || string(replayed) != "[]" {
		t.Fatalf("replay must be empty, got %s (%v)", replayed, err)
	}
}

func TestEncodeLinkSourceDeltaRejectsInvalidPrefix(t *testing.T) {
	result := models.LinkResult{TargetURL: "https://example.test/shared", OccurrenceCount: 1}
	if _, err := encodeLinkSourceDelta(result, 0); err == nil {
		t.Fatal("mismatched occurrence count and source list accepted")
	}
	result.OccurrenceCount = 0
	if _, err := encodeLinkSourceDelta(result, 1); err == nil {
		t.Fatal("older incoming source prefix accepted")
	}
}
