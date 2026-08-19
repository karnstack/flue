package session

import (
	"bytes"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// TestSaveMetaRoundTripsAndKeepsItsModes pins the file's shape as well as its
// contents. A name and a tag set say what a human is working on, which is the
// same class of thing as the scrollback next to it in this directory, so the
// modes are the snapshot's: 0600 in a 0700 directory.
//
// Two sessions are written, because a loader that returned only the entry it
// happened to read last would satisfy every single-file assertion.
func TestSaveMetaRoundTripsAndKeepsItsModes(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "sessions")
	want := Meta{V: 1, Name: "deploy", Tags: []string{"prod", "web"}, Pinned: true}
	if err := SaveMeta(dir, "cafebabe00000001", want); err != nil {
		t.Fatalf("SaveMeta: %v", err)
	}
	if err := SaveMeta(dir, "cafebabe00000002", Meta{V: 1, Name: "the other one"}); err != nil {
		t.Fatalf("SaveMeta: %v", err)
	}

	di, err := os.Stat(dir)
	if err != nil {
		t.Fatalf("stat dir: %v", err)
	}
	if got := di.Mode().Perm(); got != 0o700 {
		t.Fatalf("dir mode = %o, want 0700", got)
	}
	path := filepath.Join(dir, "cafebabe00000001.meta.json")
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat meta: %v", err)
	}
	if got := fi.Mode().Perm(); got != 0o600 {
		t.Fatalf("file mode = %o, want 0600 — a name says what someone is working on", got)
	}

	metas := LoadMetas(dir)
	if len(metas) != 2 {
		t.Fatalf("LoadMetas returned %d entries, want both: %+v", len(metas), metas)
	}
	got := metas["cafebabe00000001"]
	if got.V != 1 || got.Name != "deploy" || !got.Pinned {
		t.Errorf("loaded %+v, want %+v", got, want)
	}
	if !slices.Equal(got.Tags, []string{"prod", "web"}) {
		t.Errorf("Tags = %#v, want the saved pair", got.Tags)
	}
	if metas["cafebabe00000002"].Name != "the other one" {
		t.Errorf("second meta = %+v, want its own name back", metas["cafebabe00000002"])
	}

	// Reading is not consuming, unlike a snapshot: metadata outlives every
	// daemon that reads it, and only a delete removes it.
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("the meta file did not survive a load: %v", err)
	}

	// A second save replaces rather than accumulating, and leaves no temp file
	// behind — the directory is read by name-suffix, so litter would be loaded.
	if err := SaveMeta(dir, "cafebabe00000001", Meta{V: 1, Name: "renamed"}); err != nil {
		t.Fatalf("SaveMeta over an existing file: %v", err)
	}
	if got := LoadMetas(dir)["cafebabe00000001"]; got.Name != "renamed" || got.Pinned {
		t.Errorf("after a rewrite, meta = %+v, want the new record and nothing of the old", got)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	if len(entries) != 2 {
		t.Errorf("%d files in the directory, want one per session", len(entries))
	}
}

// TestLoadMetasDropsWhatItCannotParse keeps a corrupt file from wedging a
// daemon start: it is deleted and skipped, and everything beside it still
// loads.
func TestLoadMetasDropsWhatItCannotParse(t *testing.T) {
	dir := t.TempDir()
	if err := SaveMeta(dir, "cafebabe00000003", Meta{V: 1, Name: "kept"}); err != nil {
		t.Fatalf("SaveMeta: %v", err)
	}
	broken := filepath.Join(dir, "cafebabe00000004.meta.json")
	if err := os.WriteFile(broken, []byte("not json"), 0o600); err != nil {
		t.Fatalf("write corrupt: %v", err)
	}

	metas := LoadMetas(dir)
	if len(metas) != 1 || metas["cafebabe00000003"].Name != "kept" {
		t.Fatalf("LoadMetas = %+v, want just the good record", metas)
	}
	if _, err := os.Stat(broken); !os.IsNotExist(err) {
		t.Errorf("the unparseable file survives (stat err %v), want it removed", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "cafebabe00000003.meta.json")); err != nil {
		t.Errorf("the good file went with it: %v", err)
	}

	if got := LoadMetas(filepath.Join(dir, "never-created")); len(got) != 0 {
		t.Errorf("a missing dir loaded %+v, want nothing", got)
	}
}

// TestDeleteMetaIsIdempotent covers the two ways it is called on a file that
// may not be there: an id nothing ever wrote, and a second delete of the same
// session. Neither is an error, and neither touches anybody else's file.
func TestDeleteMetaIsIdempotent(t *testing.T) {
	dir := t.TempDir()
	DeleteMeta(dir, "cafebabe00000005") // nothing written under this id at all

	if err := SaveMeta(dir, "cafebabe00000006", Meta{V: 1, Name: "going"}); err != nil {
		t.Fatalf("SaveMeta: %v", err)
	}
	if err := SaveMeta(dir, "cafebabe00000007", Meta{V: 1, Name: "staying"}); err != nil {
		t.Fatalf("SaveMeta: %v", err)
	}

	DeleteMeta(dir, "cafebabe00000006")
	DeleteMeta(dir, "cafebabe00000006")

	metas := LoadMetas(dir)
	if _, ok := metas["cafebabe00000006"]; ok {
		t.Error("the deleted session's meta is still loadable")
	}
	if metas["cafebabe00000007"].Name != "staying" {
		t.Errorf("LoadMetas = %+v, want the other session untouched", metas)
	}
}

