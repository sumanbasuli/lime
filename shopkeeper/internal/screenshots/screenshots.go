package screenshots

import (
	"os"
	"path/filepath"
)

const DefaultBaseDir = "/app/screenshots"

// BaseDir is the physical screenshot root. Docker/Fly use the default path;
// native installs should set SHOPKEEPER_SCREENSHOT_DIR.
func BaseDir() string {
	for _, key := range []string{"SHOPKEEPER_SCREENSHOT_DIR", "LIME_SCREENSHOT_DIR"} {
		if value := os.Getenv(key); value != "" {
			return filepath.Clean(value)
		}
	}

	return DefaultBaseDir
}

func ScanDir(scanID string) string {
	return filepath.Join(BaseDir(), scanID)
}

// EnsureScanDir creates a scan's screenshot directory for the Shopkeeper process only.
func EnsureScanDir(scanID string) error {
	return os.MkdirAll(ScanDir(scanID), 0700)
}

// WriteFile creates new screenshot images with service-only permissions.
func WriteFile(path string, data []byte) error {
	return os.WriteFile(path, data, 0600)
}

func FilePath(scanID, filename string) string {
	return filepath.Join(ScanDir(scanID), filename)
}

// StoredPath is intentionally stable so existing UI/report code does not need
// to know the physical screenshot directory for the current deployment.
func StoredPath(scanID, filename string) string {
	return filepath.Join(DefaultBaseDir, scanID, filename)
}
