package viewport

import (
	"fmt"
	"slices"
	"strings"
)

const DefaultPreset = "desktop"

type Settings struct {
	Preset string
	Width  int
	Height int
}

var presets = map[string]Settings{
	"desktop": {
		Preset: "desktop",
		Width:  1440,
		Height: 900,
	},
	"laptop": {
		Preset: "laptop",
		Width:  1280,
		Height: 800,
	},
	"tablet": {
		Preset: "tablet",
		Width:  768,
		Height: 1024,
	},
	"mobile": {
		Preset: "mobile",
		Width:  390,
		Height: 844,
	},
}

func ResolvePreset(key string) (Settings, error) {
	normalized := strings.ToLower(strings.TrimSpace(key))
	if normalized == "" {
		return presets[DefaultPreset], nil
	}

	settings, ok := presets[normalized]
	if !ok {
		return Settings{}, fmt.Errorf("unsupported viewport preset %q", key)
	}

	return settings, nil
}

func SettingsFromStored(preset string, width, height int) Settings {
	settings, err := ResolvePreset(preset)
	if err != nil {
		settings = presets[DefaultPreset]
	}

	if width > 0 {
		settings.Width = width
	}
	if height > 0 {
		settings.Height = height
	}

	return settings
}

func ValidPresetKeys() []string {
	keys := make([]string, 0, len(presets))
	for key := range presets {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	return keys
}
