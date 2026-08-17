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
	// Group travels so a split survives a restart as a split: members are just
	// sessions, and this is the one fact that makes them members. omitempty
	// keeps the ungrouped snapshot byte-compatible with what earlier daemons
	// wrote and read. There is no Ephemeral beside it, because an ephemeral
	// session is never snapshotted at all — see Session.Snapshot.
	Group string `json:"group,omitempty"`
	Cwd   string `json:"cwd"`
	Cols   uint16   `json:"cols"`
	Rows   uint16   `json:"rows"`
	// The ring's retained bytes. encoding/json carries []byte as base64.
	Ring      []byte    `json:"ring"`
	CreatedAt time.Time `json:"createdAt"`
	SavedAt   time.Time `json:"savedAt"`
	// ClaudeSession is the Claude Code conversation this session was most
	// plausibly working in, when there was one — see claude.go for how that
	// is judged and how weak the judgement is. Empty is the ordinary case:
	// most sessions are not running Claude Code, and nothing is printed for
	// them. It is an id, never a command; the command is assembled at revival,
	// so the wording lives in one place.
	ClaudeSession string `json:"claudeSession,omitempty"`
	// Attempts counts the boots that have already tried and failed to revive
	// this snapshot. Every snapshot a shutdown writes carries zero;
	// RecordReviveFailure raises it, and LoadSnapshots sweeps the file once it
	// reaches maxReviveAttempts — see both for why the count exists at all.
	// omitempty keeps the ordinary snapshot, the one that revives on its first
	// try and is cleared, byte-compatible with what earlier daemons wrote and
	// read.
	Attempts int `json:"attempts,omitempty"`
}

// reviveMarker separates the restored scrollback from the fresh shell, so
// the seam is visible instead of two shells' output reading as one.
var reviveMarker = []byte(
	"\r\n\x1b[2m── daemon restarted · previous shell ended here ──\x1b[0m\r\n\r\n")

// settleModes puts the emulator back into a state a fresh shell can be
// trusted in, and is written after the replayed scrollback and before the
// marker.
//
// A snapshot's ring is the bytes the dead shell wrote, and a program that was
// killed with the daemon wrote no epilogue: the sequence that turned a mode
// on is in the ring and the sequence that turns it back off was never
// written at all. Replay that into a client and its emulator ends the replay
// holding modes that belong to a program which no longer exists, with a
// brand new prompt behind them.
//
// The mouse block is the one that bites hardest, because it puts bytes on the
// wire with nobody typing. Mouse tracking left on means every pointer move
// over the terminal is encoded and sent, and the shell has no idea what an
// SGR report is, so it lands at the prompt as "35;61;22M35;61;21M…" — one
// run per pixel of travel. Focus reporting is the same trick with fewer
// bytes: ^[[I and ^[[O every time the tab is looked at. Application cursor
// keys is the quiet one, where the arrows send SS3 to a shell expecting CSI.
//
// The rest is display state rather than input, and is here because a shell
// nobody can read is its own kind of broken: a leftover scrolling region
// pins the new prompt inside a window the old program chose, the line-drawing
// charset renders every word as box art, and a hidden cursor stays hidden.
//
// The alternate screen is deliberately *not* left, though a dead full-screen
// program will have been in it. Leaving it would swap in a main buffer whose
// contents were evicted from the ring long ago, so the price of a tidier
// terminal would be showing the person an empty one where their scrollback
// used to be. What they have now is the last frame of the program that died,
// which is at least what they were looking at.
var settleModes = []byte(
	// Mouse reporting, every protocol and every encoding.
	"\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1016l" +
		// Focus reporting, bracketed paste, application cursor keys.
		"\x1b[?1004l\x1b[?2004l\x1b[?1l" +
		// Autowrap, a visible cursor, the full scrolling region.
		"\x1b[?7h\x1b[?25h\x1b[r" +
		// US-ASCII back in G0, and default attributes.
		"\x1b(B\x1b[m")

// reviveNote writes the seam, plus — when the snapshot knew of one — the
// command that picks the interrupted conversation back up.
//
// Printed rather than run. The daemon revives into a login shell and typing
// into somebody's terminal on their behalf is a different kind of act from
// restoring what they were looking at: the shell may have been in the middle
// of something, the id is a guess (claude.go says how much of one), and a
// command that ran itself would be one the user never chose and cannot
// un-choose. A line they can read and copy costs a keystroke and takes
// nothing away.
//
// The id is written between the command and the end of the line with no
// quoting, because it cannot need any: Claude Code names its transcripts with
// hex and hyphens, and latestClaudeSession only ever returns a filename it
// found on disk under that shape. Anything else would have failed the suffix
// test that let it out of the directory scan.
func reviveNote(claudeSession string) []byte {
	if claudeSession == "" {
		return reviveMarker
	}
	note := "\x1b[2mpick the Claude session back up with\x1b[0m \x1b[1mclaude --resume " +
		claudeSession + "\x1b[0m\r\n\r\n"
	out := make([]byte, 0, len(reviveMarker)+len(note))
	out = append(out, reviveMarker...)
	return append(out, note...)
}

