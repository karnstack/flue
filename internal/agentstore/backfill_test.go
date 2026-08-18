package agentstore

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// subagentPath is where Claude's layout keeps a subagent file for the
// fixture session: <slug>/<session-uuid>/subagents/<name>.jsonl.
func subagentPath(home, name string) string {
	return filepath.Join(home, ".claude", "projects", claudeSlug("/home/dev/proj"),
		claudeFixtureID, "subagents", name)
}

// claudeSummary plucks the one Claude session out of a snapshot.
func claudeSummary(t *testing.T, x *Index) Summary {
	t.Helper()
	sums, _ := x.Snapshot([]string{"claude"}, "")
	if len(sums) != 1 {
		t.Fatalf("Snapshot(claude) found %d sessions, want 1: %+v", len(sums), sums)
	}
	return sums[0]
}

// TestSweepFoldsSubagentTokens pins the subagents/ accounting: the files are
// indexed, never listed as sessions, and their tokens land on the
// conversation that spawned them. The fixture carries two requestIds worth
// (11, 22, 103, 9); two copies fold twice.
func TestSweepFoldsSubagentTokens(t *testing.T) {
	home, _ := fakeHome(t)
	write(t, subagentPath(home, "agent-aaa111.jsonl"), fixture(t, "claude-subagent.jsonl"))
	write(t, subagentPath(home, "agent-bbb222.jsonl"), fixture(t, "claude-subagent.jsonl"))
	x := New(t.TempDir(), home)
	x.sweep()

	sums, _ := x.Snapshot(nil, "")
	if len(sums) != 3 {
		t.Fatalf("Snapshot listed %d sessions, want 3 (subagent files are not sessions): %+v", len(sums), sums)
	}
	sum := claudeSummary(t, x)
	want := TokenUsage{Input: 42 + 22, Output: 65 + 44, CacheRead: 3600 + 206, CacheWrite: 600 + 18}
	if sum.Tokens != want {
		t.Errorf("claude tokens = %+v, want %+v (base plus two folded subagents)", sum.Tokens, want)
	}
	// The fold does not bleed into anything else the summary claims.
	if sum.MessageCount != 6 {
		t.Errorf("claude messageCount = %d, want the conversation's own 6", sum.MessageCount)
	}
}

// TestTombstonedSubagentsKeepFolding pins the fold's other half: pruning a
// subagent file must not shrink the parent's totals — the tombstoned entry
// keeps folding, which is what lets a session's accounting survive the
// cleanup deleting its pieces one by one.
func TestTombstonedSubagentsKeepFolding(t *testing.T) {
	home, _ := fakeHome(t)
	write(t, subagentPath(home, "agent-aaa111.jsonl"), fixture(t, "claude-subagent.jsonl"))
	x := New(t.TempDir(), home)
	x.sweep()
	before := claudeSummary(t, x).Tokens

	if err := os.Remove(subagentPath(home, "agent-aaa111.jsonl")); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	x.sweep()
	if after := claudeSummary(t, x).Tokens; after != before {
		t.Errorf("parent tokens shrank when the subagent file was pruned: %+v, want %+v", after, before)
	}
}

// TestOrphanedSubagentsServeAsTombstone pins the orphan case seen on a real
// store: Claude Code's cleanup deletes the conversation .jsonl but leaves
// <uuid>/subagents/ behind, and if that happened before the index ever ran
// there is nothing to fold into. The remains are served as a synthesized
// tombstone — counted, never listed as openable, carrying the subagents' own
// working directory, span and tokens.
func TestOrphanedSubagentsServeAsTombstone(t *testing.T) {
	home, paths := fakeHome(t)
	write(t, subagentPath(home, "agent-aaa111.jsonl"), fixture(t, "claude-subagent.jsonl"))
	// The conversation file is gone before the first sweep.
	if err := os.Remove(paths[ToolClaude]); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	x := New(t.TempDir(), home)
	x.sweep()

	sum := claudeSummary(t, x)
	if !sum.Missing {
		t.Error("orphan tombstone not marked missing")
	}
	if sum.ID != claudeFixtureID {
		t.Errorf("orphan id = %q, want the session uuid %q", sum.ID, claudeFixtureID)
	}
	if sum.Cwd != "/home/dev/proj" {
		t.Errorf("orphan cwd = %q, want the subagents' own", sum.Cwd)
	}
	if want := (TokenUsage{Input: 11, Output: 22, CacheRead: 103, CacheWrite: 9}); sum.Tokens != want {
		t.Errorf("orphan tokens = %+v, want %+v", sum.Tokens, want)
	}
	if sum.StartedAt.IsZero() || sum.EndedAt.IsZero() {
		t.Error("orphan span is zero; clients drop rows with unreadable stamps")
	}
}

