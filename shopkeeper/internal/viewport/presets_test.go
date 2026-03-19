package viewport

import (
	"reflect"
	"testing"
)

func TestResolvePresetDefaultsToDesktop(t *testing.T) {
	settings, err := ResolvePreset("")
	if err != nil {
		t.Fatalf("resolve preset: %v", err)
	}

	if settings.Preset != "desktop" || settings.Width != 1440 || settings.Height != 900 {
		t.Fatalf("unexpected default settings: %+v", settings)
	}
}

func TestResolvePresetAcceptsKnownPreset(t *testing.T) {
	settings, err := ResolvePreset("tablet")
	if err != nil {
		t.Fatalf("resolve preset: %v", err)
	}

	if settings.Preset != "tablet" || settings.Width != 768 || settings.Height != 1024 {
		t.Fatalf("unexpected tablet settings: %+v", settings)
	}
}

func TestResolvePresetRejectsUnknownPreset(t *testing.T) {
	if _, err := ResolvePreset("cinema"); err == nil {
		t.Fatal("expected unknown preset to fail")
	}
}

func TestSettingsFromStoredPreservesKnownDimensions(t *testing.T) {
	settings := SettingsFromStored("desktop", 1600, 1000)
	if settings.Preset != "desktop" || settings.Width != 1600 || settings.Height != 1000 {
		t.Fatalf("unexpected stored settings: %+v", settings)
	}
}

func TestValidPresetKeys(t *testing.T) {
	expected := []string{"desktop", "laptop", "mobile", "tablet"}
	if actual := ValidPresetKeys(); !reflect.DeepEqual(actual, expected) {
		t.Fatalf("unexpected preset keys: %v", actual)
	}
}
