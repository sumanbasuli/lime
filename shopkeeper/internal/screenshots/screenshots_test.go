package screenshots

import (
	"os"
	"path/filepath"
	"runtime"
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

func TestNewScreenshotFilesArePrivate(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX file modes are required for this test")
	}

	t.Setenv("SHOPKEEPER_SCREENSHOT_DIR", filepath.Join(t.TempDir(), "screenshots"))
	const scanID = "scan-1"
	if err := EnsureScanDir(scanID); err != nil {
		t.Fatal(err)
	}

	info, err := os.Stat(ScanDir(scanID))
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0700 {
		t.Fatalf("scan directory mode = %04o, want 0700", got)
	}

	for _, filename := range []string{"page.png", "page_focus_1.png", "page_focus_1_preview.png"} {
		path := FilePath(scanID, filename)
		if err := WriteFile(path, []byte("screenshot")); err != nil {
			t.Fatal(err)
		}
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if got := info.Mode().Perm(); got != 0600 {
			t.Errorf("%s mode = %04o, want 0600", filename, got)
		}
	}
}
