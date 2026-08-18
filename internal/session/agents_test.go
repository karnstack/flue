package session

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// codexRollout writes one Codex rollout whose first line is a session_meta
// naming id and cwd, filed under root's YYYY/MM/DD directory for at's local
// day — the store's own layout — with at as its mtime.
func codexRollout(t *testing.T, root, id, cwd string, at time.Time) string {
	t.Helper()
	day := at.Local()
	dir := filepath.Join(root,
		fmt.Sprintf("%04d", day.Year()),
		fmt.Sprintf("%02d", int(day.Month())),
		fmt.Sprintf("%02d", day.Day()))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("mkdir %s: %v", dir, err)
	}
	path := filepath.Join(dir, "rollout-2026-08-11T17-28-26-"+id+".jsonl")
	line := fmt.Sprintf(
		"{\"timestamp\":%q,\"type\":\"session_meta\",\"payload\":{\"id\":%q,\"cwd\":%q}}\n"+
			"{\"timestamp\":%q,\"type\":\"response_item\",\"payload\":{}}\n",
		at.Format(time.RFC3339), id, cwd, at.Format(time.RFC3339))
	if err := os.WriteFile(path, []byte(line), 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
	if err := os.Chtimes(path, at, at); err != nil {
		t.Fatalf("chtimes %s: %v", path, err)
	}
	return path
}

// piTranscript writes one Pi session file whose first line names id and cwd,
// under a slug directory whose spelling is deliberately NOT derivable from
// cwd — the scan must trust the file's own word, not the directory name.
func piTranscript(t *testing.T, root, slug, id, cwd string, at time.Time) string {
	t.Helper()
	dir := filepath.Join(root, slug)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("mkdir %s: %v", dir, err)
	}
	path := filepath.Join(dir, "2026-03-27T15-33-51-377Z_"+id+".jsonl")
	line := fmt.Sprintf("{\"type\":\"session\",\"version\":3,\"id\":%q,\"cwd\":%q}\n", id, cwd)
	if err := os.WriteFile(path, []byte(line), 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
	if err := os.Chtimes(path, at, at); err != nil {
		t.Fatalf("chtimes %s: %v", path, err)
	}
	return path
}

const codexUUID = "019ff0b0-3160-7251-980f-2ed8c0b5b043"

func TestLatestCodexSessionMatchesTheCwdInsideTheFile(t *testing.T) {
	root := t.TempDir()
	base := time.Now().Add(-30 * time.Minute)
	codexRollout(t, root, "00000000-0000-0000-0000-0000000000aa", "/work/here", base)
	codexRollout(t, root, codexUUID, "/work/here", base.Add(10*time.Minute))
	// A stranger's conversation, newer than both: the cwd is the filter that
	// keeps it off this shell's seam.
	codexRollout(t, root, "00000000-0000-0000-0000-0000000000bb", "/work/elsewhere", base.Add(20*time.Minute))

	id, _, ok := latestCodexSession(root, "/work/here", base.Add(-time.Minute))
	if !ok || id != codexUUID {
		t.Fatalf("latestCodexSession = (%q, %v), want the newest /work/here rollout", id, ok)
	}
}

func TestLatestCodexSessionIgnoresWorkFromBeforeTheSessionExisted(t *testing.T) {
	root := t.TempDir()
	codexRollout(t, root, codexUUID, "/work/here", time.Now().Add(-48*time.Hour))

	if id, _, ok := latestCodexSession(root, "/work/here", time.Now().Add(-time.Hour)); ok {
		t.Fatalf("latestCodexSession = %q, want no answer for a rollout older than the shell", id)
	}
}

func TestLatestCodexSessionAnswersNothingForAnEmptyOrMissingStore(t *testing.T) {
	long := time.Now().Add(-time.Hour)
	if id, _, ok := latestCodexSession("", "/w", long); ok {
		t.Fatalf("with no root: %q", id)
	}
	if id, _, ok := latestCodexSession(filepath.Join(t.TempDir(), "nope"), "/w", long); ok {
		t.Fatalf("with a missing root: %q", id)
	}
	if id, _, ok := latestCodexSession(t.TempDir(), "", long); ok {
		t.Fatalf("with no cwd: %q", id)
	}
}

func TestLatestCodexSessionFallsBackToTheFilenameUuid(t *testing.T) {
	root := t.TempDir()
	at := time.Now().Add(-10 * time.Minute)
	path := codexRollout(t, root, codexUUID, "/work/here", at)
	// A meta line that names the cwd but not the id: the uuid tail of the
	// filename is the identity, exactly as agentstore reads it.
	line := "{\"type\":\"session_meta\",\"payload\":{\"cwd\":\"/work/here\"}}\n"
	if err := os.WriteFile(path, []byte(line), 0o600); err != nil {
		t.Fatalf("rewrite: %v", err)
	}
	if err := os.Chtimes(path, at, at); err != nil {
		t.Fatalf("chtimes: %v", err)
	}

	id, _, ok := latestCodexSession(root, "/work/here", at.Add(-time.Minute))
	if !ok || id != codexUUID {
		t.Fatalf("latestCodexSession = (%q, %v), want the filename uuid %q", id, ok, codexUUID)
	}
}

