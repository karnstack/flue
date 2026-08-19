package session_test

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/karnstack/flue/internal/session"
)

func holderRegistry(t *testing.T) (*session.Registry, string) {
	t.Helper()
	root, err := os.MkdirTemp("", "fluehr")
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(root) })
	exe, err := os.Executable()
	if err != nil {
		t.Fatalf("os.Executable: %v", err)
	}
	r := session.NewRegistry(nil)
	r.SetHolderSpawning(exe, root)
	return r, root
}

func TestRegistrySpawnsHolderBackedSessions(t *testing.T) {
	r, root := holderRegistry(t)
	h, err := r.Spawn(session.SpawnOpts{
		Cmd: []string{"/bin/sh", "-c", "printf via-holder; exec cat"}, Cols: 80, Rows: 24,
	})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	t.Cleanup(func() { _ = h.Close() })

	rem, ok := h.(*session.Remote)
	if !ok {
		t.Fatalf("Spawn returned %T, want *session.Remote", h)
	}

	sub := h.Subscribe(0)
	defer h.Unsubscribe(sub)
	waitRemote(t, sub, "via-holder", 5*time.Second)
	if err := h.Write([]byte("through-the-registry\n")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	waitRemote(t, sub, "through-the-registry", 5*time.Second)

	rec, err := session.LoadIdentity(rem.Dir())
	if err != nil {
		t.Fatalf("LoadIdentity: %v", err)
	}
	if rec.ID != h.ID() {
		t.Fatalf("identity ID = %q, want %q", rec.ID, h.ID())
	}
	if rec.CreatedAt.IsZero() {
		t.Error("identity CreatedAt is zero")
	}
	if got := filepath.Dir(rem.Dir()); got != root {
		t.Fatalf("holder dir %q sits outside the root %q", rem.Dir(), got)
	}

	got, ok := r.Get(h.ID())
	if !ok || got.ID() != h.ID() {
		t.Fatal("registry does not hold the remote session")
	}
}

func TestRegistryPersistsEphemeralFlipToIdentity(t *testing.T) {
	r, _ := holderRegistry(t)
	h, err := r.Spawn(session.SpawnOpts{
		Cmd: []string{"/bin/sh", "-c", "exec cat"}, Cols: 80, Rows: 24,
		Group: "cafebabe33333333", Ephemeral: true,
	})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	t.Cleanup(func() { _ = h.Close() })
	rem := h.(*session.Remote)

	rec, err := session.LoadIdentity(rem.Dir())
	if err != nil || !rec.Ephemeral || rec.Group != "cafebabe33333333" {
		t.Fatalf("identity after spawn = %+v, %v", rec, err)
	}

	kept := false
	if _, err := r.UpdateMeta(h.ID(), session.MetaPatch{Ephemeral: &kept}); err != nil {
		t.Fatalf("UpdateMeta: %v", err)
	}
	rec, err = session.LoadIdentity(rem.Dir())
	if err != nil || rec.Ephemeral {
		t.Fatalf("identity after keep = %+v, %v; want Ephemeral false", rec, err)
	}
}

func TestRegistryReapRetiresClosedRemotes(t *testing.T) {
	now := time.Now()
	clock := func() time.Time { return now }
	root, err := os.MkdirTemp("", "fluehr")
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(root) })
	exe, _ := os.Executable()
	r := session.NewRegistry(clock)
	r.SetHolderSpawning(exe, root)

	h, err := r.Spawn(session.SpawnOpts{
		Cmd: []string{"/bin/sh", "-c", "exit 0"}, Cols: 80, Rows: 24,
	})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for h.Info().State != "exited" {
		if time.Now().After(deadline) {
			t.Fatal("session never exited")
		}
		time.Sleep(20 * time.Millisecond)
	}

	now = now.Add(session.ExitedRetention + time.Minute)
	r.Reap()
	if _, ok := r.Get(h.ID()); ok {
		t.Fatal("remote session survived the sweep past its retention")
	}
	rem := h.(*session.Remote)
	if _, err := os.Stat(rem.Dir()); !os.IsNotExist(err) {
		t.Fatalf("holder dir still present after the sweep: %v", err)
	}
}
