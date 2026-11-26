package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCapStderrLogTruncatesOnlyPastLimit(t *testing.T) {
	p := filepath.Join(t.TempDir(), "helper.log")
	f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.Write(make([]byte, 100)); err != nil {
		t.Fatal(err)
	}
	if capStderrLog(f, 100) {
		t.Fatal("truncated a log at the limit")
	}
	if _, err := f.Write([]byte("x")); err != nil {
		t.Fatal(err)
	}
	if !capStderrLog(f, 100) {
		t.Fatal("did not truncate a log past the limit")
	}
	if _, err := f.Write([]byte("after\n")); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	// Only the truncation notice (written to the real stderr, not f) is absent; f holds
	// just the post-truncation write, with no sparse gap.
	if fi.Size() != int64(len("after\n")) {
		t.Fatalf("size after cap = %d", fi.Size())
	}
}

func TestCapStderrLogIgnoresNonRegular(t *testing.T) {
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	defer w.Close()
	if capStderrLog(w, 0) {
		t.Fatal("truncated a pipe")
	}
}
