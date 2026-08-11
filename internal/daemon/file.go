package daemon

import (
	"errors"
	"io"
	"io/fs"
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

// fileRead is one read in flight: an open file, the ref its chunks carry, and
// a way to tell the pump to stop.
type fileRead struct {
	ref  uint32
	f    *os.File
	done chan struct{}
}

// release ends every wait this read's pump can be in.
//
// A bare close rather than a sync.Once, because endRead's delete under c.mu
// already elects exactly one caller per ref: whichever of the pump, a cancel
// and closeAll takes the read out of the map is the one that gets here. A Once
// would guard nothing and would imply a second releaser exists, sending the
// next reader looking for one. If one is ever added, the panic is the better
// answer — two owners of one read is a bug, not a thing to absorb quietly.
func (r *fileRead) release() { close(r.done) }

func (r *fileRead) released() bool {
	select {
	case <-r.done:
		return true
	default:
		return false
	}
}

// startRead answers a read: resolve, decide, open, and start the pump.
//
// Everything that can refuse the request happens before a ref is minted, so a
// client that gets an error has nothing to clean up and a client that gets a
// file has a stream that is already running.
func (c *conn) startRead(m wire.Read) {
	s, ok := c.srv.reg.Get(m.ID)
	if !ok {
		c.sendErrorFor(m.ReqID, "not_found", "no such session")
		return
	}
	home, _ := os.UserHomeDir()
	abs, err := resolvePath(m.Path, s.Info().Cwd, home)
	if err != nil {
		c.sendErrorFor(m.ReqID, "bad_path", "not a usable path")
		return
	}
	// Symlinks resolve here rather than in resolvePath, which is pure so its
	// rules can be tested without a filesystem. The resolved path is what gets
	// opened and what file.path reports: a link means the file you get is not
	// the path you clicked, and a reader should be told what it actually
	// opened. EvalSymlinks also fails on a path that is not there, which is
	// where a missing file is usually caught.
	abs, err = filepath.EvalSymlinks(abs)
	if err != nil {
		c.sendErrorFor(m.ReqID, readErrCode(err), "cannot read that path")
		return
	}
	fi, err := os.Stat(abs)
	if err != nil {
		c.sendErrorFor(m.ReqID, readErrCode(err), "cannot read that path")
		return
	}
	if fi.IsDir() {
		c.sendErrorFor(m.ReqID, "is_dir", "that is a directory")
		return
	}
	if !fi.Mode().IsRegular() {
		// A socket, a device, a fifo. Opening one can block forever and none
		// of them has a size worth showing.
		c.sendErrorFor(m.ReqID, "unsupported", "not a regular file")
		return
	}

	f, err := os.Open(abs)
	if err != nil {
		c.sendErrorFor(m.ReqID, readErrCode(err), "cannot read that path")
		return
	}
	head := make([]byte, sniffBytes)
	n, err := io.ReadFull(f, head)
	if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
		_ = f.Close()
		c.sendErrorFor(m.ReqID, readErrCode(err), "cannot read that path")
		return
	}
	kind, mime, ok := classify(head[:n])
	if !ok {
		_ = f.Close()
		c.sendErrorFor(m.ReqID, "unsupported", "not a text or image file")
		return
	}
	limit := int64(maxFileBytes)
	if kind == "image" {
		// Refused rather than truncated: half a PNG is not a smaller PNG.
		if fi.Size() > maxImageBytes {
			_ = f.Close()
			c.sendErrorFor(m.ReqID, "too_large", "image is too large to show")
			return
		}
		limit = maxImageBytes
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		_ = f.Close()
		c.sendErrorFor(m.ReqID, readErrCode(err), "cannot read that path")
		return
	}

	c.mu.Lock()
	if len(c.reads) >= maxReads {
		c.mu.Unlock()
		_ = f.Close()
		c.sendErrorFor(m.ReqID, "busy", "too many reads at once")
		return
	}
	c.nextRef++
	r := &fileRead{ref: c.nextRef, f: f, done: make(chan struct{})}
	c.reads[r.ref] = r
	c.mu.Unlock()

	_ = c.sendControl(wire.File{
		Ref:       r.ref,
		Path:      abs,
		Size:      fi.Size(),
		Mime:      mime,
		Kind:      kind,
		Truncated: fi.Size() > limit,
		ReqID:     m.ReqID,
	})
	// Counted before the goroutine starts, so closeAll cannot observe zero
	// pumps for a read it has already registered.
	c.pumps.Add(1)
	go c.pump(r, limit)
}