// Snapshot captures what a revival needs. ok is false for an exited or
// closed session — those end with the daemon rather than coming back — and
// for an ephemeral one: a scratch terminal's life is bound to its parent's
// process, and the parent's revival is a fresh shell the old scratch has no
// standing beside.
func (s *Session) Snapshot() (Snapshot, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.info.State != "running" || s.info.Ephemeral {
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
		Group:  s.info.Group,
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
//
// The Claude Code lookup happens here rather than inside Session.Snapshot for
// one reason: it reads a directory, and s.mu is never held across a syscall.
// Snapshot returns with the lock released and the cwd already in hand, so the
// scan costs one readdir per running session on a shutdown path that is
// already writing a file per session.
func (r *Registry) Snapshots() []Snapshot {
	var out []Snapshot
	for _, s := range r.List() {
		snap, ok := s.Snapshot()
		if !ok {
			continue
		}
		snap.ClaudeSession = claudeSessionFor(snap.Cwd, snap.CreatedAt)
		out = append(out, snap)
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
	note := reviveNote(snap.ClaudeSession)
	preload := make([]byte, 0, len(snap.Ring)+len(settleModes)+len(note))
	preload = append(preload, snap.Ring...)
	// After the scrollback, so the replay cannot undo it, and before the
	// marker, so the seam is the first thing the settled terminal draws.
	preload = append(preload, settleModes...)
	preload = append(preload, note...)
	return r.start(
		SpawnOpts{Cwd: cwd, Cols: snap.Cols, Rows: snap.Rows},
		snap.ID, preload,
		Info{
			Title:     snap.Title,
			Name:      snap.Name,
			Tags:      snap.Tags,
			Pinned:    snap.Pinned,
			Group:     snap.Group,
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

// maxReviveAttempts is how many boots may try to revive one snapshot before
// LoadSnapshots sweeps it. It is the guard against a crash-loop-shaped
// leak: a snapshot whose revival reliably fails — a shell that is simply
// gone, a container with no /dev/ptmx — would otherwise be retried and
// re-logged by every boot forever, its scrollback sitting on disk the whole
// time. Three boots is enough for the transient causes to clear (fd
// pressure at a crowded startup) and for the fixable ones to be fixed (a
// $SHELL a package upgrade removed and a later upgrade restored); a fourth
// boot still failing is a snapshot that is not coming back, and it ages out.
const maxReviveAttempts = 3

// LoadSnapshots reads every snapshot in dir. It sweeps what nothing can use
// and leaves the rest on disk: a snapshot file is cleared by ClearSnapshot,
// on the caller's word that its session actually came back — never merely
// for having been read. (This function's predecessor, LoadAndClearSnapshots,
// deleted each file as it was read, which meant a spawn failure at the
// caller — a dangling $SHELL, /dev/ptmx exhaustion — permanently destroyed
// the very session it was about to revive.)
//
// Two kinds of file are swept here. One that does not parse, or parses to
// no id, is the old guarantee: corrupt state never wedges a startup, and a
// record nothing can read is not worth keeping around to fail again. One
// whose Attempts has reached maxReviveAttempts is the new one — see the
// constant for why sweeping it is what keeps preserving the others safe. A
// file that cannot be read at all is skipped in place rather than swept:
// nothing about it has been judged, and an unreadable file is the one this
// function has no license to destroy. A missing directory is simply no
// snapshots.
//
// Metadata files share this directory and their names end in ".json" too, so
// the suffix alone does not identify a snapshot. They are skipped explicitly,
// and the check is still load-bearing: a metadata file is valid JSON with no
// snapshot id, so without it every name and tag on the machine would be swept
// as corrupt by the next start — silently, since a snapshot loader has no
// reason to complain about a file it merely failed to parse.
func LoadSnapshots(dir string) []Snapshot {
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
		if err != nil {
			continue
		}
		var snap Snapshot
		if json.Unmarshal(b, &snap) != nil || snap.ID == "" {
			_ = os.Remove(path)
			continue
		}
		if snap.Attempts >= maxReviveAttempts {
			_ = os.Remove(path)
			continue
		}
		out = append(out, snap)
	}
	return out
}

// ClearSnapshot removes one snapshot's file, and is the only way a healthy
// snapshot leaves disk: its session is back, so the file has nothing left to
// say, and scrollback must not accumulate. Same guards as DeleteMeta, for
// the same reasons — idempotent, because the callers are cleanup paths, and
// refusing an empty dir or id rather than joining a relative path into
// whatever the working directory happens to hold.
func ClearSnapshot(dir, id string) {
	if dir == "" || id == "" {
		return
	}
	_ = os.Remove(filepath.Join(dir, id+".json"))
}

// RecordReviveFailure charges one failed revival against a snapshot's file,
// leaving everything else in it intact. That is the whole point of surviving
// the failure: the identity, name, tags and scrollback are still on disk
// when the cause has cleared, and a later boot's LoadSnapshots hands the
// snapshot back for another try — until the count reaches maxReviveAttempts
// and the load sweeps it instead.
//
// The write is best-effort, and a failure leaves the file exactly as it was:
// retried on every boot, never aging out. That corner errs deliberately on
// the side of the user's data — the boot still comes up, the retry costs a
// log line, and a directory this daemon cannot write to is not one it can
// bloat.
func RecordReviveFailure(dir string, snap Snapshot) {
	if dir == "" || snap.ID == "" {
		return
	}
	snap.Attempts++
	_ = writeSnapshot(dir, snap)
}
