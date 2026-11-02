//go:build linux

package containerinit

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func rootTest(t *testing.T) {
	t.Helper()
	if os.Geteuid() != 0 {
		t.Skip("requires a disposable Linux root filesystem fixture")
	}
}

func statNode(t *testing.T, path string) unix.Stat_t {
	t.Helper()
	var st unix.Stat_t
	if err := unix.Lstat(path, &st); err != nil {
		t.Fatal(err)
	}
	return st
}

func capture(t *testing.T, root, name string, dirMode, fileMode os.FileMode) string {
	t.Helper()
	dir := filepath.Join(root, name)
	if err := os.Mkdir(dir, dirMode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, dirMode); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "page_focus_1_preview.png")
	if err := os.WriteFile(path, []byte("saved capture bytes "+name), fileMode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, fileMode); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestFreshAndLegacyOwnershipPreservesEvidence(t *testing.T) {
	rootTest(t)
	for _, mode := range []os.FileMode{0700, 0755} {
		t.Run(fmt.Sprintf("%o", mode), func(t *testing.T) {
			root := filepath.Join(t.TempDir(), "screenshots")
			if err := os.Mkdir(root, mode); err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(root, mode); err != nil {
				t.Fatal(err)
			}
			first := capture(t, root, "11111111-1111-4111-8111-111111111111", 0700, 0600)
			second := capture(t, root, "22222222-2222-4222-8222-222222222222", 0755, 0644)
			third := capture(t, root, "capturé", 0700, 0400)
			if err := unix.Chown(filepath.Dir(second), runtimeUID, runtimeGID); err != nil {
				t.Fatal(err)
			}
			if err := unix.Chown(second, runtimeUID, runtimeGID); err != nil {
				t.Fatal(err)
			}
			paths := []string{root, filepath.Dir(first), first, filepath.Dir(second), second, filepath.Dir(third), third}
			modes := map[string]uint32{}
			hashes := map[string][32]byte{}
			for _, path := range paths {
				st := statNode(t, path)
				modes[path] = st.Mode
				if st.Mode&unix.S_IFMT == unix.S_IFREG {
					data, err := os.ReadFile(path)
					if err != nil {
						t.Fatal(err)
					}
					hashes[path] = sha256.Sum256(data)
				}
			}
			if err := prepare(root, runtimeUID, runtimeGID, nil); err != nil {
				t.Fatal(err)
			}
			for _, path := range paths {
				st := statNode(t, path)
				if st.Uid != runtimeUID || st.Gid != runtimeGID || st.Mode != modes[path] {
					t.Fatalf("ownership/mode changed incorrectly at %s: %+v", path, st)
				}
				if want, ok := hashes[path]; ok {
					data, err := os.ReadFile(path)
					if err != nil || sha256.Sum256(data) != want {
						t.Fatalf("capture changed: %s %v", path, err)
					}
				}
			}
			receipt := statNode(t, filepath.Join(root, ownerMarker))
			if receipt.Uid != 0 || receipt.Gid != 0 || receipt.Mode&07777 != 0400 {
				t.Fatalf("receipt not private/root-owned: %+v", receipt)
			}
			if err := prepare(root, runtimeUID, runtimeGID, nil); err != nil {
				t.Fatal(err)
			}
			again := statNode(t, filepath.Join(root, ownerMarker))
			if again.Ino != receipt.Ino {
				t.Fatal("idempotent startup replaced the receipt")
			}
		})
	}
	parent := t.TempDir()
	root := filepath.Join(parent, "fresh")
	if err := prepare(root, runtimeUID, runtimeGID, nil); err != nil {
		t.Fatal(err)
	}
	st := statNode(t, root)
	if st.Uid != runtimeUID || st.Gid != runtimeGID || st.Mode&0777 != 0700 {
		t.Fatalf("fresh root: %+v", st)
	}
	if st := statNode(t, parent); st.Uid != 0 {
		t.Fatal("migration changed parent ownership")
	}
}

