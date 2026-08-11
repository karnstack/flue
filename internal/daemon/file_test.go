package daemon

import (
	"bytes"
	"context"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/karnstack/flue/internal/session"
	"github.com/karnstack/flue/internal/wire"
)

func TestResolvePathAgainstASession(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{"absolute is itself", "/etc/hosts", "/etc/hosts"},
		{"relative joins the session's cwd", "src/main.go", "/work/repo/src/main.go"},
		{"dot-relative joins it too", "./src/main.go", "/work/repo/src/main.go"},
		{"a parent walk is resolved, not refused", "../other/x.go", "/work/other/x.go"},
		{"tilde is the daemon user's home", "~/notes.md", "/home/karn/notes.md"},
		{"bare tilde is the home itself", "~", "/home/karn"},
		{"surrounding space is not part of the path", "  src/main.go  ", "/work/repo/src/main.go"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := resolvePath(tc.raw, "/work/repo", "/home/karn")
			if err != nil {
				t.Fatalf("resolvePath(%q): %v", tc.raw, err)
			}
			if got != tc.want {
				t.Errorf("resolvePath(%q) = %q, want %q", tc.raw, got, tc.want)
			}
		})
	}
}

// A parent walk is resolved rather than refused because there is nothing to
// refuse it on behalf of: this daemon reads anything its user can read, and a
// connection that reached it can already spawn a shell and cat the same file.
// The rule the test above pins is that the *result* is what gets opened, so
// there is one path in play and not two.

func TestResolvePathRefusesWhatCannotBeAPath(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		cwd  string
		home string
	}{
		{"empty", "", "/work/repo", "/home/karn"},
		{"only space", "   ", "/work/repo", "/home/karn"},
		{"a NUL byte", "src/ma\x00in.go", "/work/repo", "/home/karn"},
		{"longer than any path can be", "/" + strings.Repeat("a", maxPathLen), "/work/repo", "/home/karn"},
		{"relative with no cwd to resolve against", "src/main.go", "", "/home/karn"},
		{"tilde with no home to expand", "~/notes.md", "/work/repo", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got, err := resolvePath(tc.raw, tc.cwd, tc.home); err == nil {
				t.Errorf("resolvePath(%q) = %q, want an error", tc.raw, got)
			}
		})
	}
}

// TestResolvePathCleansTheResult keeps one path in play rather than two: the
// thing opened, the thing reported back, and the thing a client sees must be
// the same string.
func TestResolvePathCleansTheResult(t *testing.T) {
	got, err := resolvePath("src/../src/./main.go", "/work/repo", "/home/karn")
	if err != nil {
		t.Fatalf("resolvePath: %v", err)
	}
	if got != filepath.Clean(got) {
		t.Errorf("resolvePath = %q, which is not clean", got)
	}
	if got != "/work/repo/src/main.go" {
		t.Errorf("resolvePath = %q, want /work/repo/src/main.go", got)
	}
}

// statTree builds a directory with one of each thing stat has to tell apart.
func statTree(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "real.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if err := os.Mkdir(filepath.Join(dir, "sub"), 0o755); err != nil {
		t.Fatalf("Mkdir: %v", err)
	}
	if err := os.Symlink(filepath.Join(dir, "real.txt"), filepath.Join(dir, "link.txt")); err != nil {
		t.Fatalf("Symlink: %v", err)
	}
	return dir
}

func TestStatEntryTellsTheKindsApart(t *testing.T) {
	dir := statTree(t)

	file := statEntry("real.txt", dir, "/home/karn")
	if !file.Exists || file.Kind != "file" {
		t.Errorf("real.txt = %+v, want an existing file", file)
	}
	if file.Size != 5 {
		t.Errorf("real.txt size = %d, want 5", file.Size)
	}
	if file.Mtime == 0 {
		t.Error("real.txt carries no mtime")
	}
	if file.Path != "real.txt" {
		t.Errorf("Path = %q, want the text that was asked about", file.Path)
	}

	// A symlink to a file reads as the file. Following is the whole point: the
	// reader wants what is at the end of it.
	link := statEntry("link.txt", dir, "/home/karn")
	if !link.Exists || link.Kind != "file" {
		t.Errorf("link.txt = %+v, want an existing file", link)
	}

	sub := statEntry("sub", dir, "/home/karn")
	if !sub.Exists || sub.Kind != "dir" {
		t.Errorf("sub = %+v, want an existing dir", sub)
	}

	// Missing is an answer, not a failure. The hover that asked simply does
	// not underline.
	gone := statEntry("nope.txt", dir, "/home/karn")
	if gone.Exists {
		t.Errorf("nope.txt = %+v, want exists false", gone)
	}
	if gone.Kind != "" || gone.Size != 0 {
		t.Errorf("nope.txt = %+v, want nothing beside exists false", gone)
	}

	// So is a string that is not a path at all.
	junk := statEntry("", dir, "/home/karn")
	if junk.Exists {
		t.Errorf("empty path = %+v, want exists false", junk)
	}
}

func TestStatAnswersEveryPathInOrder(t *testing.T) {
	ts, reg := newTestServer(t)
	dir := statTree(t)
	s, err := reg.Spawn(session.SpawnOpts{Cmd: []string{"cat"}, Cwd: dir, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })

	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.Stat{ID: s.ID(), Paths: []string{"nope.txt", "real.txt", "sub"}, ReqID: 21})

	readUntil(t, c, func(msg any, _ []byte) bool {
		got, ok := msg.(wire.Stats)
		if !ok {
			return false
		}
		if got.ReqID != 21 {
			t.Fatalf("Stats.ReqID = %d, want 21", got.ReqID)
		}
		if len(got.Entries) != 3 {
			t.Fatalf("Stats.Entries = %+v, want three", got.Entries)
		}
		// In the order asked, so a client can match answers to the text it
		// matched them from without comparing paths it cannot reproduce.
		if got.Entries[0].Path != "nope.txt" || got.Entries[0].Exists {
			t.Errorf("entry 0 = %+v, want nope.txt missing", got.Entries[0])
		}
		if got.Entries[1].Path != "real.txt" || got.Entries[1].Kind != "file" {
			t.Errorf("entry 1 = %+v, want real.txt as a file", got.Entries[1])
		}
		if got.Entries[2].Kind != "dir" {
			t.Errorf("entry 2 = %+v, want sub as a dir", got.Entries[2])
		}
		return true
	})
}