func TestLatestPiSessionAnswersWithThePathPiResumesFrom(t *testing.T) {
	root := t.TempDir()
	base := time.Now().Add(-30 * time.Minute)
	piTranscript(t, root, "--weird-slug--", "older-id", "/work/here", base)
	want := piTranscript(t, root, "--weird-slug--", "newer-id", "/work/here", base.Add(10*time.Minute))
	piTranscript(t, root, "--other-slug--", "stranger", "/work/elsewhere", base.Add(20*time.Minute))

	path, _, ok := latestPiSession(root, "/work/here", base.Add(-time.Minute))
	if !ok || path != want {
		t.Fatalf("latestPiSession = (%q, %v), want %q", path, ok, want)
	}
}

func TestLatestPiSessionIgnoresOldWorkAndMissingStores(t *testing.T) {
	root := t.TempDir()
	piTranscript(t, root, "-s-", "ancient", "/work/here", time.Now().Add(-48*time.Hour))
	if path, _, ok := latestPiSession(root, "/work/here", time.Now().Add(-time.Hour)); ok {
		t.Fatalf("latestPiSession = %q, want no answer for a transcript older than the shell", path)
	}
	long := time.Now().Add(-time.Hour)
	if path, _, ok := latestPiSession("", "/w", long); ok {
		t.Fatalf("with no root: %q", path)
	}
	if path, _, ok := latestPiSession(filepath.Join(t.TempDir(), "nope"), "/w", long); ok {
		t.Fatalf("with a missing root: %q", path)
	}
}

// TestAgentSessionForPicksTheNewestAcrossTools: one shell, three stores with
// evidence in it — the transcript written last is the work the shell was
// last doing, and the one hint line goes to it.
func TestAgentSessionForPicksTheNewestAcrossTools(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	cwd := "/work/here"
	base := time.Now().Add(-30 * time.Minute)

	claudeDir := claudeProjectDir(home, cwd)
	if err := os.MkdirAll(claudeDir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	transcript(t, claudeDir, "claude-conv", base)
	codexRollout(t, codexSessionsRoot(home), codexUUID, cwd, base.Add(10*time.Minute))
	piPath := piTranscript(t, piSessionsRoot(home), "-slug-", "pi-conv", cwd, base.Add(20*time.Minute))

	agent, ref := agentSessionFor(cwd, base.Add(-time.Minute))
	if agent != agentPi || ref != piPath {
		t.Fatalf("agentSessionFor = (%s, %q), want the newest store's (pi, %q)", agent, ref, piPath)
	}

	// Re-date Pi's evidence to before Codex's and the answer follows the
	// mtimes, not the tools.
	if err := os.Chtimes(piPath, base.Add(5*time.Minute), base.Add(5*time.Minute)); err != nil {
		t.Fatalf("chtimes: %v", err)
	}
	agent, ref = agentSessionFor(cwd, base.Add(-time.Minute))
	if agent != agentCodex || ref != codexUUID {
		t.Fatalf("agentSessionFor = (%s, %q), want (codex, %q)", agent, ref, codexUUID)
	}
}

func TestAgentSessionForAnswersNothingWithNoEvidence(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if agent, ref := agentSessionFor("/work/here", time.Now().Add(-time.Hour)); agent != "" || ref != "" {
		t.Fatalf("agentSessionFor = (%s, %q), want nothing", agent, ref)
	}
}

// TestReviveCarriesACodexResumeNote is TestReviveCarriesTheResumeNoteIntoThe
// Scrollback for the generalized fields: a snapshot that names another
// tool's conversation revives with that tool's resume spelling.
func TestReviveCarriesACodexResumeNote(t *testing.T) {
	r := NewRegistry(nil)
	s, err := r.Revive(Snapshot{
		V:            1,
		ID:           "def456",
		Cwd:          t.TempDir(),
		Cols:         80,
		Rows:         24,
		Agent:        agentCodex,
		AgentSession: codexUUID,
	})
	if err != nil {
		t.Fatalf("Revive: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })

	sub := s.Subscribe(0)
	defer s.Unsubscribe(sub)
	if !strings.Contains(string(sub.Backlog), "codex resume "+codexUUID) {
		t.Fatalf("the revived scrollback does not name the codex resume: %q", sub.Backlog)
	}
}
