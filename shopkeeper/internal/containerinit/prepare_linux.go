//go:build linux

package containerinit

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
)

const screenshotRoot = "/app/screenshots"
const runtimeUID = 10001
const runtimeGID = 10001
const ownerMarker = ".lime-owner-v1"
const ownerReceipt = "lime-owner-v1:10001:10001\n"

func validateContainerRoot() error {
	for _, key := range []string{"SHOPKEEPER_SCREENSHOT_DIR", "LIME_SCREENSHOT_DIR"} {
		if value := os.Getenv(key); value != "" && filepath.Clean(value) != screenshotRoot {
			return fmt.Errorf("%s must be %s in the container; native installations keep configurable roots", key, screenshotRoot)
		}
	}
	return nil
}

// prepare is private: production callers must use the fixed screenshotRoot.
// The path parameter lets Linux tests operate exclusively on disposable trees.
func prepare(path string, uid, gid int, mounts []byte) error {
	if os.Geteuid() != 0 {
		return errors.New("screenshot ownership preparation requires root")
	}
	if path == "/" || !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return errors.New("screenshot root must be a canonical absolute directory")
	}
	if err := rejectNestedMounts(path, mounts); err != nil {
		return err
	}
	fd, err := openRootNoLinks(path)
	if err != nil {
		return fmt.Errorf("open screenshot root: %w", err)
	}
	defer unix.Close(fd)
	var root unix.Stat_t
	if err := unix.Fstat(fd, &root); err != nil {
		return err
	}
	if err := validateNode(&root, uid); err != nil {
		return fmt.Errorf("screenshot root: %w", err)
	}
	receipt, err := validReceipt(fd)
	if err != nil {
		return err
	}
	if receipt && int(root.Uid) == uid && int(root.Gid) == gid {
		return nil
	}
	// Validate the complete tree before any ownership change. The backend is
	// stopped during the first migration; all descriptor opens refuse links.
	if err := walkChildren(fd, root.Dev, uid, gid, 0, false); err != nil {
		return err
	}
	if err := walkChildren(fd, root.Dev, uid, gid, 0, true); err != nil {
		return err
	}
	// Make child metadata durable before a receipt can authorize a fast start.
	if err := unix.Syncfs(fd); err != nil {
		return err
	}
	if !receipt {
		if err := writeReceipt(fd); err != nil {
			return err
		}
	}
	// The root changes last. A failed or interrupted migration remains safe to
	// retry; normal future writes run as this UID, never as root.
	if err := unix.Fchown(fd, uid, gid); err != nil {
		return err
	}
	return unix.Syncfs(fd)
}

