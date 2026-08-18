package agentstore

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// Claude Code keeps one directory per project under ~/.claude/projects, named
// by a byte-mapped slug of the project's path, holding one .jsonl per
// conversation named by the conversation's uuid. Beside each conversation
// file sits a directory of the same uuid, holding tool results and — since
// the format moved subagents out of the main file — a subagents/ directory
// with one agent-<id>.jsonl per subagent run. Those subagent files carry the
// bulk of a busy store's tokens (they outnumber conversations ten to one on
// a real machine), so they are indexed too: not as sessions of their own,
// but as token accounting folded into the conversation that spawned them —
// see parentPath and the fold in Snapshot. Older transcripts that still hold
// subagent traffic inline (flagged isSidechain) keep working unchanged.
//
// Every line is a JSON object with a `type`. The types this parser interprets
// are user, assistant, ai-title and custom-title; everything else — mode,
// last-prompt, file-history-*, attachment, whatever ships next month — is
// bookkeeping it skips, by the package's skip-don't-fail rule.

// claudeAdapter implements adapter for Claude Code's store.
type claudeAdapter struct{}

func (claudeAdapter) tool() Tool { return ToolClaude }

func (claudeAdapter) roots(home string) []string {
	if home == "" {
		return nil
	}
	return []string{filepath.Join(home, ".claude", "projects")}
}

// transcripts is every conversation file under root — one directory level of
// project slugs, then the .jsonl files directly inside each — plus every
// subagent file at the one deeper spot the layout keeps them:
// <slug>/<uuid>/subagents/*.jsonl. Deliberately a bounded walk and not a
// recursive one — the session directories hold tool results too, and a walk
// into everything would list files that are neither sessions nor accounting.
func (claudeAdapter) transcripts(root string) []string {
	projects, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	var out []string
	for _, p := range projects {
		if !p.IsDir() {
			continue
		}
		dir := filepath.Join(root, p.Name())
		files, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, f := range files {
			if f.IsDir() {
				subs, err := os.ReadDir(filepath.Join(dir, f.Name(), "subagents"))
				if err != nil {
					continue
				}
				for _, s := range subs {
					if s.IsDir() || !strings.HasSuffix(s.Name(), ".jsonl") {
						continue
					}
					out = append(out, filepath.Join(dir, f.Name(), "subagents", s.Name()))
				}
				continue
			}
			if !strings.HasSuffix(f.Name(), ".jsonl") {
				continue
			}
			out = append(out, filepath.Join(dir, f.Name()))
		}
	}
	return out
}

// parentPath implements subagentFiler: a file under a session's subagents/
// directory augments the conversation file named after that session, a
// sibling of the session directory. Anything else is a session itself.
func (claudeAdapter) parentPath(path string) string {
	sub := filepath.Dir(path)
	if filepath.Base(sub) != "subagents" {
		return ""
	}
	return filepath.Dir(sub) + ".jsonl"
}

// idFromPath is the session's identity: Claude names the file after the
// conversation's uuid and records no id inside it.
func (claudeAdapter) idFromPath(path string) string {
	return strings.TrimSuffix(filepath.Base(path), ".jsonl")
}

func (claudeAdapter) parser(path string, prev parseState) lineParser {
	p := &claudeParser{state: prev}
	if p.state.Summary.ID == "" {
		p.state.Summary = newSummary(ToolClaude, claudeAdapter{}.idFromPath(path))
	}
	return p
}

func (claudeAdapter) resume(sum Summary, path string) *Resume {
	if sum.Cwd == "" {
		return nil
	}
	return &Resume{Cmd: []string{"claude", "--resume", sum.ID}, Cwd: sum.Cwd}
}

