package session_test

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/karnstack/flue/internal/session"
)

// A holder that takes SIGTERM — logout, reboot — writes the snapshot the
// next boot revives from, exactly where the daemon's shutdown pass used to
// put it. This is the reboot half of the durability story.
func TestHolderWritesSnapshotOnSigterm(t *testing.T) {
	// The holder computes the snapshots dir from XDG_CONFIG_HOME, which it
	// inherits from its spawner: this test process.
	xdg, err := os.MkdirTemp("", "fluex")
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(xdg) })
	t.Setenv("XDG_CONFIG_HOME", xdg)

	dir := holderDir(t)
	exe, _ := os.Executable()
	cfg := session.ChildConfig{
		ID:   "cafebabe66666666",
		Run:  []string{"/bin/sh", "-c", "printf reboot-me; exec cat"},
		Argv: []string{"cat"},
		Env:  []string{"TERM=xterm-256color", "PATH=/usr/bin:/bin"},
		Cwd:  "/",
		Cols: 80, Rows: 24,
	}
	r, err := session.SpawnRemote(exe, dir, cfg, nil)
	if err != nil {
		t.Fatalf("SpawnRemote: %v", err)
	}
	sub := r.Subscribe(0)
	waitRemote(t, sub, "reboot-me", 5*time.Second)
	r.Unsubscribe(sub)

	if r.HolderPid() == 0 {
		t.Fatal("spawned Remote reports no holder pid")
	}
	if err := syscall.Kill(r.HolderPid(), syscall.SIGTERM); err != nil {
		t.Fatalf("SIGTERM holder: %v", err)
	}

	snapPath := filepath.Join(xdg, "flue", session.SnapshotsDirName, "cafebabe66666666.json")
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(snapPath); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("no snapshot at %s after SIGTERM", snapPath)
		}
		time.Sleep(20 * time.Millisecond)
	}

	snaps := session.LoadSnapshots(filepath.Join(xdg, "flue", session.SnapshotsDirName))
	if len(snaps) != 1 || snaps[0].ID != "cafebabe66666666" {
		t.Fatalf("LoadSnapshots = %+v", snaps)
	}
	if !strings.Contains(string(snaps[0].Ring), "reboot-me") {
		t.Fatalf("snapshot ring lost the scrollback: %q", snaps[0].Ring)
	}
}
