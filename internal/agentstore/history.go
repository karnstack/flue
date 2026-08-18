package agentstore

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"time"
)

// Backfill history.
//
// The transcripts are the truth, but they are a truth with a horizon: Claude
// Code deletes transcripts past its cleanup period (thirty days by default),
// so the files can never witness more history than the period keeps, and a
// machine that started indexing today has no transcript evidence of last
// spring at all. What Claude Code does keep forever is its own aggregate —
// ~/.claude/stats-cache.json, the file behind /usage — with a per-day session
// count going back to the first session ever. That aggregate is read here and
// served beside the summaries as HistoryDay rows, so a client can chart the
// days the transcripts no longer reach.
//
// Only the session counts are taken. The file's per-day token figures fold
// cache reads into one number, which is a different measurement than the
// four-bucket accounting the summaries carry — hundreds of times larger for
// a cached session — and charting the two on one axis would be a lie. Days
// the transcripts still witness are served anyway; merging (per day, per
// tool, take the larger) is the client's job, which keeps this side simple
// and the double-count impossible to reach by accident.
//
// Codex and Pi keep no such aggregate today — they also do not prune, so
// their transcripts are their whole history and need no backfill. The shape
// carries the tool name so a store that grows an aggregate later slots in.

// HistoryDay is one day of one tool's own aggregate accounting: how many
// sessions began that day, by the tool's count of it.
type HistoryDay struct {
	Tool Tool `json:"tool"`
	// Date is the day in the tool's own calendar, YYYY-MM-DD — local to the
	// machine that wrote it, which is also the machine serving it.
	Date     string `json:"date"`
	Sessions int    `json:"sessions"`
}

// HistoryTotals is one model's share of one tool's lifetime accounting, in
// the same four buckets the summaries carry — Claude Code's modelUsage keeps
// them split, so unlike the per-day figures these merge cleanly with the
// transcript-derived numbers. Lifetime only: the aggregate offers no way to
// slice them by range, which is why a client applies them to its all-time
// view alone.
type HistoryTotals struct {
	Tool   Tool       `json:"tool"`
	Model  string     `json:"model"`
	Tokens TokenUsage `json:"tokens"`
}

// historyMaxBytes bounds the read: the real file is a few hundred kilobytes
// of daily entries; anything vastly larger is not the file this reader is
// for.
const historyMaxBytes = 8 << 20

// History reads the per-day backfill the stores' own aggregates offer —
// today, Claude Code's stats-cache.json. Absent, unreadable or malformed
// files are an empty history, never an error: backfill is a bonus over the
// transcripts, not a dependency. The parse is cached against the file's
// stat, so the sweep-per-poke pattern costs one stat rather than one parse.
func (x *Index) History() []HistoryDay {
	days, _ := x.history()
	return days
}

// HistoryTotals reads the lifetime per-model accounting the same aggregate
// keeps, on the same cache and the same fail-to-empty terms as History.
func (x *Index) HistoryTotals() []HistoryTotals {
	_, totals := x.history()
	return totals
}

func (x *Index) history() ([]HistoryDay, []HistoryTotals) {
	if x.home == "" {
		return nil, nil
	}
	path := filepath.Join(x.home, ".claude", "stats-cache.json")
	fi, err := os.Stat(path)
	if err != nil || !fi.Mode().IsRegular() || fi.Size() > historyMaxBytes {
		return nil, nil
	}

	x.histMu.Lock()
	defer x.histMu.Unlock()
	if x.histSize == fi.Size() && x.histMtimeNs == fi.ModTime().UnixNano() {
		return append([]HistoryDay(nil), x.hist...), append([]HistoryTotals(nil), x.histTotals...)
	}

	b, err := os.ReadFile(path)
	if err != nil {
		return nil, nil
	}
	var p struct {
		DailyActivity []struct {
			Date         string `json:"date"`
			SessionCount int    `json:"sessionCount"`
		} `json:"dailyActivity"`
		ModelUsage map[string]struct {
			InputTokens              int64 `json:"inputTokens"`
			OutputTokens             int64 `json:"outputTokens"`
			CacheReadInputTokens     int64 `json:"cacheReadInputTokens"`
			CacheCreationInputTokens int64 `json:"cacheCreationInputTokens"`
		} `json:"modelUsage"`
	}
	if json.Unmarshal(b, &p) != nil {
		return nil, nil
	}
	hist := []HistoryDay{}
	for _, d := range p.DailyActivity {
		// A malformed date or an idle day says nothing a chart can use.
		if d.SessionCount <= 0 {
			continue
		}
		if _, err := time.Parse("2006-01-02", d.Date); err != nil {
			continue
		}
		hist = append(hist, HistoryDay{Tool: ToolClaude, Date: d.Date, Sessions: d.SessionCount})
	}
	totals := []HistoryTotals{}
	for model, u := range p.ModelUsage {
		t := TokenUsage{
			Input: u.InputTokens, Output: u.OutputTokens,
			CacheRead: u.CacheReadInputTokens, CacheWrite: u.CacheCreationInputTokens,
		}
		if model == "" || t == (TokenUsage{}) {
			continue
		}
		totals = append(totals, HistoryTotals{Tool: ToolClaude, Model: model, Tokens: t})
	}
	// Map order is random; the wire and its tests deserve a stable one.
	sort.Slice(totals, func(i, j int) bool { return totals[i].Model < totals[j].Model })
	x.histSize, x.histMtimeNs, x.hist, x.histTotals = fi.Size(), fi.ModTime().UnixNano(), hist, totals
	return append([]HistoryDay(nil), hist...), append([]HistoryTotals(nil), totals...)
}