// claudeSlug is a working directory as Claude Code names its project
// directory: every byte that is not an ASCII letter or digit becomes a
// hyphen. A local copy of session.claudeSlug (internal/session/claude.go)
// rather than an import: the two packages read the same store for different
// reasons, and a shared symbol would couple a session-lifecycle package to a
// transcript viewer over eleven lines of byte mapping. The mapping is over
// bytes, not runes, deliberately — see the original for why.
func claudeSlug(cwd string) string {
	var b strings.Builder
	b.Grow(len(cwd))
	for i := 0; i < len(cwd); i++ {
		ch := cwd[i]
		switch {
		case ch >= 'a' && ch <= 'z', ch >= 'A' && ch <= 'Z', ch >= '0' && ch <= '9':
			b.WriteByte(ch)
		default:
			b.WriteByte('-')
		}
	}
	return b.String()
}

// claudeLine is the envelope every line shares. Message stays raw because its
// shape depends on the line's type and role.
type claudeLine struct {
	Type        string          `json:"type"`
	IsMeta      bool            `json:"isMeta"`
	IsSidechain bool            `json:"isSidechain"`
	RequestID   string          `json:"requestId"`
	Timestamp   string          `json:"timestamp"`
	Cwd         string          `json:"cwd"`
	AiTitle     string          `json:"aiTitle"`
	CustomTitle string          `json:"customTitle"`
	Message     json.RawMessage `json:"message"`
}

type claudeMessage struct {
	Role    string          `json:"role"`
	Model   string          `json:"model"`
	Content json.RawMessage `json:"content"`
	Usage   *claudeUsage    `json:"usage"`
}

type claudeUsage struct {
	InputTokens              int64 `json:"input_tokens"`
	OutputTokens             int64 `json:"output_tokens"`
	CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
	CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
}

// claudeBlock is one entry of a content array, whichever kind it is. The
// fields union the block types; the Type switch decides which are read.
type claudeBlock struct {
	Type     string          `json:"type"`
	Text     string          `json:"text"`
	Thinking string          `json:"thinking"`
	Name     string          `json:"name"`
	Input    json.RawMessage `json:"input"`
	Content  json.RawMessage `json:"content"`
}

type claudeParser struct {
	state parseState
}

func (p *claudeParser) result() parseState { return p.state }

func (p *claudeParser) line(b []byte, off int64) []Message {
	var l claudeLine
	if json.Unmarshal(b, &l) != nil {
		return nil
	}
	sum := &p.state.Summary
	switch l.Type {
	case "ai-title":
		// Repeated as the conversation grows; last wins.
		if l.AiTitle != "" {
			p.state.AiTitle = l.AiTitle
		}
		return nil
	case "custom-title":
		// A human named the session, which outranks anything generated.
		if l.CustomTitle != "" {
			p.state.NamedTitle = l.CustomTitle
		}
		return nil
	case "user", "assistant":
		// The only lines that carry conversation. Everything below.
	default:
		return nil
	}

	if sum.Cwd == "" && l.Cwd != "" {
		sum.Cwd = l.Cwd
	}
	var m claudeMessage
	if json.Unmarshal(l.Message, &m) != nil {
		return nil
	}
	ts := normTS(l.Timestamp)

	var msgs []Message
	if l.Type == "user" {
		msgs = p.userMessages(l, m, ts, off)
	} else {
		msgs = p.assistantMessages(l, m, ts, off)
	}
	p.state.count(msgs)
	return msgs
}

// userMessages normalizes one user line. Claude's user role carries three
// different speakers: the human, the harness (isMeta hook context, command
// echoes, caveats), and the tools answering an assistant's calls. The first
// stays role user; the second becomes role system so a viewer can fold it and
// the counts do not claim a human said it; the third becomes kind tool_result.
func (p *claudeParser) userMessages(l claudeLine, m claudeMessage, ts string, off int64) []Message {
	// String content: a plain prompt, or a harness line recognisable by its
	// prefix.
	var text string
	if json.Unmarshal(m.Content, &text) == nil {
		role := "user"
		if l.IsMeta || strings.HasPrefix(text, "<command-name>") ||
			strings.HasPrefix(text, "<local-command-stdout>") ||
			strings.HasPrefix(text, "Caveat:") {
			role = "system"
		}
		msg := Message{Role: role, Kind: "text", Ts: ts, Text: text, Sidechain: l.IsSidechain, Offset: off}
		p.noteFirstPrompt(msg)
		return []Message{msg}
	}

	var blocks []claudeBlock
	if json.Unmarshal(m.Content, &blocks) != nil {
		return nil
	}
	var out []Message
	for _, blk := range blocks {
		switch blk.Type {
		case "tool_result":
			out = append(out, Message{
				Role: "user", Kind: "tool_result", Ts: ts,
				Text: flattenBlocks(blk.Content), Sidechain: l.IsSidechain, Offset: off,
			})
		case "text":
			role := "user"
			if l.IsMeta {
				role = "system"
			}
			msg := Message{Role: role, Kind: "text", Ts: ts, Text: blk.Text, Sidechain: l.IsSidechain, Offset: off}
			p.noteFirstPrompt(msg)
			out = append(out, msg)
		}
	}
	return out
}

