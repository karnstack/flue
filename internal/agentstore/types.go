// Package agentstore reads the conversation transcripts that coding agents —
// Claude Code, Codex, Pi — keep under the user's home directory, and serves
// them back as one normalized shape: a summary per session, pages of messages,
// and search hits.
//
// The trust model is read-only, and read-only over stores this package does
// not own. Every file here belongs to another program, is written in a format
// that program has never promised to keep, and may be mid-append at the moment
// it is read. So nothing in this package writes into a store, nothing treats a
// line it cannot parse as an error, and nothing treats the end of a file as
// the end of a session: an unknown line type is a future version of the tool,
// a malformed line is a crash mid-write, and both are skipped rather than
// failed on, because failing would make this viewer's availability depend on
// the stability of three formats nobody versioned. A file that cannot be read
// at all simply is not listed.
//
// The one thing this package does write is its own index, a cache of the
// summaries it has computed, kept under the flue config directory. Summaries
// name working directories, first prompts and session titles — the same order
// of sensitivity as the scrollback in a session snapshot — so the index
// inherits the config directory's discipline: 0700 directory, 0600 file,
// written to a fresh inode and renamed into place. A corrupt or missing index
// is rebuilt from the transcripts, never fatal; the transcripts are the truth
// and the index only ever a summary of them.
package agentstore

import (
	"errors"
	"time"
)

// Tool names one of the transcript stores this package reads. The values are
// wire strings — a client sends them in agentRead and reads them off every
// summary — so they are spelled the way the wire spells them.
type Tool string

const (
	ToolClaude Tool = "claude"
	ToolCodex  Tool = "codex"
	ToolPi     Tool = "pi"
)

// Errors the callers translate onto the wire. Two rather than several, because
// the client has two moves: a name outside the protocol is the client's bug
// (bad_message), and a session that is not there is the ordinary answer for a
// store another program prunes (not_found).
var (
	// ErrUnknownTool is a tool name outside the three this package reads.
	ErrUnknownTool = errors.New("agentstore: unknown tool")
	// ErrNotFound is a (tool, id) the index does not hold, or one whose file
	// vanished between the index sweep and the read.
	ErrNotFound = errors.New("agentstore: no such session")
	// ErrBadQuery is a search with nothing to search for.
	ErrBadQuery = errors.New("agentstore: empty query")
)

// TokenUsage is one session's token consumption, in the four buckets every
// tool's accounting maps onto. The mapping is per-adapter — Claude sums lines
// deduped by requestId, Codex reports a cumulative total this copies, Pi sums
// per-message — and this struct is where the three spellings converge.
type TokenUsage struct {
	Input      int64 `json:"input"`
	Output     int64 `json:"output"`
	CacheRead  int64 `json:"cacheRead"`
	CacheWrite int64 `json:"cacheWrite"`
}

// add folds another accounting into this one, bucket by bucket — how a
// subagent file's tokens land on the conversation that spawned it.
func (t *TokenUsage) add(u TokenUsage) {
	t.Input += u.Input
	t.Output += u.Output
	t.CacheRead += u.CacheRead
	t.CacheWrite += u.CacheWrite
}

// Resume is the command that picks a session back up, with the directory to
// run it in. It is a hint printed for a human, never something this package
// executes; a session whose working directory is unknown carries no Resume at
// all, because a resume command run in the wrong directory is worse than none.
type Resume struct {
	Cmd []string `json:"cmd"`
	Cwd string   `json:"cwd"`
}

// Summary is one session as the list shows it: identity, where it ran, what
// it was about, and what it cost. Everything here is computed from the
// transcript alone.
type Summary struct {
	ID   string `json:"id"`
	Tool Tool   `json:"tool"`
	Cwd  string `json:"cwd"`
	// Title is the best name the transcript offers, by each tool's own
	// precedence — a human-set title beats a generated one beats the first
	// prompt. FirstPrompt is kept beside it rather than folded in, so a client
	// can show both the name and the opening ask.
	Title       string `json:"title,omitempty"`
	FirstPrompt string `json:"firstPrompt,omitempty"`
	// StartedAt and EndedAt are the first and last message timestamps —
	// messages, not bookkeeping lines, so a title rewritten hours later does
	// not stretch the session.
	StartedAt     time.Time  `json:"startedAt"`
	EndedAt       time.Time  `json:"endedAt"`
	MessageCount  int        `json:"messageCount"`
	ToolCallCount int        `json:"toolCallCount"`
	Models        []string   `json:"models"`
	Tokens        TokenUsage `json:"tokens"`
	// CostUsd is present only when the transcript itself records dollar cost,
	// which today is Pi alone. Absent is "not recorded", not "free": this
	// package reports what the store says and estimates nothing.
	CostUsd  float64 `json:"costUsd,omitempty"`
	FileSize int64   `json:"fileSize"`
	Resume   *Resume `json:"resume,omitempty"`
	// Missing says the transcript file has been pruned by its own tool —
	// Claude Code deletes transcripts past its cleanup period — and this
	// summary is a tombstone: it still counts in every aggregate, but there
	// is no file left to page or resume, so a client keeps it out of the
	// list of openable transcripts.
	Missing bool `json:"missing,omitempty"`
}