func TestStatRefusesAnUnknownSessionAndTooManyPaths(t *testing.T) {
	ts, reg := newTestServer(t)
	dir := statTree(t)
	s, err := reg.Spawn(session.SpawnOpts{Cmd: []string{"cat"}, Cwd: dir, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })

	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.Stat{ID: "nosuchsession", Paths: []string{"real.txt"}, ReqID: 22})
	readUntil(t, c, func(msg any, _ []byte) bool {
		e, ok := msg.(wire.Error)
		if !ok {
			return false
		}
		if e.ReqID != 22 || e.Code != "not_found" {
			t.Fatalf("error = %+v, want not_found for reqId 22", e)
		}
		return true
	})

	// Exactly the ceiling is answered, because the refusal is for more than the
	// ceiling. Without this case a `>` turned into a `>=` refuses the largest
	// batch the protocol promises to take and every other test here still
	// passes, since nothing else asks for more than three paths at once.
	atCap := make([]string, maxStatPaths)
	for i := range atCap {
		atCap[i] = "real.txt"
	}
	writeControl(t, c, wire.Stat{ID: s.ID(), Paths: atCap, ReqID: 23})
	readUntil(t, c, func(msg any, _ []byte) bool {
		switch v := msg.(type) {
		case wire.Error:
			if v.ReqID == 23 {
				t.Fatalf("a stat of exactly maxStatPaths paths was refused with %+v", v)
			}
		case wire.Stats:
			if v.ReqID != 23 {
				return false
			}
			if len(v.Entries) != maxStatPaths {
				t.Fatalf("Stats.Entries has %d entries, want one per path asked about (%d)",
					len(v.Entries), maxStatPaths)
			}
			return true
		}
		return false
	})

	many := make([]string, maxStatPaths+1)
	for i := range many {
		many[i] = "real.txt"
	}
	writeControl(t, c, wire.Stat{ID: s.ID(), Paths: many, ReqID: 24})
	readUntil(t, c, func(msg any, _ []byte) bool {
		e, ok := msg.(wire.Error)
		if !ok {
			return false
		}
		if e.ReqID != 24 || e.Code != "bad_path" {
			t.Fatalf("error = %+v, want bad_path for reqId 24", e)
		}
		return true
	})
}

func TestClassifyAcceptsTextAndImagesAndNothingElse(t *testing.T) {
	png := []byte("\x89PNG\r\n\x1a\n" + strings.Repeat("\x00", 32))

	cases := []struct {
		name string
		head []byte
		kind string
		ok   bool
	}{
		{"go source", []byte("package main\n\nfunc main() {}\n"), "text", true},
		{"json", []byte(`{"name":"flue","private":true}`), "text", true},
		{"an empty file", nil, "text", true},
		{"utf-8 beyond ascii", []byte("// naïve — ✓\n"), "text", true},
		{"a png", png, "image", true},
		{"a compiled object", []byte("\x7fELF\x02\x01\x01\x00\x00\x00"), "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			kind, mime, ok := classify(tc.head)
			if ok != tc.ok {
				t.Fatalf("classify ok = %v, want %v (mime %q)", ok, tc.ok, mime)
			}
			if kind != tc.kind {
				t.Errorf("classify kind = %q, want %q (mime %q)", kind, tc.kind, mime)
			}
			if ok && mime == "" {
				t.Error("an accepted file carries no mime type")
			}
		})
	}
}

// The two tests below are about conn.go rather than about files, and they live
// here because the file pump is the only thing that needs the rule they pin.
// Trap two from this task's preamble: a full outbox means the terminal is busy,
// and a pump that read that as "this client is broken" would turn opening a
// file during a burst of output into an intermittent disconnect.

func TestEnqueueWaitForWaitsForRoom(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// No server and no writer: enqueueWaitFor touches neither, and a conn with
	// nothing draining it is exactly the condition under test.
	c := newConn(ctx, cancel, newPipeConn(), nil, "test", "", nil)
	for i := 0; i < outboxDepth; i++ {
		if err := c.enqueue(frame{text: true, b: []byte("{}")}); err != nil {
			t.Fatalf("filling the outbox at %d: %v", i, err)
		}
	}

	// A nil done, because the wait for room is the whole of what this pins: a
	// producer with an end signal has one more way out of the select, and the
	// test would then prove the wrong arm.
	done := make(chan error, 1)
	go func() { done <- c.enqueueWaitFor(frame{text: true, b: []byte("{}")}, nil) }()

	select {
	case err := <-done:
		t.Fatalf("enqueueWaitFor returned %v on a full outbox; it has to wait", err)
	case <-time.After(50 * time.Millisecond):
	}

	// The writer drains one frame, and the wait ends.
	<-c.out

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("enqueueWaitFor once there was room = %v, want nil", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("enqueueWaitFor did not proceed once there was room")
	}

	// And the connection is still alive. Waiting is not a fault, which is the
	// whole difference between this and enqueue.
	select {
	case <-ctx.Done():
		t.Fatal("a full outbox failed the connection")
	default:
	}
}

