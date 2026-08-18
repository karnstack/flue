package agentstore

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// Codex keeps rollouts under ~/.codex/sessions/YYYY/MM/DD, one
// rollout-<timestamp>-<uuid>.jsonl per session. Every line is
// {timestamp, type, payload}; the conversation itself rides response_item
// payloads, the model rides turn_context, and the token accounting rides
// event_msg token_count lines whose totals are cumulative — the last one seen
// is the session's bill, which is what makes incremental reparsing safe: a
// newer line always supersedes, never adds.

type codexAdapter struct{}

func (codexAdapter) tool() Tool { return ToolCodex }

func (codexAdapter) roots(home string) []string {
	if home == "" {
		return nil
	}
	return []string{filepath.Join(home, ".codex", "sessions")}
}

// transcripts walks the year/month/day layout, exactly three levels deep. A
// bounded walk rather than filepath.WalkDir, so a stray deep tree under the
// store cannot make a sweep crawl it.
func (codexAdapter) transcripts(root string) []string {
	var out []string
	years, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	for _, y := range years {
		if !y.IsDir() {
			continue
		}
		months, err := os.ReadDir(filepath.Join(root, y.Name()))
		if err != nil {
			continue
		}
		for _, m := range months {
			if !m.IsDir() {
				continue
			}
			days, err := os.ReadDir(filepath.Join(root, y.Name(), m.Name()))
			if err != nil {
				continue
			}
			for _, d := range days {
				if !d.IsDir() {
					continue
				}
				files, err := os.ReadDir(filepath.Join(root, y.Name(), m.Name(), d.Name()))
				if err != nil {
					continue
				}
				for _, f := range files {
					if f.IsDir() || !strings.HasSuffix(f.Name(), ".jsonl") {
						continue
					}
					out = append(out, filepath.Join(root, y.Name(), m.Name(), d.Name(), f.Name()))
				}
			}
		}
	}
	return out
}

// idFromPath is the uuid tail of rollout-<timestamp>-<uuid>.jsonl — the
// fallback identity for a file whose session_meta has not been parsed yet or
// never arrived. The uuid is the trailing 36 characters; a name too short to
// hold one identifies the file by its whole base name, which is still unique
// within the store.
func (codexAdapter) idFromPath(path string) string {
	name := strings.TrimSuffix(filepath.Base(path), ".jsonl")
	if len(name) > 36 {
		return name[len(name)-36:]
	}
	return name
}

func (codexAdapter) parser(path string, prev parseState) lineParser {
	p := &codexParser{state: prev}
	if p.state.Summary.ID == "" {
		p.state.Summary = newSummary(ToolCodex, codexAdapter{}.idFromPath(path))
	}
	return p
}

func (codexAdapter) resume(sum Summary, path string) *Resume {
	if sum.Cwd == "" {
		return nil
	}
	return &Resume{Cmd: []string{"codex", "resume", sum.ID}, Cwd: sum.Cwd}
}

type codexLine struct {
	Timestamp string          `json:"timestamp"`
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
}

// The payload shapes, one struct per line type rather than a union: the same
// key means different things on different lines — turn_context carries
// `summary: "auto"` where a reasoning item carries `summary: [...]` — and a
// union struct would fail to unmarshal the very lines it meant to read.

type codexSessionMeta struct {
	ID  string `json:"id"`
	Cwd string `json:"cwd"`
}

type codexTurnContext struct {
	Model string `json:"model"`
}

type codexEventMsg struct {
	Type string              `json:"type"`
	Info *codexTokenCountMsg `json:"info"`
}

type codexResponseItem struct {
	Type    string             `json:"type"`
	Role    string             `json:"role"`
	Content []codexContentPart `json:"content"`
	Summary []codexContentPart `json:"summary"`
	Name    string             `json:"name"`
	Args    string             `json:"arguments"`
	Input   string             `json:"input"`
	Output  string             `json:"output"`
}

type codexContentPart struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type codexTokenCountMsg struct {
	Total *codexTokenUsage `json:"total_token_usage"`
}

type codexTokenUsage struct {
	InputTokens      int64 `json:"input_tokens"`
	CachedInput      int64 `json:"cached_input_tokens"`
	CacheWriteInput  int64 `json:"cache_write_input_tokens"`
	OutputTokens     int64 `json:"output_tokens"`
	ReasoningOutput  int64 `json:"reasoning_output_tokens"`
	TotalTokensCount int64 `json:"total_tokens"`
}