// readErrCode maps a filesystem error to the code the client is told.
//
// Two outcomes, because two are all a client can act on: it may not read this,
// or there is nothing there. Anything else — a broken device, an interrupted
// syscall — reads as not_found, which is what the user sees anyway.
func readErrCode(err error) string {
	if errors.Is(err, fs.ErrPermission) {
		return "denied"
	}
	return "not_found"
}

// pump streams the file under its ref and ends with eof.
//
// One chunk in flight at a time; see sendChunk. The loop stops at limit rather
// than at the size read earlier, because a file can grow between the stat and
// the read and the cap is the promise that matters.
func (c *conn) pump(r *fileRead, limit int64) {
	defer c.pumps.Done()
	defer c.endRead(r.ref)

	buf := make([]byte, chunkBytes)
	var sent int64
	for sent < limit {
		want := int64(len(buf))
		if left := limit - sent; left < want {
			want = left
		}
		n, err := r.f.Read(buf[:want])
		if n > 0 {
			sent += int64(n)
			if !c.sendChunk(r, buf[:n]) {
				return
			}
		}
		if err != nil {
			break
		}
	}
	// A cancelled read is over, and eof would tell the client a stream it
	// abandoned finished cleanly.
	if r.released() {
		return
	}
	// Through the waiting path, like every chunk before it. sendControl would
	// mean a read that waited politely for room 256 times could still drop the
	// connection on the one frame that ends it; see sendControlWait.
	_ = c.sendControlWait(wire.Eof{Ref: r.ref}, r.done)
}

// sendChunk queues one chunk and waits for the writer to have written it.
//
// Two waits, for two different reasons, and both matter.
//
// enqueueWaitFor is the wait for *room*. The outbox can be full because the
// terminal is busy, and dropping a client over that would make opening a file
// during a burst of output an intermittent disconnect. A pump has somewhere to
// wait, so it waits — and it waits on r.done too, so a cancel reaches a pump
// parked here rather than only one parked below.
//
// The wait on `sent` is the wait for *the writer*, and it is what keeps only
// one chunk in flight. That bounds queued memory to 32 KiB rather than a whole
// file, keeps a read from ever filling the outbox by itself — an 8 MiB file is
// exactly outboxDepth chunks — and bounds what the next keystroke can be
// queued behind, on a socket that carries the terminal too.
//
// Neither costs throughput. A websocket write returns when the bytes reach the
// socket buffer, not when the far end acknowledges them, so this paces the pump
// against the link rather than against the round trip.
func (c *conn) sendChunk(r *fileRead, b []byte) bool {
	sent := make(chan struct{})
	if err := c.enqueueWaitFor(frame{b: wire.EncodeBinary(wire.FrameFile, r.ref, b), sent: sent}, r.done); err != nil {
		return false
	}
	select {
	case <-sent:
		return true
	case <-r.done:
		return false
	case <-c.ctx.Done():
		return false
	}
}

// endRead closes a read and forgets it. Safe to call twice: the pump ends every
// read it finishes, and a cancel or a dropped connection may have ended the
// same one already.
func (c *conn) endRead(ref uint32) {
	c.mu.Lock()
	r := c.reads[ref]
	delete(c.reads, ref)
	c.mu.Unlock()
	if r == nil {
		return
	}
	// Released before the file is closed, so every wait the pump can be in ends
	// at once: waiting for outbox room, waiting for the writer to have written
	// the chunk it queued, and waiting for room for the eof. All three select
	// on this channel. That is what makes a cancel stop a stream now rather
	// than at whatever point the writer next frees a slot — by which time the
	// chunk already encoded would go out under a ref the client has torn down.
	r.release()
	_ = r.f.Close()
}