func TestEnqueueWaitForGivesUpWhenTheConnectionEnds(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	c := newConn(ctx, cancel, newPipeConn(), nil, "test", "", nil)
	for i := 0; i < outboxDepth; i++ {
		if err := c.enqueue(frame{text: true, b: []byte("{}")}); err != nil {
			t.Fatalf("filling the outbox at %d: %v", i, err)
		}
	}

	done := make(chan error, 1)
	go func() { done <- c.enqueueWaitFor(frame{text: true, b: []byte("{}")}, nil) }()

	// A peer that has stopped reading is what ends this wait in production:
	// the writer's own timeout fails the connection, which cancels this
	// context. Cancelling directly is that outcome without the ten seconds.
	cancel()

	select {
	case err := <-done:
		if !errors.Is(err, errConnClosed) {
			t.Fatalf("enqueueWaitFor after the connection ended = %v, want errConnClosed", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("enqueueWaitFor did not give up when the connection ended")
	}
}

// readTarget spawns a session rooted at dir, which is what a read's relative
// paths resolve against.
func readTarget(t *testing.T, reg *session.Registry, dir string) *session.Session {
	t.Helper()
	s, err := reg.Spawn(session.SpawnOpts{Cmd: []string{"cat"}, Cwd: dir, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func TestReadStreamsAFileAndEndsWithEof(t *testing.T) {
	ts, reg := newTestServer(t)
	dir := t.TempDir()
	// Bigger than one chunk, so the pacing path is the path under test rather
	// than an incidental single frame.
	body := strings.Repeat("the quick brown fox\n", 5000)
	if err := os.WriteFile(filepath.Join(dir, "notes.md"), []byte(body), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	s := readTarget(t, reg, dir)

	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.Read{ID: s.ID(), Path: "notes.md", ReqID: 31})

	var ref uint32
	readUntil(t, c, func(msg any, _ []byte) bool {
		f, ok := msg.(wire.File)
		if !ok {
			return false
		}
		if f.ReqID != 31 {
			t.Fatalf("File.ReqID = %d, want 31", f.ReqID)
		}
		if f.Kind != "text" {
			t.Fatalf("File.Kind = %q, want text", f.Kind)
		}
		if f.Size != int64(len(body)) {
			t.Fatalf("File.Size = %d, want %d", f.Size, len(body))
		}
		if f.Truncated {
			t.Fatal("File.Truncated is set on a file well under the cap")
		}
		// The resolved path, not the text that was asked about. Resolved the
		// way the daemon resolves it: on macOS t.TempDir() sits under
		// /var/folders, which is itself a symlink to /private/var, so a path
		// assembled from `dir` would not match what the daemon opened.
		want, err := filepath.EvalSymlinks(filepath.Join(dir, "notes.md"))
		if err != nil {
			t.Fatalf("EvalSymlinks: %v", err)
		}
		if f.Path != want {
			t.Fatalf("File.Path = %q, want the resolved path %q", f.Path, want)
		}
		if f.Ref == 0 {
			t.Fatal("File.Ref = 0; refs are numbered from 1")
		}
		ref = f.Ref
		return true
	})

	readUntilFrames(t, c, func(msg any, out []byte, frames []binFrame) bool {
		e, ok := msg.(wire.Eof)
		if !ok {
			return false
		}
		if e.Ref != ref {
			t.Fatalf("Eof.Ref = %d, want %d", e.Ref, ref)
		}
		if string(out) != body {
			t.Fatalf("streamed %d bytes, want %d", len(out), len(body))
		}
		// The header, not just the bytes. This is the only assertion in the
		// suite that looks at it, and it is the one that keeps file content out
		// of the terminal: a client routes on the frame type and then on the
		// ref, so content sent as 0x01 is pasted into whatever the reader was
		// attached to, and content sent under a ref nobody holds is dropped on
		// the floor. Both mutations leave every other assertion here green,
		// because every other assertion only accumulates payload bytes.
		if len(frames) == 0 {
			t.Fatal("the file arrived in no binary frames at all")
		}
		for i, f := range frames {
			if f.typ != wire.FrameFile {
				t.Fatalf("chunk %d is frame type 0x%02x, want 0x%02x: file content is not terminal output",
					i, f.typ, wire.FrameFile)
			}
			if f.ref != ref {
				t.Fatalf("chunk %d carries ref %d, want the read's own %d", i, f.ref, ref)
			}
		}
		return true
	})
}

func TestReadSendsTheHeadOfATooLargeFileAndSaysSo(t *testing.T) {
	ts, reg := newTestServer(t)
	dir := t.TempDir()
	// One byte over the cap: the smallest file that proves the boundary.
	body := bytes.Repeat([]byte("x"), maxFileBytes+1)
	if err := os.WriteFile(filepath.Join(dir, "big.log"), body, 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	s := readTarget(t, reg, dir)

	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.Read{ID: s.ID(), Path: "big.log", ReqID: 32})

	readUntil(t, c, func(msg any, _ []byte) bool {
		f, ok := msg.(wire.File)
		if !ok {
			return false
		}
		if !f.Truncated {
			t.Fatal("File.Truncated is not set on a file over the cap")
		}
		// The real size, so a viewer can say how much it is not showing.
		if f.Size != int64(len(body)) {
			t.Fatalf("File.Size = %d, want the real %d", f.Size, len(body))
		}
		return true
	})
	readUntil(t, c, func(msg any, out []byte) bool {
		if _, ok := msg.(wire.Eof); !ok {
			return false
		}
		if len(out) != maxFileBytes {
			t.Fatalf("streamed %d bytes, want exactly the cap %d", len(out), maxFileBytes)
		}
		return true
	})
}

// pngOfSize writes a file of exactly size bytes that the daemon reads as a PNG.
//
// A real PNG signature and then filler. classify sniffs the first 512 bytes and
// nothing behind them changes its answer, so the honest fixture for a test about
// the size cap is the header the sniffer looks for with the right number of
// bytes standing behind it.
func pngOfSize(t *testing.T, dir, name string, size int) string {
	t.Helper()
	sig := []byte("\x89PNG\r\n\x1a\n")
	if size < len(sig) {
		t.Fatalf("a png cannot be %d bytes", size)
	}
	body := make([]byte, size)
	copy(body, sig)
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, body, 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	return path
}

// TestReadRefusesAnImageOverTheCapAndSendsOneAtIt pins the promise the protocol
// makes without any qualification: an image is refused past 4 MiB rather than
// truncated, because half a PNG is not a smaller PNG.
//
// The refusal had no coverage at all before this, which is a strange gap for a
// branch that is the whole reason images have a cap of their own. Delete it and
// a 30 MiB PNG streams to 4 MiB and arrives with truncated false, so the client
// renders a broken image and is told nothing went wrong.
//
// Both sides of the boundary, one byte apart, because a test that used a wildly
// oversized file would pass on any cap at all and pin nothing about where the
// line actually is. maxImageBytes exactly is the largest image that may be read:
// the refusal is a strict greater-than, and the file below it is the one that
// proves that is deliberate.
func TestReadRefusesAnImageOverTheCapAndSendsOneAtIt(t *testing.T) {
	ts, reg := newTestServer(t)
	dir := t.TempDir()
	pngOfSize(t, dir, "over.png", maxImageBytes+1)
	pngOfSize(t, dir, "at.png", maxImageBytes)
	s := readTarget(t, reg, dir)

	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.Read{ID: s.ID(), Path: "over.png", ReqID: 101})
	readUntil(t, c, func(msg any, _ []byte) bool {
		switch v := msg.(type) {
		case wire.File:
			t.Fatalf("an image one byte over the cap was answered with %+v, want a refusal", v)
		case wire.Error:
			// Correlated, like every other refusal: a reader has one viewer per
			// reqId and an error it cannot match is an error it cannot show.
			if v.ReqID != 101 {
				t.Fatalf("Error.ReqID = %d, want 101", v.ReqID)
			}
			if v.Code != "too_large" {
				t.Fatalf("Error.Code = %q, want too_large", v.Code)
			}
			return true
		}
		return false
	})

	writeControl(t, c, wire.Read{ID: s.ID(), Path: "at.png", ReqID: 102})
	readUntil(t, c, func(msg any, _ []byte) bool {
		switch v := msg.(type) {
		case wire.Error:
			t.Fatalf("an image exactly at the cap was refused with %+v", v)
		case wire.File:
			if v.ReqID != 102 {
				t.Fatalf("File.ReqID = %d, want 102", v.ReqID)
			}
			if v.Kind != "image" {
				t.Fatalf("File.Kind = %q, want image", v.Kind)
			}
			if v.Mime != "image/png" {
				t.Fatalf("File.Mime = %q, want image/png", v.Mime)
			}
			if v.Size != int64(maxImageBytes) {
				t.Fatalf("File.Size = %d, want the cap %d", v.Size, maxImageBytes)
			}
			// The one thing an image never says. If it did, the cap would have
			// become a truncation point and the refusal above would be the only
			// thing standing between a reader and half a picture.
			if v.Truncated {
				t.Fatal("an image at the cap says it was truncated; images are refused, not cut")
			}
			return true
		}
		return false
	})
}

func TestReadRefusesWhatItCannotShow(t *testing.T) {
	ts, reg := newTestServer(t)
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "sub"), 0o755); err != nil {
		t.Fatalf("Mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "a.out"), []byte("\x7fELF\x02\x01\x01\x00\x00\x00"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	s := readTarget(t, reg, dir)

	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})

	cases := []struct {
		reqID uint64
		path  string
		code  string
	}{
		{41, "nope.txt", "not_found"},
		{42, "sub", "is_dir"},
		{43, "a.out", "unsupported"},
		{44, "", "bad_path"},
	}
	for _, tc := range cases {
		writeControl(t, c, wire.Read{ID: s.ID(), Path: tc.path, ReqID: tc.reqID})
		readUntil(t, c, func(msg any, _ []byte) bool {
			e, ok := msg.(wire.Error)
			if !ok {
				return false
			}
			if e.ReqID != tc.reqID {
				return false
			}
			if e.Code != tc.code {
				t.Errorf("read %q: code = %q, want %q", tc.path, e.Code, tc.code)
			}
			return true
		})
	}
}

// TestReadRefusesAFifoWithoutOpeningIt pins the rule that a fifo is refused
// from its stat, and never touched.
//
// Opening one is not an observation, it is an act. A fifo has a process on the
// other end of it, parked in open() until someone opens this end: `cmd > /tmp/p`
// in a shell is exactly that, and it is a shape that turns up in a terminal
// often enough to be underlined. A daemon that opened the fifo to look at it
// would unpark that process, hand it a reader that closes a moment later, and
// kill it with SIGPIPE. So the assertion is not only that the read is refused,
// but that the writer on the other end is still parked afterwards.
//
// The refusal itself is ordinary: a fifo has no size worth showing and is not
// what a viewer asked for.
//
// It is deterministic in the direction that matters. Nothing else in this test
// opens the fifo, so the only thing that can unpark the writer is the daemon
// doing it, and the daemon would have done it before writing the refusal this
// test waits for. The window after that is slack for the scheduler, not for the
// event.
func TestReadRefusesAFifoWithoutOpeningIt(t *testing.T) {
	ts, reg := newTestServer(t)
	dir := t.TempDir()
	fifo := filepath.Join(dir, "pipe")
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Fatalf("Mkfifo: %v", err)
	}

	// The process on the other end. It parks in open() and stays there until
	// something opens the read end.
	var w *os.File
	unparked := make(chan struct{})
	go func() {
		defer close(unparked)
		w, _ = os.OpenFile(fifo, os.O_WRONLY, 0)
	}()
	t.Cleanup(func() {
		// Unparked deliberately on the way out, so the goroutine and its
		// descriptor do not outlive the test. Opening the read end is what
		// releases a writer blocked in open, which is the whole point above.
		r, err := os.OpenFile(fifo, os.O_RDONLY|syscall.O_NONBLOCK, 0)
		if err != nil {
			return
		}
		<-unparked
		if w != nil {
			_ = w.Close()
		}
		_ = r.Close()
	})

	// Parked before the read is sent, so anything that unparks it from here on
	// is the daemon and nothing else.
	select {
	case <-unparked:
		t.Fatal("the writer was not parked in open(); this test cannot observe what it exists for")
	case <-time.After(50 * time.Millisecond):
	}

	s := readTarget(t, reg, dir)
	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.Read{ID: s.ID(), Path: "pipe", ReqID: 47})
	readUntil(t, c, func(msg any, _ []byte) bool {
		e, ok := msg.(wire.Error)
		if !ok {
			return false
		}
		if e.ReqID != 47 || e.Code != "unsupported" {
			t.Fatalf("error = %+v, want unsupported for reqId 47", e)
		}
		return true
	})

	select {
	case <-unparked:
		t.Fatal("refusing a fifo opened it: the writer parked on the other end was released, which for a shell running `cmd > /tmp/p` means losing its pipe and dying of SIGPIPE")
	case <-time.After(100 * time.Millisecond):
	}
}

