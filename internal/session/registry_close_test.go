package session

import (
	"errors"
	"path/filepath"
	"testing"
	"time"
)

// TestCloseAllRetiresEverySession: `flue close --all` means everything goes —
// running and exited alike, with no retention window to wait out — and each
// session's meta file goes with it, the way Reap's cleanup works, so nothing
// in the meta dir describes a session that no longer exists.
func TestCloseAllRetiresEverySession(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "sessions")
	r := NewRegistry(time.Now)
	r.SetMetaDir(dir, nil)

	running := spawnRunning(t, r)
	name := "named"
	if _, err := r.UpdateMeta(running.ID(), MetaPatch{Name: &name}); err != nil {
		t.Fatalf("UpdateMeta: %v", err)
	}
	exited := spawnLocal(t, r, SpawnOpts{Cmd: []string{"true"}, Cols: 80, Rows: 24})
	t.Cleanup(func() { _ = exited.Close() })
	waitExited(t, exited, 5*time.Second)

	if got := r.CloseAll(); got != 2 {
		t.Fatalf("CloseAll = %d, want 2", got)
	}
	if left := r.List(); len(left) != 0 {
		t.Errorf("List after CloseAll holds %d sessions, want none", len(left))
	}
	if metas := LoadMetas(dir); len(metas) != 0 {
		t.Errorf("LoadMetas = %+v, want the closed sessions' records gone", metas)
	}
}

// TestCloseByIDRetiresOnlyTheNamedSession: a targeted close takes the session
// it names — registry row and meta file both — and nothing beside it.
func TestCloseByIDRetiresOnlyTheNamedSession(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "sessions")
	r := NewRegistry(time.Now)
	r.SetMetaDir(dir, nil)

	going := spawnRunning(t, r)
	staying := spawnRunning(t, r)
	// Both named, so a missing meta file below means deleted rather than
	// never written.
	for _, s := range []*Session{going, staying} {
		n := "meta for " + s.ID()
		if _, err := r.UpdateMeta(s.ID(), MetaPatch{Name: &n}); err != nil {
			t.Fatalf("UpdateMeta: %v", err)
		}
	}

	if err := r.CloseByID(going.ID()); err != nil {
		t.Fatalf("CloseByID: %v", err)
	}
	if _, ok := r.Get(going.ID()); ok {
		t.Error("the closed session is still in the registry")
	}
	if _, ok := r.Get(staying.ID()); !ok {
		t.Error("the other session went with it")
	}

	metas := LoadMetas(dir)
	if _, ok := metas[going.ID()]; ok {
		t.Error("the closed session's meta file survives it")
	}
	if _, ok := metas[staying.ID()]; !ok {
		t.Error("the surviving session's meta file is gone")
	}
}

// TestCloseByIDUnknownIsNotFound: an id the registry does not hold gets the
// same sentinel every other by-id path answers with, so the daemon handler
// can turn it into "missing" rather than a failure.
func TestCloseByIDUnknownIsNotFound(t *testing.T) {
	r := NewRegistry(nil)
	if err := r.CloseByID("cafebabe00000000"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("CloseByID = %v, want ErrNotFound", err)
	}
}