func TestUnsafeTreeFailsBeforeAnyOwnershipChange(t *testing.T) {
	rootTest(t)
	cases := map[string]func(*testing.T, string, string){
		"file symlink": func(t *testing.T, root, out string) {
			if err := os.Symlink(out, filepath.Join(root, "bad.png")); err != nil {
				t.Fatal(err)
			}
		},
		"directory symlink": func(t *testing.T, root, out string) {
			if err := os.Symlink(filepath.Dir(out), filepath.Join(root, "bad-dir")); err != nil {
				t.Fatal(err)
			}
		},
		"dangling symlink": func(t *testing.T, root, out string) {
			if err := os.Symlink(out+"missing", filepath.Join(root, "bad.png")); err != nil {
				t.Fatal(err)
			}
		},
		"hardlink": func(t *testing.T, root, out string) {
			if err := os.Link(out, filepath.Join(root, "bad.png")); err != nil {
				t.Fatal(err)
			}
		},
		"fifo": func(t *testing.T, root, out string) {
			if err := unix.Mkfifo(filepath.Join(root, "bad.png"), 0600); err != nil {
				t.Fatal(err)
			}
		},
		"foreign owner": func(t *testing.T, root, out string) {
			p := capture(t, root, "foreign", 0700, 0600)
			if err := unix.Chown(p, 12345, 12345); err != nil {
				t.Fatal(err)
			}
		},
		"setuid": func(t *testing.T, root, out string) {
			p := capture(t, root, "suid", 0700, 0600)
			if err := unix.Chmod(p, 04755); err != nil {
				t.Fatal(err)
			}
		},
		"fake receipt": func(t *testing.T, root, out string) {
			p := filepath.Join(root, ownerMarker)
			if err := os.WriteFile(p, []byte(ownerReceipt), 0400); err != nil {
				t.Fatal(err)
			}
			if err := unix.Chown(p, runtimeUID, runtimeGID); err != nil {
				t.Fatal(err)
			}
		},
		"fifo receipt": func(t *testing.T, root, out string) {
			if err := unix.Mkfifo(filepath.Join(root, ownerMarker), 0400); err != nil {
				t.Fatal(err)
			}
		},
	}
	for name, makeBad := range cases {
		t.Run(name, func(t *testing.T) {
			parent := t.TempDir()
			root := filepath.Join(parent, "screenshots")
			if err := os.Mkdir(root, 0700); err != nil {
				t.Fatal(err)
			}
			safe := capture(t, root, "safe", 0700, 0600)
			out := filepath.Join(parent, "outside")
			if err := os.WriteFile(out, []byte("never modify outside"), 0600); err != nil {
				t.Fatal(err)
			}
			makeBad(t, root, out)
			start := time.Now()
			if err := prepare(root, runtimeUID, runtimeGID, nil); err == nil {
				t.Fatal("unsafe tree accepted")
			}
			if time.Since(start) > time.Second {
				t.Fatal("unsafe entry blocked instead of failing promptly")
			}
			for _, path := range []string{root, filepath.Dir(safe), safe, out} {
				if st := statNode(t, path); st.Uid != 0 || st.Gid != 0 {
					t.Fatalf("failed validation changed ownership of %s", path)
				}
			}
		})
	}
}

func TestRootAndParentSymlinksAreRejected(t *testing.T) {
	rootTest(t)
	parent := t.TempDir()
	real := filepath.Join(parent, "real")
	if err := os.Mkdir(real, 0700); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(real, "screenshots")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(parent, "alias")
	if err := os.Symlink(real, alias); err != nil {
		t.Fatal(err)
	}
	if err := prepare(filepath.Join(alias, "screenshots"), runtimeUID, runtimeGID, nil); err == nil {
		t.Fatal("parent symlink accepted")
	}
	final := filepath.Join(parent, "root-link")
	if err := os.Symlink(root, final); err != nil {
		t.Fatal(err)
	}
	if err := prepare(final, runtimeUID, runtimeGID, nil); err == nil {
		t.Fatal("root symlink accepted")
	}
	if st := statNode(t, root); st.Uid != 0 {
		t.Fatal("symlink target changed ownership")
	}
}