// TestReadRefusesASocketAsUnsupported is the same rule from the other side: the
// refusal has to come from the stat, because open() cannot produce it.
//
// A unix socket stats as kind "other", which is real enough for a client to
// underline, and open(2) on one fails with EOPNOTSUPP on Darwin and ENXIO on
// Linux. Neither is a permission error, so a daemon that decided from the open
// would answer not_found: the same daemon that just said the path exists would
// then say it is not there. unsupported is what the protocol promises for
// anything that is not a regular file, and it is the answer a reader can make
// sense of.
func TestReadRefusesASocketAsUnsupported(t *testing.T) {
	ts, reg := newTestServer(t)
	// Not t.TempDir(): a unix socket path is bounded at 104 bytes on Darwin and
	// 108 on Linux, and the temp directory a test gets named after this function
	// is most of that on its own.
	dir, err := os.MkdirTemp("/tmp", "flue-sock")
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })

	ln, err := net.Listen("unix", filepath.Join(dir, "agent.sock"))
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	t.Cleanup(func() { _ = ln.Close() })

	s := readTarget(t, reg, dir)
	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})

	// Stat first, because the two answers have to agree. A path this daemon
	// calls real is not a path it may then call missing.
	writeControl(t, c, wire.Stat{ID: s.ID(), Paths: []string{"agent.sock"}, ReqID: 48})
	readUntil(t, c, func(msg any, _ []byte) bool {
		got, ok := msg.(wire.Stats)
		if !ok {
			return false
		}
		if len(got.Entries) != 1 {
			t.Fatalf("Stats.Entries = %+v, want one", got.Entries)
		}
		if !got.Entries[0].Exists || got.Entries[0].Kind != "other" {
			t.Fatalf("entry = %+v, want an existing path of kind other", got.Entries[0])
		}
		return true
	})

	writeControl(t, c, wire.Read{ID: s.ID(), Path: "agent.sock", ReqID: 49})
	readUntil(t, c, func(msg any, _ []byte) bool {
		e, ok := msg.(wire.Error)
		if !ok {
			return false
		}
		if e.ReqID != 49 {
			return false
		}
		if e.Code != "unsupported" {
			t.Fatalf("Error.Code = %q, want unsupported: %q is what a client is told about a path that is not there, and this one is", e.Code, e.Code)
		}
		return true
	})
}

