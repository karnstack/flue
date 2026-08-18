package agentstore

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

// parseWhole runs one adapter's parser over a file from the top, the way a
// sweep parses a new file, and hands back everything it accumulated.
func parseWhole(t *testing.T, ad adapter, path string) (parseState, int64) {
	t.Helper()
	x := &Index{entries: map[string]*entry{}}
	st, off, ok := x.parseFrom(ad, path, 0, parseState{})
	if !ok {
		t.Fatalf("parseFrom(%s) failed", path)
	}
	return st, off
}

func utc(year int, month time.Month, day, h, m, s, ns int) time.Time {
	return time.Date(year, month, day, h, m, s, ns, time.UTC)
}

// TestSummariesFromFixtures pins every number a summary carries, worked out
// by hand from the fixtures — which deliberately hold unknown line types and
// harness noise, so passing here is also the skip-don't-fail rule holding.
func TestSummariesFromFixtures(t *testing.T) {
	cases := []struct {
		name    string
		ad      adapter
		fixture string
		want    Summary
		title   string
		cost    float64
	}{
		{
			name: "claude", ad: claudeAdapter{}, fixture: "claude-session.jsonl",
			title: "Fix flaky nginx test",
			want: Summary{
				// The id falls back to the filename: Claude names the file
				// after the conversation and records no id inside it.
				ID: "claude-session", Tool: ToolClaude, Cwd: "/home/dev/proj",
				FirstPrompt: "fix the flaky nginx config test",
				StartedAt:   utc(2026, 8, 10, 9, 0, 2, 0),
				EndedAt:     utc(2026, 8, 10, 9, 0, 20, 0),
				// Six countable messages: the prompt, three req_A1 blocks,
				// the tool result, and the closing text. The caveat and the
				// /clear echo are system lines and outside the count.
				MessageCount: 6, ToolCallCount: 1,
				Models: []string{"claude-fable-5"},
				// req_A1's usage appears on three lines and counts once:
				// 12+30, 40+25, 1500+2100, 600+0.
				Tokens: TokenUsage{Input: 42, Output: 65, CacheRead: 3600, CacheWrite: 600},
			},
		},
		{
			name: "codex", ad: codexAdapter{}, fixture: "codex-rollout.jsonl",
			title: "profile the slow endpoint",
			want: Summary{
				ID: "22222222-2222-4222-8222-222222222222", Tool: ToolCodex, Cwd: "/home/dev/proj",
				FirstPrompt: "profile the slow endpoint",
				StartedAt:   utc(2026, 7, 1, 10, 0, 4, 0),
				EndedAt:     utc(2026, 7, 1, 10, 5, 12, 0),
				// Two prompts, one reasoning summary, two calls, two results,
				// two answers; the environment context is system and the
				// developer instructions are skipped outright.
				MessageCount: 9, ToolCallCount: 2,
				Models: []string{"gpt-5.6", "gpt-5.6-sol"},
				// The LAST token_count is the bill (cumulative), with the
				// cached share pulled out of input: 21000-18000, 410, 18000, 0.
				Tokens: TokenUsage{Input: 3000, Output: 410, CacheRead: 18000, CacheWrite: 0},
			},
		},
		{
			name: "pi", ad: piAdapter{}, fixture: "pi-session.jsonl",
			title: "webhook retries",
			cost:  0.025108 + 0.004808,
			want: Summary{
				ID: "33333333-3333-4333-8333-333333333333", Tool: ToolPi, Cwd: "/home/dev/proj",
				FirstPrompt: "wire up the webhook retries",
				StartedAt:   utc(2026, 3, 27, 12, 38, 32, 330_000_000),
				EndedAt:     utc(2026, 3, 27, 12, 39, 0, 0),
				// Prompt, thinking, tool call, tool result, answer.
				MessageCount: 5, ToolCallCount: 1,
				Models: []string{"gpt-5.4"},
				// Per-message sums: 5848+148, 680+170, 1152+7552, 0.
				Tokens: TokenUsage{Input: 5996, Output: 850, CacheRead: 8704, CacheWrite: 0},
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			st, _ := parseWhole(t, tc.ad, filepath.Join("testdata", tc.fixture))
			sum := st.Summary
			if sum.ID != tc.want.ID || sum.Tool != tc.want.Tool || sum.Cwd != tc.want.Cwd {
				t.Errorf("identity = (%s, %s, %s), want (%s, %s, %s)",
					sum.Tool, sum.ID, sum.Cwd, tc.want.Tool, tc.want.ID, tc.want.Cwd)
			}
			if sum.FirstPrompt != tc.want.FirstPrompt {
				t.Errorf("FirstPrompt = %q, want %q", sum.FirstPrompt, tc.want.FirstPrompt)
			}
			if got := st.title(); got != tc.title {
				t.Errorf("title = %q, want %q", got, tc.title)
			}
			if !sum.StartedAt.Equal(tc.want.StartedAt) || !sum.EndedAt.Equal(tc.want.EndedAt) {
				t.Errorf("span = %v..%v, want %v..%v", sum.StartedAt, sum.EndedAt, tc.want.StartedAt, tc.want.EndedAt)
			}
			if sum.MessageCount != tc.want.MessageCount {
				t.Errorf("MessageCount = %d, want %d", sum.MessageCount, tc.want.MessageCount)
			}
			if sum.ToolCallCount != tc.want.ToolCallCount {
				t.Errorf("ToolCallCount = %d, want %d", sum.ToolCallCount, tc.want.ToolCallCount)
			}
			if sum.Tokens != tc.want.Tokens {
				t.Errorf("Tokens = %+v, want %+v", sum.Tokens, tc.want.Tokens)
			}
			if len(sum.Models) != len(tc.want.Models) {
				t.Fatalf("Models = %v, want %v", sum.Models, tc.want.Models)
			}
			for i := range sum.Models {
				if sum.Models[i] != tc.want.Models[i] {
					t.Errorf("Models = %v, want %v", sum.Models, tc.want.Models)
					break
				}
			}
			if diff := sum.CostUsd - tc.cost; diff > 1e-9 || diff < -1e-9 {
				t.Errorf("CostUsd = %v, want %v", sum.CostUsd, tc.cost)
			}
		})
	}
}

