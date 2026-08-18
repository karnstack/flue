package agentstore

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
)

func TestSearchFindsAndLabelsHits(t *testing.T) {
	x, _, _ := newSweptIndex(t)
	hits, building, truncated, err := x.Search(context.Background(), "nginx", nil, "", 0)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if building {
		t.Error("building = true after a completed sweep")
	}
	if truncated {
		t.Error("truncated = true under the default cap")
	}
	// The word rides the prompt, the assistant's reply, and the grep
	// command's tool_call input.
	if len(hits) != 3 {
		t.Fatalf("Search found %d hits, want 3: %+v", len(hits), hits)
	}
	h := hits[0]
	if h.Tool != ToolClaude || h.ID != claudeFixtureID || h.Cwd != "/home/dev/proj" {
		t.Errorf("hit identity = (%s, %s, %s)", h.Tool, h.ID, h.Cwd)
	}
	if h.Title != "Fix flaky nginx test" {
		t.Errorf("hit Title = %q", h.Title)
	}
	if h.Role != "user" || !strings.Contains(h.Snippet, "nginx") {
		t.Errorf("hit = role %q snippet %q, want the prompt", h.Role, h.Snippet)
	}
	if h.Offset <= 0 {
		t.Errorf("hit Offset = %d, want the message line's offset", h.Offset)
	}
	// The offset pages: reading forward from it must yield the matched
	// message first.
	page, err := x.ReadPage(h.Tool, h.ID, h.Offset, "forward", 1)
	if err != nil {
		t.Fatalf("ReadPage(hit.Offset): %v", err)
	}
	if len(page.Messages) == 0 || !strings.Contains(page.Messages[0].Text, "nginx") {
		t.Errorf("paging to the hit read %+v", page.Messages)
	}
}

func TestSearchIsCaseInsensitive(t *testing.T) {
	x, _, _ := newSweptIndex(t)
	hits, _, _, err := x.Search(context.Background(), "NGINX CONFIG", nil, "", 0)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(hits) != 1 {
		t.Fatalf("found %d hits, want the lowercase prompt", len(hits))
	}
}

func TestSearchWalksSessionsNewestFirst(t *testing.T) {
	x, _, _ := newSweptIndex(t)
	// "the" appears in all three fixtures; the sessions order by recency:
	// Claude (August), Codex (July), Pi (March).
	hits, _, _, err := x.Search(context.Background(), "the", nil, "", 0)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	seen := []Tool{}
	for _, h := range hits {
		if len(seen) == 0 || seen[len(seen)-1] != h.Tool {
			seen = append(seen, h.Tool)
		}
	}
	want := []Tool{ToolClaude, ToolCodex, ToolPi}
	if len(seen) != len(want) {
		t.Fatalf("hits visit tools %v, want %v", seen, want)
	}
	for i := range want {
		if seen[i] != want[i] {
			t.Fatalf("hits visit tools %v, want %v", seen, want)
		}
	}
}

func TestSearchCapsAndSaysSo(t *testing.T) {
	x, _, _ := newSweptIndex(t)
	hits, _, truncated, err := x.Search(context.Background(), "nginx", nil, "", 1)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(hits) != 1 {
		t.Fatalf("limit 1 returned %d hits", len(hits))
	}
	if !truncated {
		t.Error("truncated = false with a second match unreported")
	}
}

// TestSearchCapOnTheLastMessageIsComplete: hitting the cap on the store's
// very last message is a complete answer, and truncated must not claim
// otherwise — while the same cap one message earlier, with a line still
// unscanned, is exactly what the flag is for.
func TestSearchCapOnTheLastMessageIsComplete(t *testing.T) {
	home := t.TempDir()
	content := `{"type":"user","message":{"role":"user","content":"find the needle"},"timestamp":"2026-08-10T09:00:00.000Z","cwd":"/p"}` + "\n" +
		`{"type":"user","message":{"role":"user","content":"needle again"},"timestamp":"2026-08-10T09:00:01.000Z","cwd":"/p"}` + "\n"
	write(t, filepath.Join(home, ".claude", "projects", "-p", "dddd.jsonl"), []byte(content))
	x := New(t.TempDir(), home)
	x.sweep()

	hits, _, truncated, err := x.Search(context.Background(), "needle", nil, "", 2)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(hits) != 2 {
		t.Fatalf("found %d hits, want 2", len(hits))
	}
	if truncated {
		t.Error("truncated = true over a complete answer")
	}

	if _, _, truncated, _ = x.Search(context.Background(), "needle", nil, "", 1); !truncated {
		t.Error("truncated = false with a line still unscanned")
	}
}

func TestSearchFilters(t *testing.T) {
	x, _, _ := newSweptIndex(t)
	if hits, _, _, _ := x.Search(context.Background(), "nginx", []string{"pi", "codex"}, "", 0); len(hits) != 0 {
		t.Errorf("tool filter leaked %d hits", len(hits))
	}
	if hits, _, _, _ := x.Search(context.Background(), "nginx", nil, "/somewhere/else", 0); len(hits) != 0 {
		t.Errorf("cwd filter leaked %d hits", len(hits))
	}
	if hits, _, _, _ := x.Search(context.Background(), "webhook", []string{"pi"}, "/home/dev/proj", 0); len(hits) == 0 {
		t.Error("a matching filter found nothing")
	}
}

// TestSearchStopsOnACancelledContext: the caller that cancels is a closing
// connection, and the scan must not keep reading files for an answer nobody
// is left to hear.
func TestSearchStopsOnACancelledContext(t *testing.T) {
	x, _, _ := newSweptIndex(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, _, err := x.Search(ctx, "nginx", nil, "", 0); err != context.Canceled {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
}

func TestSearchRefusesAnEmptyQuery(t *testing.T) {
	x, _, _ := newSweptIndex(t)
	if _, _, _, err := x.Search(context.Background(), "   ", nil, "", 0); err != ErrBadQuery {
		t.Fatalf("err = %v, want ErrBadQuery", err)
	}
}

func TestSnippetFoldsAndBounds(t *testing.T) {
	long := strings.Repeat("x", 200) + "needle\nafter the newline " + strings.Repeat("y", 200)
	got := snippet(long, 200, len("needle"))
	if strings.ContainsAny(got, "\n\t") {
		t.Errorf("snippet is not one line: %q", got)
	}
	if !strings.Contains(got, "needle") {
		t.Errorf("snippet lost the match: %q", got)
	}
	// ~80 of context each side, whitespace folded: nowhere near the whole
	// blob.
	if len(got) > 2*snippetContext+len("needle")+16 {
		t.Errorf("snippet is %d bytes, want the match plus ~%d context each side", len(got), snippetContext)
	}
}
