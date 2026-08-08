package session

import (
	"bytes"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"
)

func spawnRunning(t *testing.T, r *Registry) *Session {
	t.Helper()
	s, err := r.Spawn(SpawnOpts{Cmd: []string{"sleep", "5"}, Cols: 100, Rows: 30})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func TestSnapshotsCoverRunningSessionsOnly(t *testing.T) {
	r := NewRegistry(nil)
	running := spawnRunning(t, r)

	exited, err := r.Spawn(SpawnOpts{Cmd: []string{"true"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	t.Cleanup(func() { _ = exited.Close() })
	deadline := time.Now().Add(5 * time.Second)
	for {
		if exited.Info().State == "exited" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the exiting session never exited")
		}
		time.Sleep(5 * time.Millisecond)
	}

	snaps := r.Snapshots()
	if len(snaps) != 1 {
		t.Fatalf("Snapshots() = %d entries, want only the running session", len(snaps))
	}
	snap := snaps[0]
	if snap.ID != running.ID() {
		t.Fatalf("snapshot id = %q, want %q", snap.ID, running.ID())
	}
	if snap.Cols != 100 || snap.Rows != 30 {
		t.Fatalf("snapshot size = %dx%d, want 100x30", snap.Cols, snap.Rows)
	}
	if snap.V != 1 {
		t.Fatalf("snapshot version = %d, want 1", snap.V)
	}
}

func TestReviveRestoresIdentityAndScrollback(t *testing.T) {
	r := NewRegistry(nil)
	snap := Snapshot{
		V:     1,
		ID:    "cafebabe00000001",
		Title: "an old title",
		Cwd:   t.TempDir(),
		Cols:  120,
		Rows:  32,
		Ring:  []byte("the old scrollback"),
	}

	s, err := r.Revive(snap)
	if err != nil {
		t.Fatalf("Revive: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })

	if s.ID() != "cafebabe00000001" {
		t.Fatalf("revived id = %q, want the snapshot's", s.ID())
	}
	if got, ok := r.Get("cafebabe00000001"); !ok || got != s {
		t.Fatal("the revived session is not registered under its old id")
	}
	info := s.Info()
	if info.Title != "an old title" {
		t.Fatalf("revived title = %q, want the snapshot's", info.Title)
	}
	if info.State != "running" {
		t.Fatalf("revived state = %q, want running", info.State)
	}

	sub := s.Subscribe(0)
	defer s.Unsubscribe(sub)
	if sub.StartSeq != 0 || sub.Truncated {
		t.Fatalf("StartSeq=%d Truncated=%v, want a full replay", sub.StartSeq, sub.Truncated)
	}
	if !bytes.HasPrefix(sub.Backlog, []byte("the old scrollback")) {
		t.Fatalf("backlog does not start with the restored bytes: %q", sub.Backlog)
	}
	if !bytes.Contains(sub.Backlog, []byte("daemon restarted")) {
		t.Fatalf("backlog carries no restart marker: %q", sub.Backlog)
	}
	if !bytes.Contains(sub.Backlog, []byte("\x1b[2m")) {
		t.Fatalf("the marker is not dimmed: %q", sub.Backlog)
	}
}

func TestReviveFallsBackToHomeWhenTheCwdIsGone(t *testing.T) {
	r := NewRegistry(nil)
	s, err := r.Revive(Snapshot{V: 1, ID: "cafebabe00000002", Cwd: "/no/such/dir/anywhere"})
	if err != nil {
		t.Fatalf("Revive: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })

	home, _ := os.UserHomeDir()
	if got := s.Info().Cwd; got != home {
		t.Fatalf("revived cwd = %q, want the home directory %q", got, home)
	}
}

func TestSaveSnapshotsModes(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "sessions")
	snaps := []Snapshot{{V: 1, ID: "cafebabe00000003", Ring: []byte("secret output")}}
	if err := SaveSnapshots(dir, snaps); err != nil {
		t.Fatalf("SaveSnapshots: %v", err)
	}

	di, err := os.Stat(dir)
	if err != nil {
		t.Fatalf("stat dir: %v", err)
	}
	if got := di.Mode().Perm(); got != 0o700 {
		t.Fatalf("dir mode = %o, want 0700", got)
	}
	fi, err := os.Stat(filepath.Join(dir, "cafebabe00000003.json"))
	if err != nil {
		t.Fatalf("stat snapshot: %v", err)
	}
	if got := fi.Mode().Perm(); got != 0o600 {
		t.Fatalf("file mode = %o, want 0600 — scrollback can hold secrets", got)
	}
}

func TestLoadAndClearConsumesAndSkipsCorrupt(t *testing.T) {
	dir := t.TempDir()
	if err := SaveSnapshots(dir, []Snapshot{{V: 1, ID: "cafebabe00000004", Ring: []byte("kept")}}); err != nil {
		t.Fatalf("SaveSnapshots: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "broken.json"), []byte("not json"), 0o600); err != nil {
		t.Fatalf("write corrupt: %v", err)
	}

	snaps := LoadAndClearSnapshots(dir)
	if len(snaps) != 1 || snaps[0].ID != "cafebabe00000004" {
		t.Fatalf("loaded %+v, want just the good snapshot", snaps)
	}
	if string(snaps[0].Ring) != "kept" {
		t.Fatalf("ring = %q, want the saved bytes back", snaps[0].Ring)
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("%d files survive a load, want none — snapshots are consumed", len(entries))
	}

	if got := LoadAndClearSnapshots(filepath.Join(dir, "never-created")); got != nil {
		t.Fatalf("a missing dir loaded %+v, want nothing", got)
	}
}

// TestSnapshotThenReviveRoundTrip is the end-to-end shape: what one
// registry's shutdown writes, the next registry's startup restores.
func TestSnapshotThenReviveRoundTrip(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "sessions")

	first := NewRegistry(nil)
	s := spawnRunning(t, first)
	id := s.ID()
	if err := SaveSnapshots(dir, first.Snapshots()); err != nil {
		t.Fatalf("SaveSnapshots: %v", err)
	}

	second := NewRegistry(nil)
	for _, snap := range LoadAndClearSnapshots(dir) {
		if _, err := second.Revive(snap); err != nil {
			t.Fatalf("Revive: %v", err)
		}
	}

	revived, ok := second.Get(id)
	if !ok {
		t.Fatalf("session %s did not come back", id)
	}
	t.Cleanup(func() { _ = revived.Close() })
	sub := revived.Subscribe(0)
	defer revived.Unsubscribe(sub)
	if !bytes.Contains(sub.Backlog, []byte("daemon restarted")) {
		t.Fatalf("revived backlog carries no restart marker: %q", sub.Backlog)
	}
}

// TestSnapshotCarriesMetadataAcrossARestart is what makes a graceful restart
// self-contained: the fields a human owns go out with the shutdown snapshot and
// come back with the revival, so the restarted daemon is whole before anything
// on disk is consulted.
//
// Every field is seeded with a non-zero value first, and that is the test
// rather than a preamble to it. Against an unnamed, untagged, unpinned session
// a Revive that simply dropped the metadata would produce exactly the same
// Info as one that restored it faithfully.
//
// The two registries run on clocks an hour apart for the same reason. CreatedAt
// is the one stamp that must survive a restart, and against a single clock
// "carried over from the snapshot" and "stamped fresh at revival" are the same
// value. LastActive is asserted from the other side: the shell is new, so it is
// the revival that has to be recorded there and not the snapshot's own reading.
func TestSnapshotCarriesMetadataAcrossARestart(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "sessions")
	epoch := time.Date(2026, 8, 8, 9, 0, 0, 0, time.UTC)

	first := NewRegistry(func() time.Time { return epoch })
	s := spawnRunning(t, first)
	id := s.ID()
	name, tags, pinned := "deploy", []string{"prod", "web"}, true
	s.ApplyMeta(MetaPatch{Name: &name, Tags: &tags, Pinned: &pinned})
	if err := SaveSnapshots(dir, first.Snapshots()); err != nil {
		t.Fatalf("SaveSnapshots: %v", err)
	}

	later := epoch.Add(time.Hour)
	second := NewRegistry(func() time.Time { return later })
	snaps := LoadAndClearSnapshots(dir)
	if len(snaps) != 1 {
		t.Fatalf("loaded %d snapshots, want the one running session", len(snaps))
	}
	revived, err := second.Revive(snaps[0])
	if err != nil {
		t.Fatalf("Revive: %v", err)
	}
	t.Cleanup(func() { _ = revived.Close() })

	info := revived.Info()
	if info.ID != id {
		t.Errorf("revived id = %q, want %q", info.ID, id)
	}
	if info.Name != "deploy" {
		t.Errorf("revived name = %q, want the seeded %q", info.Name, "deploy")
	}
	if !slices.Equal(info.Tags, []string{"prod", "web"}) {
		t.Errorf("revived tags = %#v, want the seeded pair", info.Tags)
	}
	if !info.Pinned {
		t.Error("revived pinned = false, want the seeded true")
	}
	if !info.CreatedAt.Equal(epoch) {
		t.Errorf("revived CreatedAt = %v, want the original %v: a restart is not a birth",
			info.CreatedAt, epoch)
	}
	if !info.LastActive.Equal(later) {
		t.Errorf("revived LastActive = %v, want the revival's %v", info.LastActive, later)
	}
}

// TestReviveStampsCreatedAtWhenTheSnapshotHasNone covers the other branch, and
// with it the Spawn path — Spawn revives nothing, so it arrives here with the
// same empty record. A snapshot written before this field existed carries a
// zero time, and a session claiming to have been created at the zero instant
// would sort ahead of everything forever. Tags get the same treatment they get
// at spawn: empty rather than nil, since nil marshals to JSON null.
func TestReviveStampsCreatedAtWhenTheSnapshotHasNone(t *testing.T) {
	now := time.Date(2026, 8, 8, 11, 30, 0, 0, time.UTC)
	r := NewRegistry(func() time.Time { return now })
	s, err := r.Revive(Snapshot{V: 1, ID: "cafebabe00000005", Cwd: t.TempDir()})
	if err != nil {
		t.Fatalf("Revive: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })

	info := s.Info()
	if !info.CreatedAt.Equal(now) {
		t.Errorf("CreatedAt = %v, want the clock's %v for a snapshot that carried none",
			info.CreatedAt, now)
	}
	if info.Tags == nil {
		t.Error("Tags = nil, want an empty slice: nil serialises as JSON null")
	}
	if len(info.Tags) != 0 || info.Name != "" || info.Pinned {
		t.Errorf("revived metadata = %+v, want it empty when the snapshot had none", info)
	}
}