// TestClaudeUsageCountsOncePerRequestID isolates the dedupe the table above
// exercises in aggregate: req_A1 appears on three lines with the same usage
// object, and a parser that summed naively would report triple.
// TestClaudeEmptyThinkingIsDropped pins the redaction rule: Claude Code
// writes thinking blocks with a signature and an empty body, and a viewer
// row that expands to nothing is noise. A blank block yields no message; one
// with text still does (the fixture's own thinking line proves the latter).
func TestClaudeEmptyThinkingIsDropped(t *testing.T) {
	p := claudeAdapter{}.parser("x.jsonl", parseState{})
	line := `{"type":"assistant","requestId":"r1","timestamp":"2026-08-10T09:00:05.000Z","message":{"role":"assistant","model":"claude-fable-5","content":[{"type":"thinking","thinking":"","signature":"sig"},{"type":"text","text":"hi"}]}}`
	msgs := p.line([]byte(line), 0)
	if len(msgs) != 1 || msgs[0].Kind != "text" {
		t.Fatalf("messages = %+v, want just the text block", msgs)
	}
}

func TestClaudeUsageCountsOncePerRequestID(t *testing.T) {
	st, _ := parseWhole(t, claudeAdapter{}, filepath.Join("testdata", "claude-session.jsonl"))
	// req_A1 contributes 1500 cacheRead once; req_A2 adds 2100. Three req_A1
	// lines summed naively would read 6600.
	if got := st.Summary.Tokens.CacheRead; got != 3600 {
		t.Fatalf("CacheRead = %d, want 3600 (usage deduped by requestId)", got)
	}
}

// TestTitlePrecedence pins the ladder: a human-set title beats a generated
// one beats the first prompt, and a repeated generated title is last-wins.
func TestTitlePrecedence(t *testing.T) {
	prompt := `{"type":"user","message":{"role":"user","content":"first ask"},"timestamp":"2026-08-10T09:00:00.000Z","cwd":"/p"}` + "\n"
	aiA := `{"type":"ai-title","aiTitle":"generated A"}` + "\n"
	aiB := `{"type":"ai-title","aiTitle":"generated B"}` + "\n"
	custom := `{"type":"custom-title","customTitle":"named by hand"}` + "\n"

	cases := []struct {
		name, content, want string
	}{
		{"promptAlone", prompt, "first ask"},
		{"aiTitleBeatsPrompt", prompt + aiA, "generated A"},
		{"lastAiTitleWins", prompt + aiA + aiB, "generated B"},
		{"customBeatsAll", prompt + aiA + custom + aiB, "named by hand"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "s.jsonl")
			if err := os.WriteFile(path, []byte(tc.content), 0o600); err != nil {
				t.Fatalf("WriteFile: %v", err)
			}
			st, _ := parseWhole(t, claudeAdapter{}, path)
			if got := st.title(); got != tc.want {
				t.Errorf("title = %q, want %q", got, tc.want)
			}
		})
	}
}

// TestMalformedLinesAreSkippedNotFatal is the skip-don't-fail rule at its
// bluntest: garbage between good lines costs the garbage and nothing else.
func TestMalformedLinesAreSkippedNotFatal(t *testing.T) {
	content := `not json at all` + "\n" +
		`{"type":"user","message":{"role":"user","content":"still here"},"timestamp":"2026-08-10T09:00:00.000Z","cwd":"/p"}` + "\n" +
		`{"truncated":` + "\n" +
		`{"type":"user","message":{"role":"user","content":"and here"},"timestamp":"2026-08-10T09:00:01.000Z","cwd":"/p"}` + "\n"
	path := filepath.Join(t.TempDir(), "s.jsonl")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	st, _ := parseWhole(t, claudeAdapter{}, path)
	if st.Summary.MessageCount != 2 {
		t.Fatalf("MessageCount = %d, want 2 (garbage skipped)", st.Summary.MessageCount)
	}
	if st.Summary.FirstPrompt != "still here" {
		t.Fatalf("FirstPrompt = %q, want the first parseable prompt", st.Summary.FirstPrompt)
	}
}