// Message is one normalized entry of a transcript page.
//
// Offset is the byte offset of the line the message came from, and it is the
// stable anchor: a client keys on it, and hands it back as agentRead.offset to
// page from here. One line can normalize to several messages — an assistant
// line holding a thinking block and a tool call — and they all carry the
// line's offset, so the anchor names the line, not the message.
type Message struct {
	// Role is "user", "assistant" or "system". System is where each adapter
	// puts the lines a harness injected — hook context, command echoes,
	// environment preambles — so a viewer can fold them away and the message
	// count does not inflate with text no human wrote.
	Role string `json:"role"`
	// Kind is "text", "thinking", "tool_call" or "tool_result".
	Kind string `json:"kind"`
	// Ts is RFC 3339, or absent when the line carries no timestamp.
	Ts    string `json:"ts,omitempty"`
	Model string `json:"model,omitempty"`
	// Text is the message body: prose for text and thinking, the input JSON
	// for a tool_call, the result body for a tool_result.
	Text string `json:"text"`
	// ToolName is set on tool_call always, and on tool_result when the
	// transcript names the tool there — Claude and Pi only record the call id
	// on results, so those arrive without one.
	ToolName string `json:"toolName,omitempty"`
	// Sidechain marks a subagent's message, which Claude keeps in the same
	// file as the conversation that spawned it.
	Sidechain bool `json:"sidechain,omitempty"`
	// Truncated says Text was cut to the per-block cap on its way into a
	// page. The transcript still holds the whole thing.
	Truncated bool  `json:"truncated,omitempty"`
	Offset    int64 `json:"offset"`
}

// Hit is one search match: enough of the session to label the result, and
// enough of the message to open it — Offset pages straight to the line.
type Hit struct {
	Tool  Tool   `json:"tool"`
	ID    string `json:"id"`
	Cwd   string `json:"cwd"`
	Title string `json:"title,omitempty"`
	Ts    string `json:"ts,omitempty"`
	Role  string `json:"role"`
	// Snippet is the match with ~80 characters of context each side, folded
	// onto one line, no markup.
	Snippet string `json:"snippet"`
	Offset  int64  `json:"offset"`
}

// Page is one agentRead answer: a window of messages and where the window
// sits in the file. Eof says the parse reached the end of the file as it was
// at read time — not that the session is over, since the file may still be
// growing; the same doctrine as the read verb's eof.
type Page struct {
	Messages []Message
	// Start is the offset of the first returned message's line; Next is the
	// offset parsing would continue from. Forward pages advance with Next,
	// backward pages load earlier with Start.
	Start    int64
	Next     int64
	Eof      bool
	FileSize int64
}

// Limits. Tunable, but each exists to bound what one request can cost: a
// window request reads at most readBudget bytes, a search reads at most
// searchByteBudget across every file it visits, and no single line — these
// files hold pasted images as base64 — is allowed to hold a whole request's
// memory hostage.
const (
	// readBudget bounds one page window's bytes.
	readBudget = 2 << 20
	// readDefaultMessages and readMaxMessages bound one page's messages: the
	// default when the client names no limit, and the clamp when it names too
	// many.
	readDefaultMessages = 100
	readMaxMessages     = 200
	// searchDefaultHits and searchMaxHits do the same for search.
	searchDefaultHits = 50
	searchMaxHits     = 100
	// searchByteBudget bounds one search's total file reading, spent newest
	// session first so the results that go missing are the oldest.
	searchByteBudget = 64 << 20
	// blockTruncBytes caps one message's text on a page. A tool result can be
	// megabytes; a page of them would blow the read budget on one message.
	blockTruncBytes = 16 << 10
	// firstPromptBytes caps the first prompt a summary stores. A first user
	// message can be a whole pasted file — a single line runs to the
	// maxLineBytes cap below — and a summary rides the persisted index, the
	// in-memory map and every agentIndex reply, none of which is a place for
	// megabytes of prompt. 4 KiB is more opening ask than any list shows; the
	// transcript still holds the whole thing, one agentRead away.
	firstPromptBytes = 4096
	// maxLineBytes is the longest transcript line the parsers will hold in
	// memory. A longer line is skipped — that line, not the file.
	maxLineBytes = 10 << 20
)

// knownTool says whether the wire string names an adapter.
func knownTool(tool Tool) bool {
	switch tool {
	case ToolClaude, ToolCodex, ToolPi:
		return true
	}
	return false
}
