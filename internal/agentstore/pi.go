package agentstore

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// Pi keeps sessions under ~/.pi/agent/sessions, one directory per working
// directory (slash-to-hyphen slug), one <timestamp>_<uuid>.jsonl per session.
// A session line opens the file with the id and cwd; session_info carries a
// human-given name; model_change announces the model; and message lines carry
// the conversation, each assistant message with its own usage block — dollar
// cost included, which is why Pi is the one tool whose summaries carry
// costUsd.

type piAdapter struct{}

func (piAdapter) tool() Tool { return ToolPi }

func (piAdapter) roots(home string) []string {
	if home == "" {
		return nil
	}
	return []string{filepath.Join(home, ".pi", "agent", "sessions")}
}

// transcripts is one directory level of cwd slugs, then the .jsonl files
// inside each — the same bounded shape as Claude's store.
func (piAdapter) transcripts(root string) []string {
	dirs, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	var out []string
	for _, d := range dirs {
		if !d.IsDir() {
			continue
		}
		files, err := os.ReadDir(filepath.Join(root, d.Name()))
		if err != nil {
			continue
		}
		for _, f := range files {
			if f.IsDir() || !strings.HasSuffix(f.Name(), ".jsonl") {
				continue
			}
			out = append(out, filepath.Join(root, d.Name(), f.Name()))
		}
	}
	return out
}

// idFromPath is the uuid after the underscore in <timestamp>_<uuid>.jsonl —
// the fallback for a file whose opening session line is missing or unreadable.
func (piAdapter) idFromPath(path string) string {
	name := strings.TrimSuffix(filepath.Base(path), ".jsonl")
	if _, id, ok := strings.Cut(name, "_"); ok && id != "" {
		return id
	}
	return name
}

func (piAdapter) parser(path string, prev parseState) lineParser {
	p := &piParser{state: prev}
	if p.state.Summary.ID == "" {
		p.state.Summary = newSummary(ToolPi, piAdapter{}.idFromPath(path))
	}
	return p
}

// resume names the transcript file itself: pi resumes from a path, not an id.
func (piAdapter) resume(sum Summary, path string) *Resume {
	if sum.Cwd == "" {
		return nil
	}
	return &Resume{Cmd: []string{"pi", "--session", path}, Cwd: sum.Cwd}
}

type piLine struct {
	Type      string          `json:"type"`
	ID        string          `json:"id"`
	Timestamp string          `json:"timestamp"`
	Cwd       string          `json:"cwd"`
	Name      string          `json:"name"`
	ModelID   string          `json:"modelId"`
	Message   json.RawMessage `json:"message"`
}

type piMessage struct {
	Role    string          `json:"role"`
	Model   string          `json:"model"`
	Content json.RawMessage `json:"content"`
	Usage   *piUsage        `json:"usage"`
}

type piUsage struct {
	Input      int64   `json:"input"`
	Output     int64   `json:"output"`
	CacheRead  int64   `json:"cacheRead"`
	CacheWrite int64   `json:"cacheWrite"`
	Cost       *piCost `json:"cost"`
}

type piCost struct {
	Total float64 `json:"total"`
}

type piBlock struct {
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	Thinking  string          `json:"thinking"`
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
}

type piParser struct {
	state parseState
}

func (p *piParser) result() parseState { return p.state }

func (p *piParser) line(b []byte, off int64) []Message {
	var l piLine
	if json.Unmarshal(b, &l) != nil {
		return nil
	}
	sum := &p.state.Summary
	switch l.Type {
	case "session":
		// A resumed file holds several session lines; the first names the
		// file, so the first wins for both fields.
		if p.state.SawSession {
			return nil
		}
		p.state.SawSession = true
		if l.ID != "" {
			sum.ID = l.ID
		}
		if sum.Cwd == "" && l.Cwd != "" {
			sum.Cwd = l.Cwd
		}
		return nil
	case "session_info":
		if l.Name != "" {
			p.state.NamedTitle = l.Name
		}
		return nil
	case "model_change":
		if l.ModelID != "" {
			sum.noteModel(l.ModelID)
		}
		return nil
	case "message":
		// Below.
	default:
		return nil
	}

	var m piMessage
	if json.Unmarshal(l.Message, &m) != nil {
		return nil
	}
	if m.Usage != nil {
		sum.Tokens.Input += m.Usage.Input
		sum.Tokens.Output += m.Usage.Output
		sum.Tokens.CacheRead += m.Usage.CacheRead
		sum.Tokens.CacheWrite += m.Usage.CacheWrite
		if m.Usage.Cost != nil {
			sum.CostUsd += m.Usage.Cost.Total
		}
	}
	if m.Model != "" {
		sum.noteModel(m.Model)
	}
	ts := normTS(l.Timestamp)

	var msgs []Message
	switch m.Role {
	case "user", "assistant":
		msgs = p.contentMessages(m, ts, off)
	case "toolResult":
		// The tool answering; role user for the same reason Claude's results
		// are — the wire's role enum has no fourth value, and a result is
		// input to the model.
		msgs = []Message{{Role: "user", Kind: "tool_result", Ts: ts, Text: piFlatten(m.Content), Offset: off}}
	default:
		return nil
	}
	p.state.count(msgs)
	return msgs
}

func (p *piParser) contentMessages(m piMessage, ts string, off int64) []Message {
	sum := &p.state.Summary
	note := func(msg Message) Message {
		if sum.FirstPrompt == "" && msg.Role == "user" && msg.Kind == "text" {
			sum.FirstPrompt = capPrompt(msg.Text)
		}
		return msg
	}

	var text string
	if json.Unmarshal(m.Content, &text) == nil {
		return []Message{note(Message{Role: m.Role, Kind: "text", Ts: ts, Model: m.Model, Text: text, Offset: off})}
	}
	var blocks []piBlock
	if json.Unmarshal(m.Content, &blocks) != nil {
		return nil
	}
	var out []Message
	for _, blk := range blocks {
		msg := Message{Role: m.Role, Ts: ts, Model: m.Model, Offset: off}
		switch blk.Type {
		case "text":
			msg.Kind, msg.Text = "text", blk.Text
		case "thinking":
			msg.Kind, msg.Text = "thinking", blk.Thinking
		case "toolCall":
			msg.Kind, msg.ToolName = "tool_call", blk.Name
			msg.Text = compactJSON(blk.Arguments)
			sum.ToolCallCount++
		default:
			continue
		}
		out = append(out, note(msg))
	}
	return out
}

// piFlatten turns a toolResult body — a string or an array of text blocks —
// into one string.
func piFlatten(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var blocks []piBlock
	if json.Unmarshal(raw, &blocks) != nil {
		return ""
	}
	parts := make([]string, 0, len(blocks))
	for _, blk := range blocks {
		if blk.Type == "text" && blk.Text != "" {
			parts = append(parts, blk.Text)
		}
	}
	return strings.Join(parts, "\n")
}