// TestFirstPromptIsCappedAtParseTime: a first prompt the size of a pasted
// file is stored capped, because the summary rides the persisted index and
// every agentIndex reply — and the cut lands on a rune boundary, since half a
// code point is not shorter text, it is mojibake. All three adapters go
// through the one shared helper, and this is the test that notices if one
// stops.
func TestFirstPromptIsCappedAtParseTime(t *testing.T) {
	// Three-byte runes, so the cap falls mid-rune: firstPromptBytes % 3 == 1.
	prompt := strings.Repeat("€", (firstPromptBytes/3)*2)
	if len(prompt) <= firstPromptBytes {
		t.Fatalf("the fixture prompt is %d bytes, not past the %d cap", len(prompt), firstPromptBytes)
	}
	cases := []struct {
		name string
		ad   adapter
		line string
	}{
		{"claude", claudeAdapter{},
			`{"type":"user","message":{"role":"user","content":"` + prompt + `"},"timestamp":"2026-08-10T09:00:00.000Z","cwd":"/p"}`},
		{"codex", codexAdapter{},
			`{"timestamp":"2026-07-01T10:00:04.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"` + prompt + `"}]}}`},
		{"pi", piAdapter{},
			`{"type":"message","timestamp":"2026-03-27T12:38:32.330Z","message":{"role":"user","content":"` + prompt + `"}}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "s.jsonl")
			if err := os.WriteFile(path, []byte(tc.line+"\n"), 0o600); err != nil {
				t.Fatalf("WriteFile: %v", err)
			}
			st, _ := parseWhole(t, tc.ad, path)
			got := st.Summary.FirstPrompt
			if len(got) > firstPromptBytes {
				t.Errorf("FirstPrompt is %d bytes, over the %d cap", len(got), firstPromptBytes)
			}
			if !utf8.ValidString(got) {
				t.Error("FirstPrompt is not valid UTF-8 after the cut")
			}
			if want := firstPromptBytes - firstPromptBytes%3; len(got) != want {
				t.Errorf("FirstPrompt is %d bytes, want %d (the rune boundary just under the cap)", len(got), want)
			}
			if !strings.HasPrefix(prompt, got) {
				t.Error("FirstPrompt is not a prefix of the prompt it was cut from")
			}
			// Nothing else named these sessions, so the title fallback is the
			// capped prompt — never the uncapped original.
			if ti := st.title(); ti != got {
				t.Errorf("title is %d bytes, want the capped prompt", len(ti))
			}
		})
	}
}

// TestResumeCommands pins each tool's resume spelling, and that a session
// with no known cwd offers none — a resume command run in the wrong
// directory being worse than no command.
func TestResumeCommands(t *testing.T) {
	sum := Summary{ID: "abc", Cwd: "/home/dev/proj"}
	if r := (claudeAdapter{}).resume(sum, "/x/abc.jsonl"); r == nil ||
		r.Cwd != "/home/dev/proj" || len(r.Cmd) != 3 || r.Cmd[0] != "claude" || r.Cmd[1] != "--resume" || r.Cmd[2] != "abc" {
		t.Errorf("claude resume = %+v", r)
	}
	if r := (codexAdapter{}).resume(sum, "/x/rollout.jsonl"); r == nil ||
		len(r.Cmd) != 3 || r.Cmd[0] != "codex" || r.Cmd[1] != "resume" || r.Cmd[2] != "abc" {
		t.Errorf("codex resume = %+v", r)
	}
	// Pi resumes from the transcript's own path, not an id.
	if r := (piAdapter{}).resume(sum, "/x/y_abc.jsonl"); r == nil ||
		len(r.Cmd) != 3 || r.Cmd[0] != "pi" || r.Cmd[1] != "--session" || r.Cmd[2] != "/x/y_abc.jsonl" {
		t.Errorf("pi resume = %+v", r)
	}
	if r := (claudeAdapter{}).resume(Summary{ID: "abc"}, "/x/abc.jsonl"); r != nil {
		t.Errorf("resume with no cwd = %+v, want nil", r)
	}
}

// TestSidechainFlagRidesTheMessages pins the flag a viewer separates subagent
// traffic on.
func TestSidechainFlagRidesTheMessages(t *testing.T) {
	content := `{"type":"user","isSidechain":true,"message":{"role":"user","content":"subagent prompt"},"timestamp":"2026-08-10T09:00:00.000Z","cwd":"/p"}` + "\n"
	path := filepath.Join(t.TempDir(), "s.jsonl")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	p := claudeAdapter{}.parser(path, parseState{})
	msgs := p.line([]byte(content[:len(content)-1]), 0)
	if len(msgs) != 1 || !msgs[0].Sidechain {
		t.Fatalf("msgs = %+v, want one sidechain message", msgs)
	}
	// And a sidechain's opening prompt is not the session's first prompt: the
	// assistant wrote it, not the person.
	if p.result().Summary.FirstPrompt != "" {
		t.Fatalf("FirstPrompt = %q, want empty", p.result().Summary.FirstPrompt)
	}
}
