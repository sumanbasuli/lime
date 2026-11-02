package screenshots

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const DefaultBaseDir = "/app/screenshots"

var pageImageName = regexp.MustCompile(`^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_focus_[0-9]+(?:_preview)?)?\.png$`)

// BaseDir is the physical screenshot root. Docker uses the default path;
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

// PruneUnfinished removes page images whose URL did not complete. Call it after
// active capture has drained, using committed URL statuses, and before any
// unfinished URL can be retried. Unknown files are left for normal cleanup.
func PruneUnfinished(scanID string, completedURLIDs []string) error {
	keep := make(map[string]struct{}, len(completedURLIDs))
	for _, id := range completedURLIDs {
		keep[strings.ToLower(id)] = struct{}{}
	}
	dir := ScanDir(strings.ToLower(scanID))
	entries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, entry := range entries {
		match := pageImageName.FindStringSubmatch(entry.Name())
		if match == nil {
			continue
		}
		if _, ok := keep[match[1]]; ok {
			continue
		}
		if err := os.Remove(filepath.Join(dir, entry.Name())); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}
