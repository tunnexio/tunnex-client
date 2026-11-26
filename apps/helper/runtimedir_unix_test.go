//go:build !windows

package helper

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func modeOf(t *testing.T, p string) os.FileMode {
	t.Helper()
	fi, err := os.Lstat(p)
	if err != nil {
		t.Fatal(err)
	}
	return fi.Mode().Perm()
}

// The reboot bug: launchd pre-creates the runtime dir as 0744 for a StandardErrorPath
// inside it, and MkdirAll left that mode alone, so the app got EACCES on the socket.
func TestEnsureRuntimeDirRepairsPreexisting0744(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "tunnex")
	if err := os.Mkdir(dir, 0o744); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o744); err != nil {
		t.Fatal(err)
	}
	if err := ensureRuntimeDir(dir, os.Getuid()); err != nil {
		t.Fatalf("ensureRuntimeDir: %v", err)
	}
	if got := modeOf(t, dir); got != 0o755 {
		t.Fatalf("mode = %o, want 755", got)
	}
}

func TestEnsureRuntimeDirTightensLooseMode(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "tunnex")
	if err := os.Mkdir(dir, 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o777); err != nil {
		t.Fatal(err)
	}
	if err := ensureRuntimeDir(dir, os.Getuid()); err != nil {
		t.Fatalf("ensureRuntimeDir: %v", err)
	}
	if got := modeOf(t, dir); got != 0o755 {
		t.Fatalf("mode = %o, want 755", got)
	}
}

// A restrictive umask (launchd's is not ours to choose) must not leak into the mode.
func TestEnsureRuntimeDirCreatesMissingAs0755UnderRestrictiveUmask(t *testing.T) {
	old := syscall.Umask(0o077)
	defer syscall.Umask(old)
	dir := filepath.Join(t.TempDir(), "tunnex")
	if err := ensureRuntimeDir(dir, os.Getuid()); err != nil {
		t.Fatalf("ensureRuntimeDir: %v", err)
	}
	if got := modeOf(t, dir); got != 0o755 {
		t.Fatalf("mode = %o, want 755", got)
	}
}

func TestEnsureRuntimeDirRefusesSymlink(t *testing.T) {
	base := t.TempDir()
	target := filepath.Join(base, "elsewhere")
	if err := os.Mkdir(target, 0o700); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(base, "tunnex")
	if err := os.Symlink(target, dir); err != nil {
		t.Fatal(err)
	}
	if err := ensureRuntimeDir(dir, os.Getuid()); err == nil {
		t.Fatal("symlinked runtime dir was accepted")
	}
	// The symlink target must not have been re-moded through the link.
	if got := modeOf(t, target); got != 0o700 {
		t.Fatalf("symlink target mode changed to %o", got)
	}
}

func TestEnsureRuntimeDirRefusesRegularFile(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "tunnex")
	if err := os.WriteFile(dir, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := ensureRuntimeDir(dir, os.Getuid()); err == nil {
		t.Fatal("regular file accepted as runtime dir")
	}
}

// A dir owned by someone other than the helper is refused, not adopted: its contents
// (e.g. a planted pf.token symlink) are attacker-controlled. Simulated by expecting a
// different owner, so the test needs no root.
func TestEnsureRuntimeDirRefusesWrongOwner(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "tunnex")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := ensureRuntimeDir(dir, os.Getuid()+1); err == nil {
		t.Fatal("dir with wrong owner accepted")
	}
	if got := modeOf(t, dir); got != 0o700 {
		t.Fatalf("refused dir was re-moded to %o", got)
	}
}

// An overridden socket path outside the canonical runtime dir is only created, never
// re-moded (root must not chmod a shared dir such as /tmp).
func TestEnsureSocketDirLeavesNonCanonicalDirMode(t *testing.T) {
	dir := t.TempDir()
	if err := os.Chmod(dir, os.ModeSticky|0o777); err != nil {
		t.Fatal(err)
	}
	if err := ensureSocketDir(filepath.Join(dir, "helper.sock")); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode()&os.ModeSticky == 0 || fi.Mode().Perm() != 0o777 {
		t.Fatalf("non-canonical dir mode changed: %v", fi.Mode())
	}
}

func TestDefaultSocketLivesInRuntimeDir(t *testing.T) {
	if filepath.Dir(DefaultSocketPath()) != RuntimeDir || RuntimeDir != "/var/run/tunnex" {
		t.Fatalf("socket %q / runtime dir %q drifted", DefaultSocketPath(), RuntimeDir)
	}
}
