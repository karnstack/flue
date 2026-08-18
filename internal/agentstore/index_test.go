package agentstore

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const (
	claudeFixtureID = "11111111-1111-4111-8111-111111111111"
	codexFixtureID  = "22222222-2222-4222-8222-222222222222"
	piFixtureID     = "33333333-3333-4333-8333-333333333333"
)

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	return b
}

func write(t *testing.T, path string, b []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(path, b, 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
}

// fakeHome lays the three stores out the way the real tools do, under a
// throwaway home, and hands back the transcript paths keyed by tool.
func fakeHome(t *testing.T) (home string, paths map[Tool]string) {
	t.Helper()
	home = t.TempDir()
	paths = map[Tool]string{
		ToolClaude: filepath.Join(home, ".claude", "projects", claudeSlug("/home/dev/proj"), claudeFixtureID+".jsonl"),
		ToolCodex: filepath.Join(home, ".codex", "sessions", "2026", "07", "01",
			"rollout-2026-07-01T10-00-00-"+codexFixtureID+".jsonl"),
		ToolPi: filepath.Join(home, ".pi", "agent", "sessions", "--home-dev-proj--",
			"2026-03-27T12-35-33_"+piFixtureID+".jsonl"),
	}
	write(t, paths[ToolClaude], fixture(t, "claude-session.jsonl"))
	write(t, paths[ToolCodex], fixture(t, "codex-rollout.jsonl"))
	write(t, paths[ToolPi], fixture(t, "pi-session.jsonl"))
	return home, paths
}

// newSweptIndex is an index over a fake home, swept once, synchronously.
func newSweptIndex(t *testing.T) (*Index, string, map[Tool]string) {
	t.Helper()
	home, paths := fakeHome(t)
	x := New(t.TempDir(), home)
	x.sweep()
	return x, home, paths
}

func TestSweepDiscoversEveryStoreLayout(t *testing.T) {
	x, _, _ := newSweptIndex(t)
	sums, building := x.Snapshot(nil, "")
	if building {
		t.Error("building = true after a completed sweep")
	}
	if len(sums) != 3 {
		t.Fatalf("Snapshot found %d sessions, want 3: %+v", len(sums), sums)
	}
	// Newest first: the Claude fixture spoke in August, Codex in July, Pi in
	// March.
	want := []Tool{ToolClaude, ToolCodex, ToolPi}
	for i, w := range want {
		if sums[i].Tool != w {
			t.Errorf("Snapshot[%d].Tool = %s, want %s", i, sums[i].Tool, w)
		}
	}
	// The ids the wire will address pages by: filename for Claude, the
	// content's own id for the other two.
	for _, id := range []struct {
		tool Tool
		id   string
	}{{ToolClaude, claudeFixtureID}, {ToolCodex, codexFixtureID}, {ToolPi, piFixtureID}} {
		if _, _, ok := x.Resolve(id.tool, id.id); !ok {
			t.Errorf("Resolve(%s, %s) missed", id.tool, id.id)
		}
	}
}

func TestSnapshotFilters(t *testing.T) {
	x, _, _ := newSweptIndex(t)
	sums, _ := x.Snapshot([]string{"pi", "codex"}, "")
	if len(sums) != 2 {
		t.Fatalf("tool filter kept %d, want 2", len(sums))
	}
	sums, _ = x.Snapshot(nil, "/home/dev/proj")
	if len(sums) != 3 {
		t.Fatalf("cwd filter kept %d, want 3 (all fixtures ran there)", len(sums))
	}
	sums, _ = x.Snapshot(nil, "/somewhere/else")
	if len(sums) != 0 {
		t.Fatalf("mismatched cwd kept %d, want 0", len(sums))
	}
	// An unrecognised tool in the filter matches nothing rather than failing:
	// a filter is a preference, not a request the daemon must vet.
	sums, _ = x.Snapshot([]string{"cursor"}, "")
	if len(sums) != 0 {
		t.Fatalf("unknown tool filter kept %d, want 0", len(sums))
	}
}

// TestSnapshotHidesEmptySessions pins the stub filter: a transcript whose
// lines are all bookkeeping (a real store is full of them — hook-only
// sessions, bare last-prompt stubs) is indexed but never listed. Its zero
// StartedAt would otherwise reach clients and poison their date arithmetic.
func TestSnapshotHidesEmptySessions(t *testing.T) {
	home, _ := fakeHome(t)
	stub := filepath.Join(home, ".claude", "projects", claudeSlug("/home/dev/proj"),
		"99999999-9999-4999-8999-999999999999.jsonl")
	write(t, stub, []byte(`{"type":"last-prompt","leafUuid":"x","sessionId":"99999999-9999-4999-8999-999999999999"}`+"\n"))
	x := New(t.TempDir(), home)
	x.sweep()
	sums, _ := x.Snapshot(nil, "")
	if len(sums) != 3 {
		t.Fatalf("Snapshot kept %d sessions, want 3 (the stub hidden)", len(sums))
	}
	for _, s := range sums {
		if s.MessageCount == 0 {
			t.Fatalf("an empty session reached the snapshot: %+v", s)
		}
	}
}

// TestIncrementalParseResumesFromTheStoredOffset proves the resume is real:
// after the first sweep the already-parsed prefix is overwritten in place
// with same-length garbage, so only a parser that never re-reads it can get
// the totals right.
func TestIncrementalParseResumesFromTheStoredOffset(t *testing.T) {
	full := fixture(t, "claude-session.jsonl")
	lines := bytes.SplitAfter(full, []byte("\n"))
	// Lines 1..10 of the fixture end just after the tool_result: everything
	// req_A1 contributed is in, req_A2 and the ai-title are not.
	prefix := bytes.Join(lines[:10], nil)

	home := t.TempDir()
	path := filepath.Join(home, ".claude", "projects", claudeSlug("/home/dev/proj"), claudeFixtureID+".jsonl")
	write(t, path, prefix)
	x := New(t.TempDir(), home)
	x.sweep()

	_, sum, ok := x.Resolve(ToolClaude, claudeFixtureID)
	if !ok {
		t.Fatal("Resolve missed after the first sweep")
	}
	if want := (TokenUsage{Input: 12, Output: 40, CacheRead: 1500, CacheWrite: 600}); sum.Tokens != want {
		t.Fatalf("prefix Tokens = %+v, want %+v", sum.Tokens, want)
	}
	if sum.MessageCount != 5 {
		t.Fatalf("prefix MessageCount = %d, want 5", sum.MessageCount)
	}

	// Poison the parsed prefix — same length, so the file only ever grows —
	// then append the rest.
	poison := bytes.Repeat([]byte("x"), len(prefix)-1)
	rest := bytes.Join(lines[10:], nil)
	write(t, path, append(append(poison, '\n'), rest...))
	x.sweep()

	_, sum, _ = x.Resolve(ToolClaude, claudeFixtureID)
	if want := (TokenUsage{Input: 42, Output: 65, CacheRead: 3600, CacheWrite: 600}); sum.Tokens != want {
		t.Fatalf("after append Tokens = %+v, want %+v (a full reparse would have read the poison)", sum.Tokens, want)
	}
	if sum.MessageCount != 6 {
		t.Fatalf("after append MessageCount = %d, want 6", sum.MessageCount)
	}
	if sum.Title != "Fix flaky nginx test" {
		t.Fatalf("after append Title = %q, want the appended ai-title", sum.Title)
	}
}

// TestShrunkFileIsReparsedWhole is truncation detection: a file smaller than
// the index remembers is a replaced file, and everything the old parse knew
// describes bytes that are gone.
func TestShrunkFileIsReparsedWhole(t *testing.T) {
	full := fixture(t, "claude-session.jsonl")
	home := t.TempDir()
	path := filepath.Join(home, ".claude", "projects", claudeSlug("/home/dev/proj"), claudeFixtureID+".jsonl")
	write(t, path, full)
	x := New(t.TempDir(), home)
	x.sweep()

	// Replace with only the first six lines: one countable message, no
	// assistant lines at all.
	lines := bytes.SplitAfter(full, []byte("\n"))
	write(t, path, bytes.Join(lines[:6], nil))
	x.sweep()

	_, sum, ok := x.Resolve(ToolClaude, claudeFixtureID)
	if !ok {
		t.Fatal("Resolve missed after the truncating rewrite")
	}
	if sum.Tokens != (TokenUsage{}) {
		t.Fatalf("Tokens = %+v, want zero (the assistant lines are gone)", sum.Tokens)
	}
	if sum.MessageCount != 1 {
		t.Fatalf("MessageCount = %d, want 1", sum.MessageCount)
	}
}

// TestPartialTrailingLineIsNotConsumed pins the mid-append case: a transcript
// caught between the write of a line and its newline parses up to the seam,
// and the completed line is picked up whole by the next sweep.
func TestPartialTrailingLineIsNotConsumed(t *testing.T) {
	full := fixture(t, "claude-session.jsonl")
	lines := bytes.SplitAfter(full, []byte("\n"))
	prefix := bytes.Join(lines[:6], nil)
	// Half of line 7, no newline: an append in flight.
	half := lines[6][:20]

	home := t.TempDir()
	path := filepath.Join(home, ".claude", "projects", claudeSlug("/home/dev/proj"), claudeFixtureID+".jsonl")
	write(t, path, append(append([]byte{}, prefix...), half...))
	x := New(t.TempDir(), home)
	x.sweep()

	_, sum, _ := x.Resolve(ToolClaude, claudeFixtureID)
	if sum.MessageCount != 1 {
		t.Fatalf("MessageCount = %d, want 1 (the fragment is not a line)", sum.MessageCount)
	}

	// The writer finishes: the file grows, and the resumed parse must re-read
	// the fragment as part of its completed line, not from after it.
	write(t, path, full)
	x.sweep()
	_, sum, _ = x.Resolve(ToolClaude, claudeFixtureID)
	if want := (TokenUsage{Input: 42, Output: 65, CacheRead: 3600, CacheWrite: 600}); sum.Tokens != want {
		t.Fatalf("Tokens = %+v, want %+v", sum.Tokens, want)
	}
	if sum.MessageCount != 6 {
		t.Fatalf("MessageCount = %d, want 6", sum.MessageCount)
	}
}

func TestVanishedFilesBecomeTombstones(t *testing.T) {
	x, _, paths := newSweptIndex(t)
	if err := os.Remove(paths[ToolCodex]); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	x.sweep()
	// The session still counts — the stores prune themselves, and history
	// must not vanish with the file — but it is flagged, so a client can
	// keep it out of the openable list. The full contract is pinned in
	// TestSweepTombstonesVanishedTranscripts.
	sums, _ := x.Snapshot(nil, "")
	if len(sums) != 3 {
		t.Fatalf("Snapshot = %d sessions, want 3 (a prune tombstones, never drops)", len(sums))
	}
	for _, s := range sums {
		if s.Tool == ToolCodex && !s.Missing {
			t.Error("pruned session served without its missing flag")
		}
	}
}

// TestIndexPersistsAndReloads is the round trip: a second index over the same
// persist directory knows every session before it has swept anything, and the
// file on disk keeps the config directory's discipline.
func TestIndexPersistsAndReloads(t *testing.T) {
	home, _ := fakeHome(t)
	persist := t.TempDir()
	x := New(persist, home)
	x.sweep()

	file := filepath.Join(persist, indexFileName)
	fi, err := os.Stat(file)
	if err != nil {
		t.Fatalf("the sweep persisted nothing: %v", err)
	}
	if perm := fi.Mode().Perm(); perm != 0o600 {
		t.Errorf("index file mode = %o, want 600", perm)
	}
	if di, err := os.Stat(persist); err != nil || di.Mode().Perm() != 0o700 {
		t.Errorf("persist dir mode = %o (err %v), want 700", di.Mode().Perm(), err)
	}

	y := New(persist, home)
	// Deliberately no sweep: the loaded file is the whole of what it knows.
	y.mu.Lock()
	n := len(y.entries)
	y.mu.Unlock()
	if n != 3 {
		t.Fatalf("reloaded index holds %d entries, want 3", n)
	}
	if _, sum, ok := y.Resolve(ToolClaude, claudeFixtureID); !ok || sum.Title != "Fix flaky nginx test" {
		t.Fatalf("reloaded Resolve = (%+v, %v), want the persisted summary", sum, ok)
	}
}

func TestCorruptIndexFileIsRebuiltNotFatal(t *testing.T) {
	home, _ := fakeHome(t)
	persist := t.TempDir()
	write(t, filepath.Join(persist, indexFileName), []byte("{not json"))

	x := New(persist, home) // must not panic, must not fail
	x.mu.Lock()
	n := len(x.entries)
	x.mu.Unlock()
	if n != 0 {
		t.Fatalf("a corrupt index loaded %d entries, want 0", n)
	}
	x.sweep()
	if sums, _ := x.Snapshot(nil, ""); len(sums) != 3 {
		t.Fatalf("rebuild found %d sessions, want 3", len(sums))
	}
}

// TestLineReaderLeavesAFragmentUnconsumed pins the reader every parse sits
// on: a trailing line with no newline is reported as no line at all, and the
// offset stays at its start so a later parse reads it whole.
func TestLineReaderLeavesAFragmentUnconsumed(t *testing.T) {
	lr := newLineReader(strings.NewReader("alpha\nbeta"), 0)
	line, off, ok := lr.next()
	if !ok || string(line) != "alpha" || off != 0 {
		t.Fatalf("first next = (%q, %d, %v), want (alpha, 0, true)", line, off, ok)
	}
	if _, _, ok := lr.next(); ok {
		t.Fatal("the fragment was handed out as a line")
	}
	if lr.off != 6 {
		t.Fatalf("offset = %d after the fragment, want 6 (the fragment's start)", lr.off)
	}
}