func TestNestedBindMountIsRejected(t *testing.T) {
	rootTest(t)
	parent := t.TempDir()
	root := filepath.Join(parent, "screenshots")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	safe := capture(t, root, "safe", 0700, 0600)
	outside := filepath.Join(parent, "outside")
	if err := os.Mkdir(outside, 0700); err != nil {
		t.Fatal(err)
	}
	nested := filepath.Join(root, "nested")
	if err := os.Mkdir(nested, 0700); err != nil {
		t.Fatal(err)
	}
	if err := unix.Mount(outside, nested, "", unix.MS_BIND, ""); err != nil {
		if err == unix.EPERM {
			t.Skip("mount capability unavailable in this fixture")
		}
		t.Fatal(err)
	}
	defer unix.Unmount(nested, 0)
	mounts, err := os.ReadFile("/proc/self/mountinfo")
	if err != nil {
		t.Fatal(err)
	}
	if err := prepare(root, runtimeUID, runtimeGID, mounts); err == nil {
		t.Fatal("same-filesystem nested bind mount accepted")
	}
	for _, path := range []string{root, safe, outside} {
		if st := statNode(t, path); st.Uid != 0 {
			t.Fatalf("nested mount changed %s", path)
		}
	}
}

func TestMountInventoryAndCrashReceipt(t *testing.T) {
	rootTest(t)
	parent := t.TempDir()
	root := filepath.Join(parent, "root with spaces")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	safe := capture(t, root, "safe", 0700, 0600)
	escaped := strings.ReplaceAll(root+"/nested", " ", "\\040")
	mounts := []byte("24 22 0:2 / " + escaped + " rw - ext4 /dev/test rw\n")
	if err := prepare(root, runtimeUID, runtimeGID, mounts); err == nil {
		t.Fatal("escaped nested mount accepted")
	}
	if err := prepare(root, runtimeUID, runtimeGID, []byte("malformed")); err == nil {
		t.Fatal("invalid mount inventory accepted")
	}
	if st := statNode(t, safe); st.Uid != 0 {
		t.Fatal("mount preflight changed evidence")
	}
	receipt := filepath.Join(root, ownerMarker)
	if err := os.WriteFile(receipt, []byte(ownerReceipt), 0400); err != nil {
		t.Fatal(err)
	}
	if err := prepare(root, runtimeUID, runtimeGID, nil); err != nil {
		t.Fatalf("crash-safe retry: %v", err)
	}
	lost := filepath.Join(t.TempDir(), "screenshots")
	if err := os.Mkdir(lost, 0700); err != nil {
		t.Fatal(err)
	}
	recovery := filepath.Join(lost, "lost+found")
	if err := os.Mkdir(recovery, 0700); err != nil {
		t.Fatal(err)
	}
	recovered := filepath.Join(recovery, "recovered")
	if err := os.WriteFile(recovered, []byte("recovery data"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := prepare(lost, runtimeUID, runtimeGID, nil); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{recovery, recovered} {
		if st := statNode(t, path); st.Uid != 0 {
			t.Fatal("lost+found was migrated")
		}
	}
}

func TestContainerRootOverrides(t *testing.T) {
	for _, key := range []string{"SHOPKEEPER_SCREENSHOT_DIR", "LIME_SCREENSHOT_DIR"} {
		t.Run(key, func(t *testing.T) {
			t.Setenv("SHOPKEEPER_SCREENSHOT_DIR", "")
			t.Setenv("LIME_SCREENSHOT_DIR", "")
			for _, value := range []string{"", screenshotRoot, screenshotRoot + "/"} {
				t.Setenv(key, value)
				if err := validateContainerRoot(); err != nil {
					t.Fatalf("legitimate root %q: %v", value, err)
				}
			}
			for _, value := range []string{"/etc", "/app/screenshots-other", "../screenshots", "/app/screenshots/../../etc"} {
				t.Setenv(key, value)
				if err := validateContainerRoot(); err == nil {
					t.Fatalf("unsafe root %q accepted", value)
				}
			}
		})
	}
}