type codexParser struct {
	state parseState
	// model is the latest turn_context's model, stamped onto the assistant
	// messages that follow it. Within-run state only: a parse that starts
	// mid-file simply leaves model empty until the next turn_context, and the
	// field is omitempty for exactly that.
	model string
}

func (p *codexParser) result() parseState { return p.state }

func (p *codexParser) line(b []byte, off int64) []Message {
	var l codexLine
	if json.Unmarshal(b, &l) != nil {
		return nil
	}
	sum := &p.state.Summary

	switch l.Type {
	case "session_meta":
		var meta codexSessionMeta
		if json.Unmarshal(l.Payload, &meta) != nil {
			return nil
		}
		if meta.ID != "" {
			sum.ID = meta.ID
		}
		if sum.Cwd == "" && meta.Cwd != "" {
			sum.Cwd = meta.Cwd
		}
		return nil
	case "turn_context":
		var tc codexTurnContext
		if json.Unmarshal(l.Payload, &tc) != nil {
			return nil
		}
		if tc.Model != "" {
			p.model = tc.Model
			sum.noteModel(tc.Model)
		}
		return nil
	case "event_msg":
		// The cumulative bill, replaced wholesale: input arrives with the
		// cached share still inside it, so the cache reads are pulled back out
		// to keep the four buckets disjoint the way the other tools report
		// them.
		var ev codexEventMsg
		if json.Unmarshal(l.Payload, &ev) != nil {
			return nil
		}
		if ev.Type == "token_count" && ev.Info != nil && ev.Info.Total != nil {
			u := ev.Info.Total
			input := u.InputTokens - u.CachedInput
			if input < 0 {
				input = 0
			}
			sum.Tokens = TokenUsage{
				Input:      input,
				Output:     u.OutputTokens,
				CacheRead:  u.CachedInput,
				CacheWrite: u.CacheWriteInput,
			}
		}
		return nil
	case "response_item":
		// Below.
	default:
		return nil
	}

	var pl codexResponseItem
	if json.Unmarshal(l.Payload, &pl) != nil {
		return nil
	}
	ts := normTS(l.Timestamp)
	var msgs []Message
	switch pl.Type {
	case "message":
		// Developer messages are instruction plumbing with no place in a
		// conversation view; user messages wrapped in environment or
		// instruction tags are the harness speaking and become role system.
		if pl.Role == "developer" {
			return nil
		}
		text := joinParts(pl.Content)
		role := pl.Role
		switch {
		case role == "user" && (strings.HasPrefix(text, "<environment_context>") || strings.HasPrefix(text, "<user_instructions>")):
			role = "system"
		case role == "assistant":
			// keep
		case role == "user":
			// keep
		default:
			return nil
		}
		msg := Message{Role: role, Kind: "text", Ts: ts, Text: text, Offset: off}
		if role == "assistant" {
			msg.Model = p.model
		}
		if sum.FirstPrompt == "" && role == "user" {
			sum.FirstPrompt = capPrompt(text)
		}
		msgs = []Message{msg}
	case "reasoning":
		// Usually encrypted with an empty summary; only a summary with words
		// in it is a message.
		text := joinParts(pl.Summary)
		if text == "" {
			return nil
		}
		msgs = []Message{{Role: "assistant", Kind: "thinking", Ts: ts, Model: p.model, Text: text, Offset: off}}
	case "function_call":
		sum.ToolCallCount++
		msgs = []Message{{Role: "assistant", Kind: "tool_call", Ts: ts, Model: p.model, ToolName: pl.Name, Text: pl.Args, Offset: off}}
	case "custom_tool_call":
		sum.ToolCallCount++
		msgs = []Message{{Role: "assistant", Kind: "tool_call", Ts: ts, Model: p.model, ToolName: pl.Name, Text: pl.Input, Offset: off}}
	case "function_call_output", "custom_tool_call_output":
		msgs = []Message{{Role: "user", Kind: "tool_result", Ts: ts, Text: pl.Output, Offset: off}}
	default:
		return nil
	}
	p.state.count(msgs)
	return msgs
}

func joinParts(parts []codexContentPart) string {
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if part.Text != "" {
			out = append(out, part.Text)
		}
	}
	return strings.Join(out, "\n")
}
