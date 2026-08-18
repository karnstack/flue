package session_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/karnstack/flue/internal/session"
)

// The restart in miniature: a registry spawns a holder-backed session and
// is thrown away — holder untouched, exactly what a daemon exit is now —
// and a fresh registry reattaches from the holders root alone.
func TestReattachHoldersRebuildsLiveSessions(t *testing.T) {
	r1, root := holderRegistry(t)
	h, err := r1.Spawn(session.SpawnOpts{
		Cmd:  []string{"/bin/sh", "-c", "printf survives-restart; exec cat"},
		Cols: 80, Rows: 24,
		Group: "cafebabe44444444",
	})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	id := h.ID()
	created := h.Info().CreatedAt
	sub := h.Subscribe(0)
	waitRemote(t, sub, "survives-restart", 5*time.Second)
	h.Unsubscribe(sub)
	// The old daemon is gone; nothing is told. r1 is simply never used again.

	r2 := session.NewRegistry(nil)
	reattached, swept := session.ReattachHolders(r2, root)
	if reattached != 1 || swept != 0 {
		t.Fatalf("ReattachHolders = %d reattached, %d swept; want 1, 0", reattached, swept)
	}
	got, ok := r2.Get(id)
	if !ok {
		t.Fatal("reattached session is not in the new registry")
	}
	t.Cleanup(func() { _ = got.Close() })

	info := got.Info()
	if info.State != "running" {
		t.Fatalf("State = %q after reattach", info.State)
	}
	if !info.CreatedAt.Equal(created) {
		t.Fatalf("CreatedAt = %v, want %v", info.CreatedAt, created)
	}
	if info.Group != "cafebabe44444444" {
		t.Fatalf("Group = %q after reattach", info.Group)
	}

	sub2 := got.Subscribe(0)
	defer got.Unsubscribe(sub2)
	if !strings.Contains(string(sub2.Backlog), "survives-restart") {
		t.Fatalf("scrollback lost across reattach: %q", sub2.Backlog)
	}
	if err := got.Write([]byte("post-restart-write\n")); err != nil {
		t.Fatalf("Write after reattach: %v", err)
	}
	waitRemote(t, sub2, "post-restart-write", 5*time.Second)
}

func TestReattachHoldersSweepsDeadDirs(t *testing.T) {
	root, err := os.MkdirTemp("", "fluehr")
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(root) })

	// A dir with an identity but no listener: a holder the reboot took.
	dead := filepath.Join(root, "cafebabe55555555")
	if err := os.MkdirAll(dead, 0o700); err != nil {
		t.Fatal(err)
	}
	rec := session.IdentityRecord{V: 1, ID: "cafebabe55555555", Cmd: []string{"cat"}, CreatedAt: time.Now()}
	if err := session.SaveIdentity(dead, rec); err != nil {
		t.Fatal(err)
	}
	// And a dir with no identity at all: junk.
	junk := filepath.Join(root, "not-a-session")
	if err := os.MkdirAll(junk, 0o700); err != nil {
		t.Fatal(err)
	}

	r := session.NewRegistry(nil)
	reattached, swept := session.ReattachHolders(r, root)
	if reattached != 0 || swept != 2 {
		t.Fatalf("ReattachHolders = %d, %d; want 0 reattached, 2 swept", reattached, swept)
	}
	for _, dir := range []string{dead, junk} {
		if _, err := os.Stat(dir); !os.IsNotExist(err) {
			t.Errorf("%s survived the sweep", dir)
		}
	}
}
