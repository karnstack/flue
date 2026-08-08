package session

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// SnapshotsDirName is the subdirectory of the flue config directory that
// carries shutdown snapshots from one daemon to the next.
const SnapshotsDirName = "sessions"

// Snapshot is a session worth reviving: identity, place, and scrollback.
//
// It exists because the daemon is the session holder — its shells are its
// children and die with it — so a restart would otherwise be destructive.
// A snapshot brings the session back with its history and a fresh shell;
// the running process is the one thing it cannot carry.
//
// It carries the human-owned metadata as well as the machine-owned identity,
// which makes a graceful restart self-contained: the sessions come back named,
// tagged and pinned without anything else on disk having to be consulted. The
// metadata files beside these are written on a different schedule and read
// after the revival, so they remain the answer for a snapshot that predates a
// field rather than a second source for one that carries it. See Meta.
//
// CreatedAt travels because it is the one stamp a session must never lose. It
// is what a stable ordering is built on, and a restart that reset it would
// reshuffle every list in every client at once.
type Snapshot struct {
	V      int      `json:"v"`
	ID     string   `json:"id"`
	Title  string   `json:"title"`
	Name   string   `json:"name"`
	Tags   []string `json:"tags"`
	Pinned bool     `json:"pinned"`
	Cwd    string   `json:"cwd"`
	Cols   uint16   `json:"cols"`
	Rows   uint16   `json:"rows"`
	// The ring's retained bytes. encoding/json carries []byte as base64.
	Ring      []byte    `json:"ring"`
	CreatedAt time.Time `json:"createdAt"`
	SavedAt   time.Time `json:"savedAt"`
}

// reviveMarker separates the restored scrollback from the fresh shell, so
// the seam is visible instead of two shells' output reading as one.
var reviveMarker = []byte(
	"\r\n\x1b[2m── daemon restarted · previous shell ended here ──\x1b[0m\r\n\r\n")

// Snapshot captures what a revival needs. ok is false for an exited or
// closed session: those end with the daemon rather than coming back.
func (s *Session) Snapshot() (Snapshot, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.info.State != "running" {
		return Snapshot{}, false
	}
	ring, _ := s.ring.Since(s.ring.BaseSeq()) // a fresh copy, per Since
	return Snapshot{
		V:      1,
		ID:     s.id,
		Title:  s.info.Title,
		Name:   s.info.Name,
		Tags:   s.info.Tags,
		Pinned: s.info.Pinned,
		Cwd:    s.info.Cwd,
		Cols:   s.info.Cols,
		Rows:   s.info.Rows,
		Ring:   ring,
		// Both timestamps, and they are not the same question: when this session
		// began, and when this record of it was taken.
		CreatedAt: s.info.CreatedAt,
		SavedAt:   s.clock(),
	}, true
}

// Snapshots returns one Snapshot per running session — the set a shutdown
// should carry over.
func (r *Registry) Snapshots() []Snapshot {
	var out []Snapshot
	for _, s := range r.List() {
		if snap, ok := s.Snapshot(); ok {
			out = append(out, snap)
		}
	}
	return out
}

// Revive spawns a fresh login shell in a snapshot's place: the same id, so
// routes and bookmarks keep resolving, the same title, name, tags and pin, the
// same age, and the old scrollback preloaded ahead of a marker naming the
// restart. A cwd that no longer exists falls back to the home directory rather
// than failing the revival.
//
// A snapshot written before a field existed carries that field's zero value,
// and the one place that matters is CreatedAt: start reads the zero time as
// "stamp this one now" rather than dating the session to the epoch. Everything
// else is honestly empty when it is empty.
func (r *Registry) Revive(snap Snapshot) (*Session, error) {
	cwd := snap.Cwd
	if info, err := os.Stat(cwd); err != nil || !info.IsDir() {
		cwd, _ = os.UserHomeDir()
	}
	preload := make([]byte, 0, len(snap.Ring)+len(reviveMarker))
	preload = append(preload, snap.Ring...)
	preload = append(preload, reviveMarker...)
	return r.start(
		SpawnOpts{Cwd: cwd, Cols: snap.Cols, Rows: snap.Rows},
		snap.ID, preload,
		Info{
			Title:     snap.Title,
			Name:      snap.Name,
			Tags:      snap.Tags,
			Pinned:    snap.Pinned,
			CreatedAt: snap.CreatedAt,
		},
	)
}

// SaveSnapshots writes each snapshot to dir as <id>.json. Scrollback is
// terminal output and can hold secrets, so the files get the token file's
// treatment: 0600 in a 0700 directory, written to a fresh inode and renamed
// into place. The first error is reported; the rest of the snapshots are
// still attempted, because one unwritable session must not cost the others
// their revival.
func SaveSnapshots(dir string, snaps []Snapshot) error {
	if len(snaps) == 0 {
		return nil
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	var firstErr error
	for _, snap := range snaps {
		if err := writeSnapshot(dir, snap); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func writeSnapshot(dir string, snap Snapshot) error {
	b, err := json.Marshal(snap)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "snap-*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath) // no-op once the rename has succeeded
	// Before the bytes, not after: CreateTemp's 0600 already covers this on
	// the platforms flue targets, but the property is load-bearing enough to
	// state rather than inherit.
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpPath, filepath.Join(dir, snap.ID+".json"))
}

// LoadAndClearSnapshots reads every snapshot in dir, deleting each file as
// it is read: a snapshot belongs to exactly one daemon start, and scrollback
// must not accumulate on disk. A file that does not parse is deleted and
// skipped — corrupt state never wedges startup. A missing directory is
// simply no snapshots.
//
// Metadata files share this directory and their names end in ".json" too, so
// the suffix alone does not identify a snapshot. They are skipped explicitly:
// this function deletes what it reads, and metadata is the one thing here that
// must outlive the daemon that reads it. Without the check, every name and tag
// on the machine would be consumed by the next start — silently, since a
// snapshot loader has no reason to complain about a file it merely failed to
// parse.
func LoadAndClearSnapshots(dir string) []Snapshot {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []Snapshot
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		if strings.HasSuffix(e.Name(), metaSuffix) {
			continue
		}
		path := filepath.Join(dir, e.Name())
		b, err := os.ReadFile(path)
		_ = os.Remove(path)
		if err != nil {
			continue
		}
		var snap Snapshot
		if json.Unmarshal(b, &snap) != nil || snap.ID == "" {
			continue
		}
		out = append(out, snap)
	}
	return out
}