// TestReadReportsThePathItActuallyOpened. A symlink means the file you get is
// not the path you clicked, and file.path is where the reader finds that out.
func TestReadReportsThePathItActuallyOpened(t *testing.T) {
	ts, reg := newTestServer(t)
	dir := t.TempDir()
	target := filepath.Join(dir, "real.md")
	if err := os.WriteFile(target, []byte("# real\n"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if err := os.Symlink(target, filepath.Join(dir, "link.md")); err != nil {
		t.Fatalf("Symlink: %v", err)
	}
	s := readTarget(t, reg, dir)

	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.Read{ID: s.ID(), Path: "link.md", ReqID: 46})

	// The temp dir itself can be behind a symlink (/var -> /private/var on
	// macOS), so the expectation is resolved the same way the daemon resolves
	// it rather than assembled from the path this test wrote.
	want, err := filepath.EvalSymlinks(target)
	if err != nil {
		t.Fatalf("EvalSymlinks: %v", err)
	}
	readUntil(t, c, func(msg any, _ []byte) bool {
		f, ok := msg.(wire.File)
		if !ok {
			return false
		}
		if f.Path != want {
			t.Fatalf("File.Path = %q, want the link's target %q", f.Path, want)
		}
		return true
	})
}

func TestReadRefusesAnUnknownSession(t *testing.T) {
	ts, _ := newTestServer(t)
	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.Read{ID: "nosuchsession", Path: "x.txt", ReqID: 45})
	readUntil(t, c, func(msg any, _ []byte) bool {
		e, ok := msg.(wire.Error)
		if !ok {
			return false
		}
		if e.ReqID != 45 || e.Code != "not_found" {
			t.Fatalf("error = %+v, want not_found for reqId 45", e)
		}
		return true
	})
}

