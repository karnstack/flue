package daemon

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
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

	many := make([]string, maxStatPaths+1)
	for i := range many {
		many[i] = "real.txt"
	}
	writeControl(t, c, wire.Stat{ID: s.ID(), Paths: many, ReqID: 23})
	readUntil(t, c, func(msg any, _ []byte) bool {
		e, ok := msg.(wire.Error)
		if !ok {
			return false
		}
		if e.ReqID != 23 || e.Code != "bad_path" {
			t.Fatalf("error = %+v, want bad_path for reqId 23", e)
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

func TestEnqueueWaitWaitsForRoom(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// No server and no writer: enqueueWait touches neither, and a conn with
	// nothing draining it is exactly the condition under test.
	c := newConn(ctx, cancel, newPipeConn(), nil, "test", "", nil)
	for i := 0; i < outboxDepth; i++ {
		if err := c.enqueue(frame{text: true, b: []byte("{}")}); err != nil {
			t.Fatalf("filling the outbox at %d: %v", i, err)
		}
	}

	done := make(chan error, 1)
	go func() { done <- c.enqueueWait(frame{text: true, b: []byte("{}")}) }()

	select {
	case err := <-done:
		t.Fatalf("enqueueWait returned %v on a full outbox; it has to wait", err)
	case <-time.After(50 * time.Millisecond):
	}

	// The writer drains one frame, and the wait ends.
	<-c.out

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("enqueueWait once there was room = %v, want nil", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("enqueueWait did not proceed once there was room")
	}

	// And the connection is still alive. Waiting is not a fault, which is the
	// whole difference between this and enqueue.
	select {
	case <-ctx.Done():
		t.Fatal("a full outbox failed the connection")
	default:
	}
}

func TestEnqueueWaitGivesUpWhenTheConnectionEnds(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	c := newConn(ctx, cancel, newPipeConn(), nil, "test", "", nil)
	for i := 0; i < outboxDepth; i++ {
		if err := c.enqueue(frame{text: true, b: []byte("{}")}); err != nil {
			t.Fatalf("filling the outbox at %d: %v", i, err)
		}
	}

	done := make(chan error, 1)
	go func() { done <- c.enqueueWait(frame{text: true, b: []byte("{}")}) }()

	// A peer that has stopped reading is what ends this wait in production:
	// the writer's own timeout fails the connection, which cancels this
	// context. Cancelling directly is that outcome without the ten seconds.
	cancel()

	select {
	case err := <-done:
		if !errors.Is(err, errConnClosed) {
			t.Fatalf("enqueueWait after the connection ended = %v, want errConnClosed", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("enqueueWait did not give up when the connection ended")
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

	readUntil(t, c, func(msg any, out []byte) bool {
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
	r := &fileRead{ref: ref, f: f, done: make(chan struct{})}
	c.mu.Lock()
	c.reads[ref] = r
	c.mu.Unlock()
	return r, f
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

// TestCancelStopsAReadAndReleasesItsRef proves the two halves that matter: no
// eof arrives for a cancelled read, and the slot it held is free again.
//
// The second half is the observable one. maxReads is 2, so a connection that
// cancels one read and starts two more only succeeds if the cancel actually
// released the first — otherwise the third is refused with busy.
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
	if err := os.WriteFile(filepath.Join(dir, "third.log"), []byte("hello\n"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	s := readTarget(t, reg, dir)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := newConn(ctx, cancel, newPipeConn(), srv, "test", "", nil)
	for ref := uint32(1); ref <= maxReads; ref++ {
		heldRead(t, c, ref, "held")
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

	// A fresh connection can still read, which it could not if the dropped
	// one's pump had taken the daemon down with it. The cap is per connection,
	// so this asserts the pump ended rather than the slot: the stronger claim is
	// the -race run below.
	c2 := dial(t, ts)
	writeControl(t, c2, wire.Hello{Ver: "test"})
	writeControl(t, c2, wire.Read{ID: s.ID(), Path: "big.log", ReqID: 82})
	readUntil(t, c2, func(msg any, _ []byte) bool {
		f, ok := msg.(wire.File)
		return ok && f.ReqID == 82
	})
}
