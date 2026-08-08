package session

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// resolved is filepath.EvalSymlinks with the failure folded into the test.
// Every comparison in this file resolves both sides first, because on darwin
// /tmp — and so every t.TempDir() — is a symlink into /private/tmp, and the
// kernel reports the resolved path while the test holds the alias.
func resolved(t *testing.T, path string) string {
	t.Helper()
	p, err := filepath.EvalSymlinks(path)
	if err != nil {
		t.Fatalf("EvalSymlinks(%q): %v", path, err)
	}
	return p
}

// TestProcessCwdReportsSpawnDir is the proof behind the darwin constants: the
// syscall number, callnum, flavor and struct offsets in cwd_darwin.go are
// only citations until a real child in a known directory comes back with that
// directory. The poll exists because Spawn returns after the fork, and the
// child chdirs to SpawnOpts.Cwd on its own schedule between fork and exec.
func TestProcessCwdReportsSpawnDir(t *testing.T) {
	dir := t.TempDir()
	want := resolved(t, dir)

	r := NewRegistry(nil)
	s, err := r.Spawn(SpawnOpts{Cwd: dir, Cmd: []string{"sleep", "5"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })

	deadline := time.Now().Add(5 * time.Second)
	for {
		got, err := processCwd(s.pid)
		if err == nil && resolved(t, got) == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("processCwd(%d) = %q, %v; want %q", s.pid, got, err, want)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// TestInfoTracksCd is the feature: a `cd` typed into the session moves the
// Cwd the next snapshot reports, with no cooperation from the shell. The
// session starts in dirA rather than wherever the test binary happens to
// run, so the assertion cannot be satisfied by a session that never moved.
func TestInfoTracksCd(t *testing.T) {
	dirA := t.TempDir()
	dirB := t.TempDir()
	want := resolved(t, dirB)

	r := NewRegistry(nil)
	s, err := r.Spawn(SpawnOpts{Cwd: dirA, Cmd: []string{"sh"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })

	if err := s.Write([]byte("cd \"" + dirB + "\"\n")); err != nil {
		t.Fatalf("Write: %v", err)
	}

	deadline := time.Now().Add(5 * time.Second)
	for {
		got := s.Info().Cwd
		if r, err := filepath.EvalSymlinks(got); err == nil && r == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("Info().Cwd = %q, want it to reach %q", got, want)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// TestInfoKeepsCwdWhenReadFails pins the failure policy: a read that errors
// leaves the last known value in place, it never blanks it. The seed matters
// — the stub returns "" alongside its error, so an Info that stored the
// result without checking the error would be caught wiping the field, and an
// Info that never stored anything is caught by TestInfoTracksCd above.
func TestInfoKeepsCwdWhenReadFails(t *testing.T) {
	dir := t.TempDir()
	r := NewRegistry(nil)
	s, err := r.Spawn(SpawnOpts{Cwd: dir, Cmd: []string{"sleep", "5"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })

	// One honest reading first, so "unchanged" names a value a real read
	// produced rather than whatever Spawn seeded.
	before := s.Info().Cwd
	if before == "" {
		t.Fatal("seed Cwd is empty, so keeping it would prove nothing")
	}

	s.cwdOf = func(pid int) (string, error) { return "", errors.New("proc info refused") }
	if got := s.Info().Cwd; got != before {
		t.Fatalf("Info().Cwd = %q after a failed read, want the previous %q", got, before)
	}
}

// TestInfoIgnoresCwdAfterExit pins the guard that makes pid recycling safe.
// Once the child is reaped its pid can name a stranger, and a "successful"
// read may then describe the stranger's directory — so after the exit even a
// clean read must not move the field. The stub returns a real, existing
// directory to make the temptation concrete: an Info missing the state gate
// would store it and fail here.
func TestInfoIgnoresCwdAfterExit(t *testing.T) {
	dir := t.TempDir()
	r := NewRegistry(nil)
	s, err := r.Spawn(SpawnOpts{Cwd: dir, Cmd: []string{"sh", "-c", "exit 0"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })

	deadline := time.Now().Add(5 * time.Second)
	for s.Info().State != "exited" {
		if time.Now().After(deadline) {
			t.Fatal("the child never exited")
		}
		time.Sleep(5 * time.Millisecond)
	}
	last := s.Info().Cwd

	stranger, err := os.UserHomeDir()
	if err != nil || stranger == last {
		t.Skipf("no distinct directory to impersonate a recycled pid with (%v)", err)
	}
	s.cwdOf = func(pid int) (string, error) { return stranger, nil }
	if got := s.Info().Cwd; got != last {
		t.Fatalf("Info().Cwd = %q after exit, want the last known %q", got, last)
	}
}