// TestCloseAllWaitsForEveryPump pins trap three where it can be pinned: on
// closeAll itself.
//
// A pump is a goroutine holding a file descriptor, and closeAll is the only
// thing that waits for one. Pumps do all end on their own — every wait a pump
// can be in selects on the connection's context, which serve cancels a moment
// before this runs — and that is exactly why the interleaving is not reachable
// from outside: driven through serve, the pump nearly always finishes before
// closeAll reaches it. The WaitGroup exists for the times it does not, so the
// contract is asserted here directly, against a stand-in pump that is
// deliberately slow to unwind. Without the wait, serve would return while a
// goroutine was still touching this connection, and the race report would land
// in whatever ran next.
func TestCloseAllWaitsForEveryPump(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := newConn(ctx, cancel, newPipeConn(), nil, "test", "", nil)

	path := filepath.Join(t.TempDir(), "held.txt")
	if err := os.WriteFile(path, []byte("held"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	r := &fileRead{ref: 1, f: f, done: make(chan struct{})}
	c.mu.Lock()
	c.reads[r.ref] = r
	c.mu.Unlock()

	// A stand-in for a pump parked on a chunk: released by endRead, and then
	// slow enough on the way out that "closeAll waited" and "closeAll happened
	// to win the race anyway" are two different observations rather than one.
	stopped := make(chan struct{})
	c.pumps.Add(1)
	go func() {
		defer c.pumps.Done()
		<-r.done
		time.Sleep(50 * time.Millisecond)
		close(stopped)
	}()

	done := make(chan struct{})
	go func() { c.closeAll(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("closeAll never returned; the read it ended left it waiting forever")
	}
	select {
	case <-stopped:
	default:
		t.Fatal("closeAll returned while a pump was still holding this connection's file")
	}

	// And the descriptor went with it. A dropped connection that kept its open
	// files would leak one per read for as long as the daemon runs.
	if _, err := f.Read(make([]byte, 1)); !errors.Is(err, os.ErrClosed) {
		t.Fatalf("reading the read's file after closeAll = %v, want it closed", err)
	}
	c.mu.Lock()
	left := len(c.reads)
	c.mu.Unlock()
	if left != 0 {
		t.Fatalf("closeAll left %d reads registered", left)
	}
}

// TestClosingAConnectionMidReadEndsItsPump is the same teardown along the live
// path: a tab that closes while its file is still arriving. What it pins is
// that the connection comes down promptly rather than parking in closeAll's
// wait — and it is the one case in this file where a file is closed out from
// under a pump that may still be reading it, which is safe (poll.FD
// reference-counts the descriptor) and worth having a race build walk over.
func TestClosingAConnectionMidReadEndsItsPump(t *testing.T) {
	_, reg, srv := newTestServerUI(t, http.NotFoundHandler())
	dir := t.TempDir()
	// The whole cap, so there is plenty left to send when the client leaves:
	// 256 chunks against a pipe that holds 64 and a reader that has stopped
	// reading.
	if err := os.WriteFile(filepath.Join(dir, "big.log"), bytes.Repeat([]byte("x"), maxFileBytes), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	s := readTarget(t, reg, dir)

	p := newPipeConn()
	done := make(chan struct{})
	go func() { srv.ServeConn(context.Background(), p, ConnMeta{Peer: "test"}); close(done) }()
	if _, ok := expectControl(t, p).(wire.Welcome); !ok {
		t.Fatal("first frame was not a welcome")
	}

	b, err := wire.EncodeControl(wire.Read{ID: s.ID(), Path: "big.log", ReqID: 51})
	if err != nil {
		t.Fatalf("EncodeControl: %v", err)
	}
	p.in <- pipeMsg{text: true, data: b}
	// file is queued before the pump starts, so it is the next control frame
	// and its arrival means the goroutine exists.
	if _, ok := expectControl(t, p).(wire.File); !ok {
		t.Fatal("the read was not answered with a file")
	}

	// The tab closes, mid-stream, which is the ordinary way a read ends.
	_ = p.Close()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("ServeConn did not return while a read was still streaming")
	}
}

// heldRead registers one read on c over a real file, the way startRead would,
// and hands back the file so a test can prove the descriptor was released.
func heldRead(t *testing.T, c *conn, ref uint32, body string) (*fileRead, *os.File) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "held.txt")
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	// A real descriptor per call, and no caller of this helper ever ends the
	// read it registers, so without this the file would stay open for the life
	// of the test binary. Closing here covers every call site at once, and it is
	// safe next to the tests that end the read themselves: those assert on the
	// error from a *read* after the close, and a second Close is a no-op whose
	// error nothing here looks at.
	t.Cleanup(func() { _ = f.Close() })
	r := &fileRead{ref: ref, f: f, done: make(chan struct{})}
	c.mu.Lock()
	c.reads[ref] = r
	c.mu.Unlock()
	return r, f
}

// fdScanLimit is how many descriptor numbers fileIsOpen looks at. Well past
// what a test binary opens, and cheap: an fstat on a number nothing is using
// returns EBADF immediately.
const fdScanLimit = 4096

// fileIsOpen reports whether this process still holds a descriptor on path.
//
// By fstat over the descriptor numbers rather than by listing /dev/fd, which
// Darwin does not let a process read reliably, and by inode rather than by
// name. So a path replaced since it was opened cannot make this say yes, and a
// second open of the same file cannot make it say no.
//
// It exists for one assertion: that a refusal closes the file it opened before
// it decided to refuse. Nothing else in this package can see that, because the
// descriptor never leaves startRead. A scan that found nothing because it
// looked in the wrong place would pass that assertion while observing nothing,
// so the caller proves the scan against a descriptor it holds itself first.
func fileIsOpen(t *testing.T, path string) bool {
	t.Helper()
	var want syscall.Stat_t
	if err := syscall.Stat(path, &want); err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}
	for fd := 0; fd < fdScanLimit; fd++ {
		var got syscall.Stat_t
		// An unused number, or one holding something an fstat cannot describe.
		// Neither is the file being looked for.
		if err := syscall.Fstat(fd, &got); err != nil {
			continue
		}
		if got.Dev == want.Dev && got.Ino == want.Ino {
			return true
		}
	}
	return false
}

// fillOutbox puts the outbox at its depth, which is what a session redrawing at
// speed does to it. The connection is fine; the writer is behind.
func fillOutbox(t *testing.T, c *conn) {
	t.Helper()
	for i := 0; i < outboxDepth; i++ {
		if err := c.enqueue(frame{text: true, b: []byte("{}")}); err != nil {
			t.Fatalf("filling the outbox at %d: %v", i, err)
		}
	}
}

// TestEndingAReadUnparksAPumpWaitingForRoom is the other half of trap two, and
// the half that is easy to leave open.
//
// A pump has two places it waits: for room in the outbox, and for the writer to
// have written the chunk it queued. Ending the read has to reach both. If it
// reaches only the second, then with a full outbox a cancel closes the file and
// returns while the pump stays parked holding an encoded chunk — which goes out
// under a ref the client has already torn down, the moment the writer frees a
// slot. closeAll has the same problem from the other side: its wait would be
// finite only because serve cancels the context first, which makes a
// correctness property out of the order of two lines in a defer.
func TestEndingAReadUnparksAPumpWaitingForRoom(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := newConn(ctx, cancel, newPipeConn(), nil, "test", "", nil)
	fillOutbox(t, c)
	r, f := heldRead(t, c, 1, "held")

	parked := make(chan bool, 1)
	go func() { parked <- c.sendChunk(r, []byte("a chunk")) }()

	// Waiting for room, not failing over it.
	select {
	case ok := <-parked:
		t.Fatalf("sendChunk returned %v on a full outbox; it has to wait", ok)
	case <-time.After(50 * time.Millisecond):
	}

	// A cancel, or a dropped connection: endRead is the one door into both.
	c.endRead(r.ref)

	select {
	case ok := <-parked:
		if ok {
			t.Fatal("sendChunk reported the chunk sent, but the read was ended before there was ever room for it")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("ending a read left its pump parked waiting for outbox room: a cancel cannot stop the stream and closeAll cannot finish")
	}

	// The chunk did not sneak in behind the release. The outbox is still
	// exactly full, so nothing was queued under a ref that is now gone.
	if n := len(c.out); n != outboxDepth {
		t.Fatalf("outbox holds %d frames, want the %d it was filled with", n, outboxDepth)
	}
	// The file went with the read, and the connection did not.
	if _, err := f.Read(make([]byte, 1)); !errors.Is(err, os.ErrClosed) {
		t.Fatalf("reading the read's file after endRead = %v, want it closed", err)
	}
	select {
	case <-ctx.Done():
		t.Fatal("a full outbox failed the connection")
	default:
	}
}

// TestAPumpWaitsForRoomToSayEof closes trap two's last frame.
//
// Every chunk waits politely for room, and then the one frame that ends the
// stream used to go out through sendControl, whose full-outbox arm drops the
// connection. A session redrawing at speed refills the slot the writer just
// freed, the eof lands on that arm, and opening a file during a burst of output
// is an intermittent disconnect again — after 256 frames of getting it right.
func TestAPumpWaitsForRoomToSayEof(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := newConn(ctx, cancel, newPipeConn(), nil, "test", "", nil)
	fillOutbox(t, c)
	// Empty, so the pump sends no chunks at all and the eof is the only frame
	// under test.
	r, _ := heldRead(t, c, 1, "")

	done := make(chan struct{})
	c.pumps.Add(1)
	go func() { c.pump(r, maxFileBytes); close(done) }()

	select {
	case <-done:
		t.Fatal("the pump finished with a full outbox; its eof did not wait for room")
	case <-ctx.Done():
		t.Fatal("a pump's eof failed the connection because the terminal was busy")
	case <-time.After(50 * time.Millisecond):
	}

	// The writer gets through one frame, and the eof follows it.
	<-c.out
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("the pump never sent its eof once there was room")
	}
	select {
	case <-ctx.Done():
		t.Fatal("a full outbox failed the connection")
	default:
	}

	// And what it queued is an eof for this ref, at the back of the queue
	// rather than in place of anything the terminal had already said.
	var last frame
	for len(c.out) > 0 {
		last = <-c.out
	}
	msg, err := wire.DecodeControl(last.b)
	if err != nil {
		t.Fatalf("DecodeControl on the pump's last frame: %v", err)
	}
	e, ok := msg.(wire.Eof)
	if !ok {
		t.Fatalf("the pump's last frame was %#v, want an eof", msg)
	}
	if e.Ref != r.ref {
		t.Fatalf("Eof.Ref = %d, want %d", e.Ref, r.ref)
	}
}