// assistantMessages normalizes one assistant line: one message per content
// block, and the line's usage counted at most once per requestId. Claude
// writes each block of one API response as its own line, every one carrying
// the response's requestId and the *same* usage object — summing naively
// triples the bill. Consecutive is enough for the dedupe: the lines of one
// response are adjacent, and requestIds never return once left.
func (p *claudeParser) assistantMessages(l claudeLine, m claudeMessage, ts string, off int64) []Message {
	if m.Usage != nil && (l.RequestID == "" || l.RequestID != p.state.LastRequestID) {
		p.state.LastRequestID = l.RequestID
		t := &p.state.Summary.Tokens
		t.Input += m.Usage.InputTokens
		t.Output += m.Usage.OutputTokens
		t.CacheRead += m.Usage.CacheReadInputTokens
		t.CacheWrite += m.Usage.CacheCreationInputTokens
	}
	// "<synthetic>" is Claude Code's stand-in model on assistant lines it
	// fabricates itself (interruption notices, hook echoes). It is not a
	// model anyone ran, and a session whose only real work was done by one
	// model should not list two.
	if m.Model != "" && m.Model != "<synthetic>" {
		p.state.Summary.noteModel(m.Model)
	}

	var blocks []claudeBlock
	if json.Unmarshal(m.Content, &blocks) != nil {
		return nil
	}
	var out []Message
	for _, blk := range blocks {
		msg := Message{Role: "assistant", Ts: ts, Model: m.Model, Sidechain: l.IsSidechain, Offset: off}
		switch blk.Type {
		case "thinking":
			// Claude Code redacts thinking on disk: measured across a real
			// store, every thinking block carried a signature and an empty
			// body. An empty disclosure row is worse than none, so a blank
			// block is dropped — the same rule Codex's encrypted reasoning
			// gets. A future version that writes the text back gets rendered
			// again without anyone touching this.
			if blk.Thinking == "" {
				continue
			}
			msg.Kind, msg.Text = "thinking", blk.Thinking
		case "text":
			msg.Kind, msg.Text = "text", blk.Text
		case "tool_use":
			msg.Kind, msg.ToolName = "tool_call", blk.Name
			msg.Text = compactJSON(blk.Input)
			p.state.Summary.ToolCallCount++
		default:
			continue
		}
		out = append(out, msg)
	}
	return out
}

// noteFirstPrompt records the first thing a human actually asked: plain text,
// role user, and not a sidechain — a subagent's opening prompt was written by
// the assistant, not the person. Capped on the way in, like every adapter's
// first prompt; see capPrompt.
func (p *claudeParser) noteFirstPrompt(msg Message) {
	if p.state.Summary.FirstPrompt == "" && msg.Role == "user" && msg.Kind == "text" && !msg.Sidechain {
		p.state.Summary.FirstPrompt = capPrompt(msg.Text)
	}
}

// flattenBlocks turns a tool_result body — a string, or an array of text
// blocks — into one string.
func flattenBlocks(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var blocks []claudeBlock
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

// compactJSON re-marshals raw without whitespace, or hands it back as-is when
// it will not parse — the text is for a human to read either way.
func compactJSON(raw json.RawMessage) string {
	var v any
	if json.Unmarshal(raw, &v) != nil {
		return string(raw)
	}
	b, err := json.Marshal(v)
	if err != nil {
		return string(raw)
	}
	return string(b)
}
