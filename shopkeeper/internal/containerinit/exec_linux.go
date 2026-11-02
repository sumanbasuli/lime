//go:build linux

package containerinit

import (
	"fmt"
	"os"

	"golang.org/x/sys/unix"
)

// ContainerExec is the image entrypoint, separate from native service startup.
func ContainerExec(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("a container command is required")
	}
	if err := validateContainerRoot(); err != nil {
		return err
	}
	if os.Geteuid() != 0 {
		return fmt.Errorf("container initialization must start with the image default root user")
	}
	mounts, err := os.ReadFile("/proc/self/mountinfo")
	if err != nil {
		return err
	}
	if err := prepare(screenshotRoot, runtimeUID, runtimeGID, mounts); err != nil {
		return err
	}
	var home unix.Stat_t
	if err := unix.Lstat("/home/lime", &home); err != nil {
		return err
	}
	if home.Mode&unix.S_IFMT != unix.S_IFDIR || home.Uid != runtimeUID || home.Gid != runtimeGID || home.Mode&0777 != 0700 {
		return fmt.Errorf("the image must provide a private /home/lime directory owned by UID/GID 10001")
	}
	if err := os.Setenv("HOME", "/home/lime"); err != nil {
		return err
	}
	if err := os.Setenv("XDG_CONFIG_HOME", "/home/lime/.config"); err != nil {
		return err
	}
	if err := os.Setenv("XDG_CACHE_HOME", "/home/lime/.cache"); err != nil {
		return err
	}
	// Exec a single-threaded credential tool before switching UID, avoiding
	// thread-local credential changes inside the Go runtime. It replaces PID 1
	// with the requested command only after every privilege has been dropped.
	flags := []string{"/usr/bin/setpriv", "--reuid=10001", "--regid=10001", "--clear-groups",
		"--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs", "--"}
	flags = append(flags, args...)
	return unix.Exec("/usr/bin/setpriv", flags, os.Environ())
}