// TestCancelStopsAReadAndReleasesItsRef pins the half of a cancel that is
// observable from outside: the slot the read held is free again. maxReads is 2,
// so a connection that cancels one read and starts two more only succeeds if
// the cancel actually released the first — otherwise the third is refused with
// busy.
//
// What it deliberately does not assert is that no eof, and no further chunk,
// arrives under the cancelled ref. Both are legal: the pump can take the
// writer's arm of a select whose other arm is the cancelled read, and eof's
// "was this cancelled" check is check-then-act ahead of the same kind of
// select. A client discards them by ref (spec/protocol.md, "Reading files"), so
// asserting their absence here would pin a race rather than a rule.
func TestCancelStopsAReadAndReleasesItsRef(t *testing.T) {
	ts, reg := newTestServer(t)
	dir := t.TempDir()
	body := bytes.Repeat([]byte("y"), 4<<20)
	for _, name := range []string{"one.log", "two.log", "three.log"} {
		if err := os.WriteFile(filepath.Join(dir, name), body, 0o644); err != nil {
			t.Fatalf("WriteFile: %v", err)
		}
	}
	s := readTarget(t, reg, dir)

	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.Read{ID: s.ID(), Path: "one.log", ReqID: 51})

	var ref uint32
	readUntil(t, c, func(msg any, _ []byte) bool {
		f, ok := msg.(wire.File)
		if !ok {
			return false
		}
		ref = f.Ref
		return true
	})
	writeControl(t, c, wire.Cancel{Ref: ref})

	// Two more reads have to fit. They only do if the cancel gave the slot
	// back, since maxReads is 2 and the cancelled read would otherwise still
	// hold one. Deterministic rather than racy: one connection has one read
	// loop, so the cancel is handled before either read behind it.
	writeControl(t, c, wire.Read{ID: s.ID(), Path: "two.log", ReqID: 52})
	writeControl(t, c, wire.Read{ID: s.ID(), Path: "three.log", ReqID: 53})

	seen := map[uint64]bool{}
	readUntil(t, c, func(msg any, _ []byte) bool {
		switch v := msg.(type) {
		case wire.File:
			seen[v.ReqID] = true
		case wire.Error:
			if v.ReqID == 52 || v.ReqID == 53 {
				t.Fatalf("read %d refused with %q; the cancelled read did not release its slot", v.ReqID, v.Code)
			}
		}
		return seen[52] && seen[53]
	})
}

// TestReadsAreCappedPerConnection pins the refusal itself, which the test
// above only proves the absence of.
func TestReadsAreCappedPerConnection(t *testing.T) {
	ts, reg := newTestServer(t)
	dir := t.TempDir()
	body := bytes.Repeat([]byte("z"), 6<<20)
	for _, name := range []string{"a.log", "b.log", "c.log"} {
		if err := os.WriteFile(filepath.Join(dir, name), body, 0o644); err != nil {
			t.Fatalf("WriteFile: %v", err)
		}
	}
	s := readTarget(t, reg, dir)

	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	// Three at once against a cap of two. The files are large enough that the
	// first two are still streaming when the third arrives.
	writeControl(t, c, wire.Read{ID: s.ID(), Path: "a.log", ReqID: 61})
	writeControl(t, c, wire.Read{ID: s.ID(), Path: "b.log", ReqID: 62})
	writeControl(t, c, wire.Read{ID: s.ID(), Path: "c.log", ReqID: 63})

	readUntil(t, c, func(msg any, _ []byte) bool {
		e, ok := msg.(wire.Error)
		if !ok {
			return false
		}
		if e.ReqID != 63 {
			t.Fatalf("error = %+v, want it to answer the third read", e)
		}
		if e.Code != "busy" {
			t.Fatalf("error code = %q, want busy", e.Code)
		}
		return true
	})
}

