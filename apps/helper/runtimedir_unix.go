//go:build !windows

package helper

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

// RuntimeDir is the helper's root-owned runtime directory (socket, pf token, DNS
// backup). /var/run is cleared on every macOS boot, so it is re-created each boot.
const RuntimeDir = "/var/run/tunnex"

// runtimeDirMode is the exact mode the runtime dir must have: root may write, and
// the UNPRIVILEGED desktop app must be able to traverse it to reach the 0666 socket.
// Anything stricter (e.g. the 0744 launchd creates for a missing StandardErrorPath
// parent) makes every connect fail with EACCES; anything looser lets another local
// user plant files the root helper later writes through.
const runtimeDirMode = 0o755

// EnsureRuntimeDir guarantees the canonical runtime dir exists, is a real directory
// (not a symlink), is owned by the helper (root), and has exactly mode 0755, even
// when something else created it first with a different mode.
func EnsureRuntimeDir() error { return ensureRuntimeDir(RuntimeDir, 0) }

// ensureRuntimeDir is the testable core. wantUID is the owner the dir must already
// have (root in production). The checks run on an fd opened with O_NOFOLLOW so the
// type/owner check and the chmod act on the same inode (no Lstat→Chmod race).
//
// A dir owned by anyone else is REFUSED, never chowned: its contents were written by
// that owner (e.g. a planted pf.token symlink the root helper would write through),
// so it can't be adopted. A symlink or non-directory is refused for the same reason.
func ensureRuntimeDir(dir string, wantUID int) error {
	if err := os.Mkdir(dir, runtimeDirMode); err != nil && !errors.Is(err, os.ErrExist) {
		return fmt.Errorf("runtime dir %s: %w", dir, err)
	}
	fd, err := unix.Open(dir, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		if errors.Is(err, unix.ELOOP) || errors.Is(err, unix.ENOTDIR) {
			return fmt.Errorf("runtime dir %s is not a real directory (symlink or file), refusing", dir)
		}
		return fmt.Errorf("runtime dir %s: %w", dir, err)
	}
	defer unix.Close(fd)
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		return fmt.Errorf("runtime dir %s: %w", dir, err)
	}
	if st.Mode&unix.S_IFMT != unix.S_IFDIR {
		return fmt.Errorf("runtime dir %s is not a directory, refusing", dir)
	}
	// Owner only: launchd/BSD semantics give the dir /var/run's group (daemon), which
	// is harmless once group write is cleared by the chmod below.
	if int(st.Uid) != wantUID {
		return fmt.Errorf("runtime dir %s is owned by uid %d, want %d, refusing (remove it and restart the helper)", dir, st.Uid, wantUID)
	}
	// Unconditional: MkdirAll/Mkdir are no-ops on an existing dir and subject to the
	// (launchd-controlled) umask, so the mode is always set explicitly.
	if err := unix.Fchmod(fd, runtimeDirMode); err != nil {
		return fmt.Errorf("runtime dir %s: chmod: %w", dir, err)
	}
	return nil
}

// ensureSocketDir prepares the directory holding the helper socket. The canonical
// runtime dir gets the strict repair above; an overridden TUNNEX_HELPER_SOCKET in a
// dev/test location (e.g. a temp dir, or /tmp itself) is only created if missing,
// never re-moded, so root never chmods a shared dir like /tmp.
func ensureSocketDir(socketPath string) error {
	dir := filepath.Clean(filepath.Dir(socketPath))
	if dir == RuntimeDir {
		return EnsureRuntimeDir()
	}
	return os.MkdirAll(dir, runtimeDirMode)
}
