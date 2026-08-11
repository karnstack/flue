package daemon

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/karnstack/flue/internal/wire"
)

// Reading a file the session named.
//
// The browser sends the text it matched in the terminal; this file turns that
// text into a path, decides whether it is something a reader can use, and
// streams it. The split is deliberate: only the daemon knows where the session
// actually is, and the resolution rules below are not reproducible from a tab.
//
// What may be read is anything the daemon's user can read. There is no fence,
// by decision rather than omission: a connection that reached this code can
// already spawn a shell in any directory and cat the same file, so a fence
// would refuse the paths an agent names most often — a scratch file in /tmp, a
// transcript under ~/.claude, a sibling worktree — while stopping nothing.
// Nothing here writes.
const (
	// chunkBytes is one content frame. Far under the relay's 1 MiB message cap
	// (relay/src/hub.ts, MAX_CLIENT_MESSAGE), and small enough that a
	// multi-megabyte read never puts more than 32 KiB in front of the next
	// keystroke: file content and terminal output share one socket.
	chunkBytes = 32 << 10

	// maxFileBytes is how much of a text file is sent. Past it the head is
	// streamed and file.truncated says so.
	maxFileBytes = 8 << 20

	// maxImageBytes is the ceiling for an image, which is refused rather than
	// truncated: half a PNG is not a smaller PNG.
	maxImageBytes = 4 << 20

	// maxReads is how many reads one connection may have open at once. The
	// bound is on held file descriptors and on how much of the socket a reader
	// can occupy; two is a viewer and the file it is about to replace.
	maxReads = 2

	// maxStatPaths bounds one stat. A hovered terminal line has nothing like
	// this many candidates on it.
	maxStatPaths = 32

	// maxPathLen is the longest path this will consider. PATH_MAX is 4096 on
	// Linux and 1024 on Darwin; the larger of the two is the right bound for a
	// refusal that exists to stop nonsense rather than to enforce a filesystem
	// limit the filesystem will enforce itself.
	maxPathLen = 4096
)

// errBadPath is every way a string fails to be a path worth resolving. One
// error rather than several: the client's only move is the same in each case,
// and naming which rule was broken tells a caller nothing it can act on.
var errBadPath = errors.New("daemon: not a usable path")

// resolvePath turns the text a client matched in the terminal into an absolute
// path.
//
//   - A leading ~ expands to home, the daemon user's own.
//   - A relative path resolves against cwd, the session's live working
//     directory, which session.Info re-reads from the kernel on every call.
//   - The result is cleaned, so exactly one string is opened, reported and
//     shown.
//
// A relative path that does not exist under cwd is a miss. There is no second
// attempt against the spawn directory or a guessed project root: two
// resolution rules would make "opened the wrong file" indistinguishable from
// "opened the right one" to everyone downstream.
//
// Symlinks are not resolved here. That needs the filesystem, and this function
// is pure so the rules above can be tested without one; the caller resolves
// them when it stats.
func resolvePath(raw, cwd, home string) (string, error) {
	p := strings.TrimSpace(raw)
	if p == "" || len(p) > maxPathLen || strings.ContainsRune(p, 0) {
		return "", errBadPath
	}
	switch {
	case p == "~":
		if home == "" {
			return "", errBadPath
		}
		p = home
	case strings.HasPrefix(p, "~/"):
		if home == "" {
			return "", errBadPath
		}
		p = filepath.Join(home, p[2:])
	case !filepath.IsAbs(p):
		if cwd == "" {
			return "", errBadPath
		}
		p = filepath.Join(cwd, p)
	}
	return filepath.Clean(p), nil
}

// statEntry answers one path: does it exist, and what is it.
//
// os.Stat rather than os.Lstat, so a symlink reads as whatever it points at.
// Following is the point — the reader wants the file at the end of the link,
// and a link reported as "other" would refuse to underline a path that opens
// perfectly well.
//
// Every failure is the same answer, exists false: a path that cannot be
// resolved, one that is not there, one in a directory this user cannot search.
// None of them is an error on the wire, because "no" is the ordinary answer to
// this question and the hover that asked it simply does not underline. It is
// also the answer that says least: a caller learns whether a path it already
// named is readable, and nothing about the shape of anything it did not name.
func statEntry(raw, cwd, home string) wire.PathEntry {
	e := wire.PathEntry{Path: raw}
	abs, err := resolvePath(raw, cwd, home)
	if err != nil {
		return e
	}
	fi, err := os.Stat(abs)
	if err != nil {
		return e
	}
	e.Exists = true
	switch {
	case fi.IsDir():
		e.Kind = "dir"
	case fi.Mode().IsRegular():
		e.Kind = "file"
	default:
		e.Kind = "other"
	}
	e.Size = fi.Size()
	e.Mtime = fi.ModTime().Unix()
	return e
}

// sniffBytes is how much of a file's head classify needs.
// http.DetectContentType reads at most this many and the extra would be
// discarded.
const sniffBytes = 512

// classify decides what a file is from its first bytes.
//
// From the content, never the extension. An extension is a claim by whoever
// named the file, and the two disagree constantly in a directory an agent has
// been writing in — a .txt holding a PNG, a .log holding a core dump, a file
// with no extension at all holding perfectly ordinary Go.
//
// Only text and images are accepted. Everything else is refused rather than
// sent, because the client has nothing to do with a zip but render it as
// mojibake, and sending megabytes for that is worse than saying no. That
// includes PDFs and archives, which are legible to something but not to a
// viewer this small.
//
// SVG lands in text, since http.DetectContentType reads it as XML. That is the
// honest answer here rather than a special case: this function knows what the
// bytes are, and an SVG genuinely is text — whether a viewer draws it is the
// viewer's decision to make later.
func classify(head []byte) (kind, mime string, ok bool) {
	mime = http.DetectContentType(head)
	base, _, _ := strings.Cut(mime, ";")
	switch {
	case strings.HasPrefix(base, "image/"):
		return "image", mime, true
	case strings.HasPrefix(base, "text/"):
		return "text", mime, true
	}
	return "", mime, false
}
