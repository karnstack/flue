package session

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// metaSuffix names a metadata file. It shares a directory with the snapshots,
// so it deliberately ends in ".json" too — anything reading that directory by
// suffix has to distinguish the two, and LoadAndClearSnapshots does.
const metaSuffix = ".meta.json"

// Meta is what a human decided about a session, kept apart from everything the
// session decided about itself.
//
// It is a separate file from the snapshot, and written at a different moment,
// which is the whole of the difference between them. A snapshot is taken once,
// on a graceful shutdown, and carries the metadata out with it — so a clean
// restart already has everything and needs nothing from here. This file is
// written the instant an edit lands, which makes it the only copy of what a
// user typed for as long as the daemon is up.
//
// That is a narrower claim than "it survives a crash", and the difference is
// worth stating plainly, because the two are easy to confuse. Nothing revives
// after a SIGKILL: no snapshot was written, so the next boot finds every record
// here describing a session that did not come back, and sweeps it. What the
// separation actually buys is independence from the snapshot's schedule and
// from its contents — this is applied after revival, so a snapshot taken by a
// daemon that predates these fields still comes back named, and an edit is
// durable from the moment it is made rather than from the next clean stop.
//
// V is the file's version rather than the record's. Nothing reads it yet; it is
// here so that a later shape can be recognised instead of guessed at.
type Meta struct {
	V      int      `json:"v"` // 1
	Name   string   `json:"name"`
	Tags   []string `json:"tags"`
	Pinned bool     `json:"pinned"`
}

// SaveMeta writes one session's metadata to dir as <id>.meta.json.
//
// Same treatment as a snapshot, for a weaker but real version of the same
// reason: what somebody called a session, and the tags they grouped it under,
// describe what they are working on. So 0600 in a 0700 directory, written to a
// fresh inode and renamed into place — a rename is atomic, which is what keeps
// a daemon that dies mid-write from leaving a half-written record for the next
// one to find.
func SaveMeta(dir, id string, m Meta) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "meta-*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath) // no-op once the rename has succeeded
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
	return os.Rename(tmpPath, filepath.Join(dir, id+metaSuffix))
}

// LoadMetas reads every metadata file in dir, keyed by session id.
//
// Reading is not consuming — the opposite of LoadAndClearSnapshots, and the
// distinction is the point of the two files. A snapshot belongs to one daemon
// start; a name belongs to the session for as long as it exists, so it stays on
// disk until the session is reaped or is found to be gone.
//
// A file that does not parse is deleted and skipped, on the same reasoning that
// governs a corrupt snapshot: corrupt state must never wedge a start, and a
// record nothing can read is not worth keeping around to fail again. A missing
// directory is simply no metadata.
func LoadMetas(dir string) map[string]Meta {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	out := map[string]Meta{}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), metaSuffix) {
			continue
		}
		id := strings.TrimSuffix(e.Name(), metaSuffix)
		if id == "" {
			continue
		}
		path := filepath.Join(dir, e.Name())
		b, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var m Meta
		if json.Unmarshal(b, &m) != nil {
			_ = os.Remove(path)
			continue
		}
		out[id] = m
	}
	return out
}

// DeleteMeta removes one session's metadata file. It is idempotent, and it is
// called from paths that are already cleaning up after something else — a reap,
// a boot sweep — so a file that is not there is the outcome asked for rather
// than a failure to report.
//
// An empty dir or id is refused rather than joined: with either missing the
// path would name something in the process's working directory, which is a
// stranger's file by definition.
func DeleteMeta(dir, id string) {
	if dir == "" || id == "" {
		return
	}
	_ = os.Remove(filepath.Join(dir, id+metaSuffix))
}
