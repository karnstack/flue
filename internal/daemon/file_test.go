package daemon

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

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