// TestUpdateMetaFlushesToDisk is the whole point of the file: an edit made
// through the registry is on disk before the call returns, so a daemon that is
// killed rather than stopped still comes back knowing what things are called.
func TestUpdateMetaFlushesToDisk(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "sessions")
	r := NewRegistry(time.Now)
	r.SetMetaDir(dir, nil)
	s := spawnRunning(t, r)

	name, tags, pinned := "deploy", []string{"web", "prod"}, true
	if _, err := r.UpdateMeta(s.ID(), MetaPatch{Name: &name, Tags: &tags, Pinned: &pinned}); err != nil {
		t.Fatalf("UpdateMeta: %v", err)
	}

	got, ok := LoadMetas(dir)[s.ID()]
	if !ok {
		t.Fatalf("no meta file for %s after an edit", s.ID())
	}
	if got.V != 1 || got.Name != "deploy" || !got.Pinned {
		t.Errorf("persisted %+v, want the edit", got)
	}
	// Normalised on the way in, not on the way out: what is written is what
	// ApplyMeta settled on.
	if !slices.Equal(got.Tags, []string{"prod", "web"}) {
		t.Errorf("persisted Tags = %#v, want them normalised", got.Tags)
	}
}

// TestUpdateMetaWithoutAMetaDirWritesNothing pins the default. A registry that
// has not been told where to persist keeps everything in memory — which is what
// keeps the tests and a `flue open` with no config directory file-free.
func TestUpdateMetaWithoutAMetaDirWritesNothing(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "sessions")
	r := NewRegistry(time.Now)
	r.SetMetaDir(dir, nil)
	s := spawnRunning(t, r)

	first := "written"
	if _, err := r.UpdateMeta(s.ID(), MetaPatch{Name: &first}); err != nil {
		t.Fatalf("UpdateMeta: %v", err)
	}

	r.SetMetaDir("", nil)
	second := "in memory only"
	info, err := r.UpdateMeta(s.ID(), MetaPatch{Name: &second})
	if err != nil {
		t.Fatalf("UpdateMeta with no meta dir: %v", err)
	}
	if info.Name != "in memory only" {
		t.Errorf("Name = %q, want the edit to have landed in memory regardless", info.Name)
	}
	if got := LoadMetas(dir)[s.ID()].Name; got != "written" {
		t.Errorf("on-disk name = %q, want the earlier %q: a registry with no meta dir persisted anyway",
			got, "written")
	}
}

// TestUpdateMetaSurvivesAnUnwritableDir is the spec's degradation rule:
// durability degrades, the function does not. The edit still lands in memory
// and still comes back to the caller; the loss is a log line.
func TestUpdateMetaSurvivesAnUnwritableDir(t *testing.T) {
	// A regular file where the directory should be, so the write cannot even
	// get as far as creating its temp file.
	blocked := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(blocked, []byte("in the way"), 0o600); err != nil {
		t.Fatalf("write blocker: %v", err)
	}

	var logged bytes.Buffer
	r := NewRegistry(time.Now)
	r.SetMetaDir(blocked, slog.New(slog.NewTextHandler(&logged, nil)))
	s := spawnRunning(t, r)

	name := "named anyway"
	info, err := r.UpdateMeta(s.ID(), MetaPatch{Name: &name})
	if err != nil {
		t.Fatalf("UpdateMeta = %v, want the edit to succeed despite an unwritable dir", err)
	}
	if info.Name != "named anyway" {
		t.Errorf("returned Name = %q, want the edit", info.Name)
	}
	if live := s.Info().Name; live != "named anyway" {
		t.Errorf("Info().Name = %q, want the edit visible on the session", live)
	}
	if !strings.Contains(logged.String(), s.ID()) {
		t.Errorf("log = %q, want a line naming the session whose metadata was lost", logged.String())
	}
}