// TestSweepTombstonesVanishedTranscripts pins the retention story: a file the
// tool pruned keeps its summary — marked missing, unresumable, unsearchable,
// unreadable — and comes back whole if the file does.
func TestSweepTombstonesVanishedTranscripts(t *testing.T) {
	x, _, paths := newSweptIndex(t)
	if err := os.Remove(paths[ToolCodex]); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	x.sweep()

	sums, _ := x.Snapshot(nil, "")
	if len(sums) != 3 {
		t.Fatalf("Snapshot listed %d sessions after a prune, want 3 (tombstone counts)", len(sums))
	}
	var codex Summary
	for _, s := range sums {
		if s.Tool == ToolCodex {
			codex = s
		}
	}
	if !codex.Missing {
		t.Error("pruned session not marked missing")
	}
	if codex.Resume != nil {
		t.Error("tombstone still offers a resume command for a file that is gone")
	}
	if _, err := x.ReadPage(ToolCodex, codexFixtureID, 0, "forward", 0); err == nil {
		t.Error("ReadPage of a tombstone succeeded; want not-found")
	}
	// Search must skip the tombstone rather than error on its absent file.
	hits, _, _, err := x.Search(context.Background(), "profile the slow endpoint", nil, "", 0)
	if err != nil {
		t.Fatalf("Search over a tombstoned store: %v", err)
	}
	if len(hits) != 0 {
		t.Errorf("Search found %d hits in a pruned file, want 0", len(hits))
	}

	// The tombstone survives a restart: the persisted index is the only
	// witness left, so a reload must keep carrying it.
	x.persist()
	reloaded := New(x.persistDir, x.home)
	found := false
	reloaded.mu.Lock()
	for _, e := range reloaded.entries {
		if e.Summary.Tool == ToolCodex && e.Missing {
			found = true
		}
	}
	reloaded.mu.Unlock()
	if !found {
		t.Error("tombstone did not survive persist and reload")
	}

	// The file back on disk — restored from a backup, say — clears the mark.
	write(t, paths[ToolCodex], fixture(t, "codex-rollout.jsonl"))
	x.sweep()
	sums, _ = x.Snapshot([]string{"codex"}, "")
	if len(sums) != 1 || sums[0].Missing {
		t.Errorf("restored transcript still reads as missing: %+v", sums)
	}
}

// TestHistoryReadsClaudeStatsCache pins the backfill source: Claude Code's
// own per-day aggregate, taken as session counts, with idle days and
// malformed dates skipped and an absent file meaning no history at all.
func TestHistoryReadsClaudeStatsCache(t *testing.T) {
	home, _ := fakeHome(t)
	x := New(t.TempDir(), home)
	if got := x.History(); len(got) != 0 {
		t.Fatalf("History with no stats-cache = %+v, want empty", got)
	}

	write(t, filepath.Join(home, ".claude", "stats-cache.json"), []byte(`{
		"version": 5,
		"dailyActivity": [
			{"date": "2026-04-07", "messageCount": 273, "sessionCount": 4, "toolCallCount": 100},
			{"date": "2026-04-08", "messageCount": 0, "sessionCount": 0, "toolCallCount": 0},
			{"date": "not-a-date", "messageCount": 5, "sessionCount": 2, "toolCallCount": 1},
			{"date": "2026-04-09", "messageCount": 90, "sessionCount": 7, "toolCallCount": 12}
		]
	}`))
	want := []HistoryDay{
		{Tool: ToolClaude, Date: "2026-04-07", Sessions: 4},
		{Tool: ToolClaude, Date: "2026-04-09", Sessions: 7},
	}
	got := x.History()
	if len(got) != len(want) {
		t.Fatalf("History = %+v, want %+v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("History[%d] = %+v, want %+v", i, got[i], want[i])
		}
	}
	// The second read answers from the stat-keyed cache and says the same.
	again := x.History()
	if len(again) != len(want) {
		t.Fatalf("cached History = %+v, want %+v", again, want)
	}
}
