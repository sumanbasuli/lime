package repository

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
)

func TestMCPScreenshotPublicURLs(t *testing.T) {
	for _, test := range []struct{ stored, public string }{
		{"/app/screenshots/" + mcpScanID + "/page.png", "/api/screenshots/" + mcpScanID + "/page.png"},
		{"/app/screenshots/" + mcpScanID + "/element.png", "/api/screenshots/" + mcpScanID + "/element.png"},
		{"/legacy/screenshots/screenshot name.png", "/api/screenshots/" + mcpScanID + "/screenshot%20name.png"},
	} {
		got := mcpScreenshotURL(strings.ToUpper(mcpScanID), &test.stored)
		if got == nil || *got != test.public {
			t.Fatalf("stored path %q: URL = %v, want %q", test.stored, got, test.public)
		}
	}
	for _, empty := range []string{"", ".", "/"} {
		if got := mcpScreenshotURL(mcpScanID, &empty); got != nil {
			t.Fatalf("missing filename %q should not yield a public URL", empty)
		}
	}
	if got := mcpScreenshotURL(mcpScanID, nil); got != nil {
		t.Fatal("nil screenshot path should not yield a public URL")
	}
}

func TestMCPScreenshotFieldsPreserveRESTSerialization(t *testing.T) {
	stored := "/app/screenshots/" + mcpScanID + "/page.png"
	occurrence := models.IssueOccurrence{ScreenshotPath: &stored}
	encoded, err := json.Marshal(occurrence)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "screenshot_url") || !strings.Contains(string(encoded), stored) {
		t.Fatal("ordinary REST occurrence serialization must retain paths without adding URL fields")
	}
	occurrence.ScreenshotURL = mcpScreenshotURL(mcpScanID, occurrence.ScreenshotPath)
	encoded, _ = json.Marshal(occurrence)
	var result map[string]any
	if err := json.Unmarshal(encoded, &result); err != nil {
		t.Fatal(err)
	}
	if result["screenshot_path"] != stored || result["screenshot_url"] != "/api/screenshots/"+mcpScanID+"/page.png" {
		t.Fatalf("MCP must retain the storage path and add a public URL: %v", result)
	}
	if _, exists := result["element_screenshot_url"]; exists {
		t.Fatal("missing optional element screenshot URL must be omitted")
	}
}