// TestReapDeletesTheMetaFile closes the loop the other way: a session the
// registry has finished with leaves nothing behind, and a session it has not
// keeps its file.
func TestReapDeletesTheMetaFile(t *testing.T) {
	base := time.Now()
	var offset atomic.Int64
	clock := func() time.Time { return base.Add(time.Duration(offset.Load())) }

	dir := filepath.Join(t.TempDir(), "sessions")
	r := NewRegistry(clock)
	r.SetMetaDir(dir, nil)

	survivor := spawnRunning(t, r)
	staying := "staying"
	if _, err := r.UpdateMeta(survivor.ID(), MetaPatch{Name: &staying}); err != nil {
		t.Fatalf("UpdateMeta: %v", err)
	}

	dying := spawnLocal(t, r, SpawnOpts{Cmd: []string{"true"}, Cols: 80, Rows: 24})
	t.Cleanup(func() { _ = dying.Close() })
	going := "going"
	if _, err := r.UpdateMeta(dying.ID(), MetaPatch{Name: &going}); err != nil {
		t.Fatalf("UpdateMeta: %v", err)
	}
	waitExited(t, dying, 5*time.Second)

	r.Reap()
	if _, ok := LoadMetas(dir)[dying.ID()]; !ok {
		t.Fatal("the meta file went before the retention window did")
	}

	offset.Store(int64(ExitedRetention + time.Second))
	r.Reap()

	metas := LoadMetas(dir)
	if _, ok := metas[dying.ID()]; ok {
		t.Error("the reaped session's meta file survives it")
	}
	if metas[survivor.ID()].Name != "staying" {
		t.Errorf("LoadMetas = %+v, want the live session's record untouched", metas)
	}
}

// TestLoadSnapshotsLeavesMetaFilesAlone is a regression test for the hazard
// of sharing a directory: ".meta.json" ends in ".json", and a meta file is
// valid JSON that parses to a Snapshot with no id — exactly the shape
// LoadSnapshots sweeps as corrupt. A loader that filtered on the suffix
// alone would delete every name and tag on the machine at the next daemon
// start, and the daemon would come up looking like it had worked.
func TestLoadSnapshotsLeavesMetaFilesAlone(t *testing.T) {
	dir := t.TempDir()
	const id = "cafebabe00000008"
	if err := SaveSnapshots(dir, []Snapshot{{V: 1, ID: id, Ring: []byte("scrollback")}}); err != nil {
		t.Fatalf("SaveSnapshots: %v", err)
	}
	if err := SaveMeta(dir, id, Meta{V: 1, Name: "named", Tags: []string{"prod"}, Pinned: true}); err != nil {
		t.Fatalf("SaveMeta: %v", err)
	}

	snaps := LoadSnapshots(dir)
	if len(snaps) != 1 || snaps[0].ID != id {
		t.Fatalf("loaded %+v, want the one snapshot — the meta file must not read as one", snaps)
	}
	if string(snaps[0].Ring) != "scrollback" {
		t.Errorf("ring = %q, want the saved bytes", snaps[0].Ring)
	}

	// Clearing after a revival lands is just as suffix-blind a moment: the
	// snapshot's file goes, and the meta file beside it — same id, longer
	// suffix — stays.
	ClearSnapshot(dir, id)
	if _, err := os.Stat(filepath.Join(dir, id+".json")); !os.IsNotExist(err) {
		t.Errorf("the snapshot file survives its clear (stat err %v), want it gone", err)
	}

	got, ok := LoadMetas(dir)[id]
	if !ok {
		t.Fatal("the snapshot load-and-clear ate the meta file")
	}
	if got.Name != "named" || !got.Pinned || !slices.Equal(got.Tags, []string{"prod"}) {
		t.Errorf("meta = %+v, want it whole", got)
	}
}

// TestAdoptMetasRestoresLiveSessionsAndClearsOrphans is what a daemon does at
// boot, after revival: every session that came back gets its name and tags
// again, and the records of sessions that did not come back are swept, so a
// crash cannot leave the directory growing forever.
func TestAdoptMetasRestoresLiveSessionsAndClearsOrphans(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "sessions")
	r := NewRegistry(time.Now)
	r.AdoptMetas("") // no meta dir configured is not a reason to fall over

	s := spawnRunning(t, r)
	if err := SaveMeta(dir, s.ID(), Meta{
		V: 1, Name: "deploy", Tags: []string{" web ", "prod", "prod"}, Pinned: true,
	}); err != nil {
		t.Fatalf("SaveMeta: %v", err)
	}
	const orphan = "cafebabe00000009"
	if err := SaveMeta(dir, orphan, Meta{V: 1, Name: "did not come back"}); err != nil {
		t.Fatalf("SaveMeta: %v", err)
	}

	if before := s.Info(); before.Name != "" || len(before.Tags) != 0 || before.Pinned {
		t.Fatalf("the session was already %+v, so adoption would prove nothing", before)
	}

	r.AdoptMetas(dir)

	info := s.Info()
	if info.Name != "deploy" || !info.Pinned {
		t.Errorf("adopted %+v, want the saved name and pin", info)
	}
	// Through ApplyMeta, so a hand-edited file's tags arrive normalised like
	// anybody else's.
	if !slices.Equal(info.Tags, []string{"prod", "web"}) {
		t.Errorf("Tags = %#v, want them normalised on the way in", info.Tags)
	}

	metas := LoadMetas(dir)
	if _, ok := metas[orphan]; ok {
		t.Error("an orphan record survives adoption")
	}
	if _, ok := metas[s.ID()]; !ok {
		t.Error("adoption deleted the record of a session that did come back")
	}
}