// TestAThirdReadIsRefusedWhileTwoAreHeld is the test above without the race.
//
// The one above drives three reads down a socket and trusts that the first two
// are still streaming when the third lands. They are, by a wide margin — the
// read loop handles the three back to back while a pump has megabytes left to
// push through a client that is not draining yet — but "by a wide margin" is
// not the same as "always", and the failure it would produce on a loaded
// machine is a five second deadline with nothing in it to say why.
//
// So the refusal is also pinned where no timing enters: two reads held, exactly
// the state startRead leaves behind, and a third asked for directly. The cap
// counts entries in c.reads and nothing else, so a stand-in read is the honest
// stand-in here.
func TestAThirdReadIsRefusedWhileTwoAreHeld(t *testing.T) {
	_, reg, srv := newTestServerUI(t, http.NotFoundHandler())
	dir := t.TempDir()
	third := filepath.Join(dir, "third.log")
	if err := os.WriteFile(third, []byte("hello\n"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	s := readTarget(t, reg, dir)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := newConn(ctx, cancel, newPipeConn(), srv, "test", "", nil)
	for ref := uint32(1); ref <= maxReads; ref++ {
		heldRead(t, c, ref, "held")
	}

	// The descriptor check is proved on a descriptor this test holds itself,
	// before it is trusted to report the absence of one below. A fileIsOpen
	// that could only ever answer no would pass that assertion while observing
	// nothing at all.
	probe, err := os.Open(third)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if !fileIsOpen(t, third) {
		t.Fatal("fileIsOpen cannot see a descriptor this test is holding open")
	}
	if err := probe.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if fileIsOpen(t, third) {
		t.Fatal("fileIsOpen still sees a descriptor this test has closed")
	}

	c.startRead(wire.Read{ID: s.ID(), Path: "third.log", ReqID: 63})

	select {
	case f := <-c.out:
		msg, err := wire.DecodeControl(f.b)
		if err != nil {
			t.Fatalf("DecodeControl on the answer to the third read: %v", err)
		}
		e, ok := msg.(wire.Error)
		if !ok {
			t.Fatalf("a read over the cap was answered with %#v, want an error", msg)
		}
		if e.ReqID != 63 {
			t.Fatalf("Error.ReqID = %d, want 63: a refusal a client cannot correlate is a refusal it cannot show", e.ReqID)
		}
		if e.Code != "busy" {
			t.Fatalf("Error.Code = %q, want busy", e.Code)
		}
	default:
		t.Fatal("a read over the cap was not answered at all")
	}

	// And it took no slot on its way out. A refusal that counted would let two
	// rejected reads lock a connection out of reading anything ever again.
	c.mu.Lock()
	held := len(c.reads)
	c.mu.Unlock()
	if held != maxReads {
		t.Fatalf("c.reads holds %d reads after a refusal, want the %d that were already there", held, maxReads)
	}

	// Nor did it keep the file. The cap is checked after the open, because the
	// sniff that decides whether a file may be shown at all needs its first
	// bytes, so this branch is holding a descriptor at the moment it decides to
	// say no. Every other refusal in startRead is in the same position and
	// closes for the same reason; this is the one a client can reach over and
	// over on a connection that is simply busy, so a leak here is the one that
	// would run a daemon out of descriptors.
	if fileIsOpen(t, third) {
		t.Fatal("a read refused with busy left its file open")
	}
}

// TestCancelOfAnUnknownRefIsIgnored: a client may cancel a read the daemon has
// already finished, and a race the client cannot avoid must not be an error it
// has to handle.
func TestCancelOfAnUnknownRefIsIgnored(t *testing.T) {
	ts, reg := newTestServer(t)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "small.txt"), []byte("hi\n"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	s := readTarget(t, reg, dir)

	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.Cancel{Ref: 999})
	// The connection is still usable, and says so by answering the next thing
	// asked of it.
	writeControl(t, c, wire.Read{ID: s.ID(), Path: "small.txt", ReqID: 71})
	readUntil(t, c, func(msg any, _ []byte) bool {
		switch v := msg.(type) {
		case wire.Error:
			// Nothing at all, not even an error the client is expected to
			// swallow. Without a dispatch arm the switch's default answers a
			// cancel with bad_message, and this is the assertion that catches
			// that: reading only for the file below would pass either way, since
			// an ignored frame and an unread one look the same from here.
			t.Fatalf("cancelling a ref the daemon does not hold was answered with %+v", v)
		case wire.File:
			if v.ReqID != 71 {
				t.Fatalf("File.ReqID = %d, want 71", v.ReqID)
			}
			return true
		}
		return false
	})
}

// TestClosingAConnectionEndsItsReads. A phone that goes into a pocket
// mid-read must not leave a file open on the machine. The pump is a goroutine
// holding a descriptor; nothing else would ever end it.
func TestClosingAConnectionEndsItsReads(t *testing.T) {
	ts, reg := newTestServer(t)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "big.log"), bytes.Repeat([]byte("q"), 6<<20), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	s := readTarget(t, reg, dir)

	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.Read{ID: s.ID(), Path: "big.log", ReqID: 81})
	readUntil(t, c, func(msg any, _ []byte) bool {
		_, ok := msg.(wire.File)
		return ok
	})

	// Drop it mid-stream. Under -race, a pump that kept running against a
	// closed connection or a closed file is what this catches.
	_ = c.CloseNow()

	// A fresh connection can still read. That assertion is liveness and nothing
	// more — the cap is per connection, so it would hold even if the dropped
	// connection had leaked both its slot and its pump. The property this test
	// is named for is carried by the race build walking the CloseNow teardown
	// above, where a pump still running against a closed connection or a closed
	// file is reported; TestCloseAllWaitsForEveryPump asserts the descriptor
	// itself, on the path this one drives from outside.
	c2 := dial(t, ts)
	writeControl(t, c2, wire.Hello{Ver: "test"})
	writeControl(t, c2, wire.Read{ID: s.ID(), Path: "big.log", ReqID: 82})
	readUntil(t, c2, func(msg any, _ []byte) bool {
		f, ok := msg.(wire.File)
		return ok && f.ReqID == 82
	})
}

// TestStatAndReadAreNotActivityInTheSession. The sessions list orders by
// LastActive, so either verb touching it would reorder the list under the
// pointer that is resting on it. peek has the same rule and the same test.
func TestStatAndReadAreNotActivityInTheSession(t *testing.T) {
	ts, reg := newTestServer(t)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "notes.md"), []byte("# notes\n"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	s := readTarget(t, reg, dir)

	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})

	before := quiet(t, s)

	writeControl(t, c, wire.Stat{ID: s.ID(), Paths: []string{"notes.md"}, ReqID: 91})
	readUntil(t, c, func(msg any, _ []byte) bool {
		_, ok := msg.(wire.Stats)
		return ok
	})
	if got := s.Info().LastActive; !got.Equal(before) {
		t.Fatalf("stat moved LastActive from %v to %v", before, got)
	}

	writeControl(t, c, wire.Read{ID: s.ID(), Path: "notes.md", ReqID: 92})
	readUntil(t, c, func(msg any, _ []byte) bool {
		_, ok := msg.(wire.Eof)
		return ok
	})
	if got := s.Info().LastActive; !got.Equal(before) {
		t.Fatalf("read moved LastActive from %v to %v", before, got)
	}
}