func openRootNoLinks(path string) (int, error) {
	fd, err := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, err
	}
	parts := strings.Split(strings.TrimPrefix(path, "/"), "/")
	for i, part := range parts {
		next, openErr := unix.Openat(fd, part, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if errors.Is(openErr, unix.ENOENT) && i == len(parts)-1 {
			if err := unix.Mkdirat(fd, part, 0700); err != nil {
				unix.Close(fd)
				return -1, err
			}
			next, openErr = unix.Openat(fd, part, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
			if openErr == nil {
				openErr = unix.Fchmod(next, 0700)
			}
		}
		unix.Close(fd)
		if openErr != nil {
			if next >= 0 {
				unix.Close(next)
			}
			return -1, openErr
		}
		fd = next
	}
	return fd, nil
}

func validateNode(st *unix.Stat_t, uid int) error {
	kind := st.Mode & unix.S_IFMT
	if kind != unix.S_IFDIR && kind != unix.S_IFREG {
		return errors.New("links and special files are not screenshot evidence")
	}
	if st.Mode&07000 != 0 {
		return errors.New("special permission bits are not supported in screenshot storage")
	}
	if st.Uid != 0 && int(st.Uid) != uid {
		return fmt.Errorf("unexpected screenshot owner UID %d", st.Uid)
	}
	if kind == unix.S_IFREG && st.Nlink != 1 {
		return errors.New("hardlinked screenshot evidence is not supported")
	}
	if kind == unix.S_IFDIR && st.Mode&0700 != 0700 {
		return errors.New("screenshot directories need owner read/write/search permission")
	}
	if kind == unix.S_IFREG && st.Mode&0400 == 0 {
		return errors.New("screenshot files need owner read permission")
	}
	return nil
}

func walkChildren(fd int, device uint64, uid, gid, depth int, change bool) error {
	if depth > 64 {
		return errors.New("unexpectedly deep screenshot tree")
	}
	readFD, err := unix.Openat(fd, ".", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	dir := os.NewFile(uintptr(readFD), "screenshot-directory")
	defer dir.Close()
	for {
		entries, readErr := dir.ReadDir(128)
		for _, entry := range entries {
			name := entry.Name()
			childFD, err := unix.Openat(fd, name, unix.O_PATH|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
			if err != nil {
				return fmt.Errorf("open screenshot entry %q: %w", name, err)
			}
			var st unix.Stat_t
			err = unix.Fstat(childFD, &st)
			if err == nil && st.Dev != device {
				err = errors.New("nested filesystem in screenshot storage")
			}
			// A root-owned private receipt is never transferred to the app.
			if err == nil && depth == 0 && name == ownerMarker {
				_, err = validReceipt(fd)
				unix.Close(childFD)
				if err != nil {
					return err
				}
				continue
			}
			if err == nil {
				err = validateNode(&st, uid)
			}
			if err == nil && depth == 0 && name == "lost+found" {
				if st.Mode&unix.S_IFMT != unix.S_IFDIR || st.Uid != 0 {
					err = errors.New("unexpected lost+found entry")
				}
				unix.Close(childFD)
				if err != nil {
					return err
				}
				continue
			}
			if err == nil && st.Mode&unix.S_IFMT == unix.S_IFDIR {
				err = walkChildren(childFD, device, uid, gid, depth+1, change)
			}
			if err == nil && change && (int(st.Uid) != uid || int(st.Gid) != gid) {
				err = unix.Fchownat(childFD, "", uid, gid, unix.AT_EMPTY_PATH|unix.AT_SYMLINK_NOFOLLOW)
				if err == nil {
					var after unix.Stat_t
					err = unix.Fstat(childFD, &after)
					if err == nil && after.Mode != st.Mode {
						err = errors.New("ownership migration changed screenshot permissions")
					}
				}
			}
			unix.Close(childFD)
			if err != nil {
				return fmt.Errorf("screenshot entry %q: %w", name, err)
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				return nil
			}
			return readErr
		}
	}
}

func validReceipt(fd int) (bool, error) {
	pathFD, err := unix.Openat(fd, ownerMarker, unix.O_PATH|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if errors.Is(err, unix.ENOENT) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("invalid ownership receipt: %w", err)
	}
	defer unix.Close(pathFD)
	var st unix.Stat_t
	if err := unix.Fstat(pathFD, &st); err != nil {
		return false, err
	}
	if st.Mode&unix.S_IFMT != unix.S_IFREG || st.Mode&07777 != 0400 || st.Uid != 0 || st.Gid != 0 || st.Nlink != 1 {
		return false, errors.New("invalid screenshot ownership receipt metadata")
	}
	// Reopen the verified, pinned regular-file descriptor, not the untrusted
	// directory entry. This cannot open a replacement FIFO or device.
	fileFD, err := unix.Open(fmt.Sprintf("/proc/self/fd/%d", pathFD), unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NONBLOCK, 0)
	if err != nil {
		return false, err
	}
	f := os.NewFile(uintptr(fileFD), ownerMarker)
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, 129))
	if err != nil {
		return false, err
	}
	if string(data) != ownerReceipt {
		return false, errors.New("invalid screenshot ownership receipt contents")
	}
	return true, nil
}

func writeReceipt(fd int) error {
	fileFD, err := unix.Openat(fd, ownerMarker, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0400)
	if err != nil {
		return err
	}
	f := os.NewFile(uintptr(fileFD), ownerMarker)
	defer f.Close()
	if err := unix.Fchown(fileFD, 0, 0); err != nil {
		return err
	}
	if err := unix.Fchmod(fileFD, 0400); err != nil {
		return err
	}
	if _, err := f.WriteString(ownerReceipt); err != nil {
		return err
	}
	return f.Sync()
}

func rejectNestedMounts(root string, data []byte) error {
	decode := strings.NewReplacer("\\040", " ", "\\011", "\t", "\\012", "\n", "\\134", "\\")
	for _, line := range strings.Split(string(data), "\n") {
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 10 {
			return errors.New("cannot validate screenshot mount inventory")
		}
		mount := filepath.Clean(decode.Replace(fields[4]))
		if strings.HasPrefix(mount, root+"/") {
			return fmt.Errorf("nested mount in screenshot storage: %q", mount)
		}
	}
	return nil
}
