package session

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestClaudeSlugMatchesTheDirectoryLayoutOnDisk(t *testing.T) {
	// The two forms that actually occur, taken from a real ~/.claude/projects:
	// an ordinary path, and one with a dot directory in it, where the slash and
	// the dot each contribute a hyphen and the pair reads as a double.
	cases := []struct{ cwd, want string }{
		{"/Users/karn/code/karnstack/flue", "-Users-karn-code-karnstack-flue"},
		{
			"/Users/karn/code/karnstack/flue/.claude/worktrees/ship",
			"-Users-karn-code-karnstack-flue--claude-worktrees-ship",
		},
		{"/tmp/a_b", "-tmp-a-b"},
		{"", ""},
	}
	for _, c := range cases {
		if got := claudeSlug(c.cwd); got != c.want {
			t.Errorf("claudeSlug(%q) = %q, want %q", c.cwd, got, c.want)
		}
	}
}

func TestClaudeProjectDirNamesNothingWithoutBothHalves(t *testing.T) {
	if got := claudeProjectDir("", "/code/flue"); got != "" {
		t.Errorf("with no home: %q, want empty", got)
	}
	if got := claudeProjectDir("/home/k", ""); got != "" {
		t.Errorf("with no cwd: %q, want empty", got)
	}
	want := filepath.Join("/home/k", ".claude", "projects", "-code-flue")
	if got := claudeProjectDir("/home/k", "/code/flue"); got != want {
		t.Errorf("claudeProjectDir = %q, want %q", got, want)
	}
}

// transcript writes one conversation file with a chosen modification time.
func transcript(t *testing.T, dir, id string, at time.Time) {
	t.Helper()
	path := filepath.Join(dir, id+transcriptSuffix)
	if err := os.WriteFile(path, []byte("{}\n"), 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
	if err := os.Chtimes(path, at, at); err != nil {
		t.Fatalf("chtimes %s: %v", path, err)
	}
}

func TestLatestClaudeSessionPicksTheNewestTranscript(t *testing.T) {
	dir := t.TempDir()
	base := time.Now().Add(-time.Hour)
	transcript(t, dir, "older", base)
	transcript(t, dir, "newest", base.Add(30*time.Minute))
	transcript(t, dir, "middle", base.Add(10*time.Minute))

	id, ok := latestClaudeSession(dir, base.Add(-time.Minute))
	if !ok || id != "newest" {
		t.Fatalf("latestClaudeSession = (%q, %v), want (newest, true)", id, ok)
	}
}

func TestLatestClaudeSessionIgnoresWorkFromBeforeTheSessionExisted(t *testing.T) {
	// The whole of the filter, and the reason this is safe to print: a
	// transcript last written before the shell was started cannot be that
	// shell's work, so an old conversation in a directory somebody once used
	// Claude Code in is never attached to a shell that merely opened there.
	dir := t.TempDir()
	transcript(t, dir, "ancient", time.Now().Add(-48*time.Hour))

	if id, ok := latestClaudeSession(dir, time.Now().Add(-time.Hour)); ok {
		t.Fatalf("latestClaudeSession = %q, want no answer", id)
	}
}

func TestLatestClaudeSessionAnswersNothingForAnythingItCannotRead(t *testing.T) {
	long := time.Now().Add(-time.Hour)
	if id, ok := latestClaudeSession("", long); ok {
		t.Fatalf("with no directory: %q", id)
	}
	if id, ok := latestClaudeSession(filepath.Join(t.TempDir(), "never-created"), long); ok {
		t.Fatalf("with a missing directory: %q", id)
	}
	// A project directory that exists and holds only things that are not
	// transcripts — Claude Code keeps other state in there too.
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "memory"), 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "notes.md"), []byte("x"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if id, ok := latestClaudeSession(dir, long); ok {
		t.Fatalf("with no transcripts: %q", id)
	}
}

func TestReviveNoteIsTheBareMarkerWithoutAConversation(t *testing.T) {
	// Most sessions are not running Claude Code, and the seam they get must be
	// exactly the one they have always got.
	if got := reviveNote(""); string(got) != string(reviveMarker) {
		t.Fatalf("reviveNote(\"\") = %q, want the bare marker", got)
	}
}

func TestReviveNoteNamesTheCommandThatResumes(t *testing.T) {
	got := string(reviveNote("6f1c2b90-dead-beef-0000-000000000001"))
	if !strings.HasPrefix(got, string(reviveMarker)) {
		t.Fatalf("the note dropped the seam it is written under: %q", got)
	}
	if !strings.Contains(got, "claude --resume 6f1c2b90-dead-beef-0000-000000000001") {
		t.Fatalf("the note does not carry a runnable command: %q", got)
	}
	// Printed, never run: the revived shell is a login shell and the note is
	// output, so it must end the line rather than leave one hanging that the
	// user's next keystroke would append to.
	if !strings.HasSuffix(got, "\r\n\r\n") {
		t.Fatalf("the note does not end its own line: %q", got)
	}
}

func TestReviveCarriesTheResumeNoteIntoTheScrollback(t *testing.T) {
	r := NewRegistry(nil)
	s, err := r.Revive(Snapshot{
		V:             1,
		ID:            "abc123",
		Cwd:           t.TempDir(),
		Cols:          80,
		Rows:          24,
		Ring:          []byte("earlier output"),
		ClaudeSession: "0000-1111",
	})
	if err != nil {
		t.Fatalf("Revive: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })

	sub := s.Subscribe(0)
	defer s.Unsubscribe(sub)
	if !strings.Contains(string(sub.Backlog), "claude --resume 0000-1111") {
		t.Fatalf("the revived scrollback does not name the resume: %q", sub.Backlog)
	}
	if !strings.Contains(string(sub.Backlog), "earlier output") {
		t.Fatalf("the revived scrollback lost the history it exists to carry")
	}
}
