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

// TestReviveSettlesTheModesTheDeadShellLeftBehind is the fix for a session
// that came back reporting the pointer.
//
// The shell that died was inside a program holding mouse tracking on, and a
// killed program writes no reset. Replay that ring into a client and its
// emulator turns mouse reporting on with a fresh prompt behind it: every
// pointer move becomes an SGR report typed at the shell, which is what
// "35;61;22M35;61;21M…" at a prompt is. The same is true of focus reporting
// and of a leftover scrolling region or charset, none of which the new shell
// asked for and none of which it will clear.
func TestReviveSettlesTheModesTheDeadShellLeftBehind(t *testing.T) {
	r := NewRegistry(nil)
	s, err := r.Revive(Snapshot{
		V:    1,
		ID:   "cafebabe00000006",
		Cwd:  t.TempDir(),
		Ring: []byte("a program was here\x1b[?1003h\x1b[?1006h\x1b[?1004h"),
	})
	if err != nil {
		t.Fatalf("Revive: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })

	sub := s.Subscribe(0)
	defer s.Unsubscribe(sub)

	for _, mode := range []string{
		"\x1b[?1000l", "\x1b[?1002l", "\x1b[?1003l",
		"\x1b[?1005l", "\x1b[?1006l", "\x1b[?1015l", "\x1b[?1016l",
		"\x1b[?1004l", "\x1b[?2004l", "\x1b[?1l",
		"\x1b[?7h", "\x1b[?25h", "\x1b[r", "\x1b(B", "\x1b[m",
	} {
		if !bytes.Contains(sub.Backlog, []byte(mode)) {
			t.Fatalf("the revived backlog never clears %q: %q", mode, sub.Backlog)
		}
	}

	// Order is the whole point: clearing before the replay would be undone by
	// the very bytes it exists to answer for.
	settle := bytes.Index(sub.Backlog, []byte("\x1b[?1003l"))
	stale := bytes.Index(sub.Backlog, []byte("\x1b[?1003h"))
	marker := bytes.Index(sub.Backlog, []byte("daemon restarted"))
	if stale < 0 || !(stale < settle && settle < marker) {
		t.Fatalf("want the stale set, then the reset, then the marker; got %d, %d, %d in %q",
			stale, settle, marker, sub.Backlog)
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

// TestLoadSnapshotsSweepsCorruptAndKeepsReadable pins both halves of the
// load-time contract. A file that does not parse, or parses to no id, is
// swept — corrupt state never wedges a startup, and never comes back to fail
// again. A readable snapshot is returned and its file left on disk: loading
// is no longer consuming, because the caller has not yet said whether the
// session actually came back, and a revival that fails to spawn must find
// the file still there. Clearing is ClearSnapshot's job, on that word.
func TestLoadSnapshotsSweepsCorruptAndKeepsReadable(t *testing.T) {
	dir := t.TempDir()
	if err := SaveSnapshots(dir, []Snapshot{{V: 1, ID: "cafebabe00000004", Ring: []byte("kept")}}); err != nil {
		t.Fatalf("SaveSnapshots: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "broken.json"), []byte("not json"), 0o600); err != nil {
		t.Fatalf("write corrupt: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "idless.json"), []byte(`{"v":1}`), 0o600); err != nil {
		t.Fatalf("write idless: %v", err)
	}

	snaps := LoadSnapshots(dir)
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
	if len(entries) != 1 || entries[0].Name() != "cafebabe00000004.json" {
		t.Fatalf("dir holds %v, want only the good snapshot — corrupt swept, readable kept", entries)
	}

	// A second load finds the same snapshot again: nothing was consumed, so a
	// boot that dies between load and revive costs the session nothing.
	again := LoadSnapshots(dir)
	if len(again) != 1 || again[0].ID != "cafebabe00000004" || string(again[0].Ring) != "kept" {
		t.Fatalf("reloaded %+v, want the same snapshot back intact", again)
	}

	if got := LoadSnapshots(filepath.Join(dir, "never-created")); got != nil {
		t.Fatalf("a missing dir loaded %+v, want nothing", got)
	}
}

// TestClearSnapshotRemovesOnlyItsFile pins the success half of the contract:
// a revived snapshot's file is cleared, and nothing else — not another
// session's snapshot, and not the meta file that shares the id.
func TestClearSnapshotRemovesOnlyItsFile(t *testing.T) {
	dir := t.TempDir()
	if err := SaveSnapshots(dir, []Snapshot{
		{V: 1, ID: "cafebabe0000000a"},
		{V: 1, ID: "cafebabe0000000b"},
	}); err != nil {
		t.Fatalf("SaveSnapshots: %v", err)
	}
	if err := SaveMeta(dir, "cafebabe0000000a", Meta{V: 1, Name: "named"}); err != nil {
		t.Fatalf("SaveMeta: %v", err)
	}

	ClearSnapshot(dir, "cafebabe0000000a")
	ClearSnapshot(dir, "cafebabe0000000a") // idempotent: cleanup paths call it freely
	ClearSnapshot("", "cafebabe0000000b")  // refused, not joined into the working directory
	ClearSnapshot(dir, "")

	if _, err := os.Stat(filepath.Join(dir, "cafebabe0000000a.json")); !os.IsNotExist(err) {
		t.Errorf("the cleared snapshot survives (stat err %v), want it gone", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "cafebabe0000000b.json")); err != nil {
		t.Errorf("clearing one snapshot touched another: %v", err)
	}
	if _, ok := LoadMetas(dir)["cafebabe0000000a"]; !ok {
		t.Error("clearing the snapshot ate the meta file beside it")
	}
}

// TestReviveFailurePreservesTheSnapshot is issue #18's scenario end to end:
// a spawn failure at revival — here a $SHELL pointing at a binary that does
// not exist, the shape a package upgrade leaves behind — must not cost the
// session its identity or scrollback. The failure is recorded on the file,
// the next boot finds the snapshot whole, and once the cause has cleared the
// revival lands and the file is cleared the ordinary way.
func TestReviveFailurePreservesTheSnapshot(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "sessions")
	if err := SaveSnapshots(dir, []Snapshot{{
		V: 1, ID: "cafebabe0000000c", Name: "deploy",
		Ring: []byte("precious scrollback"), Cwd: t.TempDir(),
	}}); err != nil {
		t.Fatalf("SaveSnapshots: %v", err)
	}

	// loginShell trusts a non-empty $SHELL as long as it is absolute, so this
	// is exactly the dangling-shell failure: pty start fails at exec.
	t.Setenv("SHELL", "/no/such/shell/anywhere")

	r := NewRegistry(nil)
	snaps := LoadSnapshots(dir)
	if len(snaps) != 1 {
		t.Fatalf("loaded %d snapshots, want the saved one", len(snaps))
	}
	if _, err := r.Revive(snaps[0]); err == nil {
		t.Fatal("Revive succeeded under a nonexistent $SHELL; the failure path went unexercised")
	}
	RecordReviveFailure(dir, snaps[0])

	// The failed boot is over. The snapshot survived it, data intact, with
	// the one failure on the books.
	again := LoadSnapshots(dir)
	if len(again) != 1 || again[0].ID != "cafebabe0000000c" {
		t.Fatalf("after a failed revive the load found %+v, want the snapshot preserved", again)
	}
	if string(again[0].Ring) != "precious scrollback" || again[0].Name != "deploy" {
		t.Fatalf("preserved snapshot = %+v, want its ring and name untouched", again[0])
	}
	if again[0].Attempts != 1 {
		t.Fatalf("Attempts = %d after one failure, want 1", again[0].Attempts)
	}

	// The cause clears — the shell is back — and the next boot revives and
	// clears the file, the success half of the contract.
	t.Setenv("SHELL", "/bin/sh")
	s, err := r.Revive(again[0])
	if err != nil {
		t.Fatalf("Revive after the cause cleared: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	if s.Info().Name != "deploy" {
		t.Errorf("revived name = %q, want the snapshot's after a preserved retry", s.Info().Name)
	}
	ClearSnapshot(dir, again[0].ID)
	if left := LoadSnapshots(dir); len(left) != 0 {
		t.Fatalf("after a successful revive and clear, %+v remains, want nothing", left)
	}
}

// TestRepeatedReviveFailuresAgeTheSnapshotOut pins the crash-loop guard: a
// snapshot that fails maxReviveAttempts boots in a row is swept by the next
// load instead of being retried forever, so preserving snapshots on failure
// cannot turn into a boot that relives the same failure indefinitely or a
// directory that never shrinks.
func TestRepeatedReviveFailuresAgeTheSnapshotOut(t *testing.T) {
	dir := t.TempDir()
	if err := SaveSnapshots(dir, []Snapshot{{V: 1, ID: "cafebabe0000000d", Ring: []byte("doomed")}}); err != nil {
		t.Fatalf("SaveSnapshots: %v", err)
	}

	for boot := 1; boot <= maxReviveAttempts; boot++ {
		snaps := LoadSnapshots(dir)
		if len(snaps) != 1 {
			t.Fatalf("boot %d: loaded %d snapshots, want the failing one back for try %d of %d",
				boot, len(snaps), boot, maxReviveAttempts)
		}
		RecordReviveFailure(dir, snaps[0])
	}

	if snaps := LoadSnapshots(dir); len(snaps) != 0 {
		t.Fatalf("after %d failures the load returned %+v, want the snapshot aged out",
			maxReviveAttempts, snaps)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("%d files survive the age-out sweep, want none", len(entries))
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
	for _, snap := range LoadSnapshots(dir) {
		if _, err := second.Revive(snap); err != nil {
			t.Fatalf("Revive: %v", err)
		}
		ClearSnapshot(dir, snap.ID)
	}
	if entries, err := os.ReadDir(dir); err != nil || len(entries) != 0 {
		t.Fatalf("after a successful revive %d files remain (err %v), want the snapshot cleared",
			len(entries), err)
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
	snaps := LoadSnapshots(dir)
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
