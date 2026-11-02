package screenshots

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPruneUnfinishedKeepsCompletedPageImages(t *testing.T) {
	t.Setenv("SHOPKEEPER_SCREENSHOT_DIR", filepath.Join(t.TempDir(), "screenshots"))
	const scanID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	const doneID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	const pendingID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
	if err := EnsureScanDir(scanID); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{
		doneID + ".png", doneID + "_focus_0.png", doneID + "_focus_0_preview.png",
		pendingID + ".png", pendingID + "_focus_1.png", pendingID + "_focus_1_preview.png",
		pendingID + "_focus_x_preview.png", pendingID + "_focus_1_preview.jpg", "unrelated.png",
	} {
		if err := WriteFile(FilePath(scanID, name), []byte(name)); err != nil {
			t.Fatal(err)
		}
	}
	if err := PruneUnfinished(scanID, []string{doneID}); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{doneID + ".png", doneID + "_focus_0.png", doneID + "_focus_0_preview.png", pendingID + "_focus_x_preview.png", pendingID + "_focus_1_preview.jpg", "unrelated.png"} {
		if _, err := os.Stat(FilePath(scanID, name)); err != nil {
			t.Fatalf("retained file %q: %v", name, err)
		}
	}
	for _, name := range []string{pendingID + ".png", pendingID + "_focus_1.png", pendingID + "_focus_1_preview.png"} {
		if _, err := os.Stat(FilePath(scanID, name)); !os.IsNotExist(err) {
			t.Fatalf("unfinished file %q remains: %v", name, err)
		}
	}
	if err := PruneUnfinished(scanID, []string{doneID}); err != nil {
		t.Fatalf("repeat pruning: %v", err)
	}
}
