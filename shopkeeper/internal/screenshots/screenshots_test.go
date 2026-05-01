package screenshots

import (
	"path/filepath"
	"testing"
)

func TestBaseDirUsesShopkeeperScreenshotDir(t *testing.T) {
	t.Setenv("SHOPKEEPER_SCREENSHOT_DIR", "/opt/lime/shopkeeper/screenshots")
	t.Setenv("LIME_SCREENSHOT_DIR", "/tmp/ignored")

	if got := BaseDir(); got != "/opt/lime/shopkeeper/screenshots" {
		t.Fatalf("BaseDir() = %q, want /opt/lime/shopkeeper/screenshots", got)
	}
}

func TestStoredPathStaysCanonical(t *testing.T) {
	got := StoredPath("scan-id", "page.png")
	want := filepath.Join(DefaultBaseDir, "scan-id", "page.png")

	if got != want {
		t.Fatalf("StoredPath() = %q, want %q", got, want)
	}
}
