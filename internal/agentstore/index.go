package agentstore

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
	"unicode/utf8"
)

// sweepInterval rate-limits the background sweep: a verb arriving within this
// window of the last sweep is answered from the index as it stands. Ten
// seconds is far below how often anyone re-opens a transcript list and far
// above what a sweep of a busy store costs, and it means a client polling the
// list cannot make the daemon re-walk three directory trees per poll.
const sweepInterval = 10 * time.Second

// adapter binds one tool's on-disk layout to the shared index: where its
// store lives, which files in it are transcripts, and how its lines parse.
type adapter interface {
	tool() Tool
	// roots are the directories the tool keeps transcripts under, given home.
	roots(home string) []string
	// transcripts enumerates the transcript files under one root. Every walk
	// is depth-bounded to the layout the tool actually uses.
	transcripts(root string) []string
	// idFromPath is the identity the file's name carries, used until (or
	// unless) the content names the session itself.
	idFromPath(path string) string
	// parser returns a lineParser resuming from prev; the zero parseState
	// starts fresh.
	parser(path string, prev parseState) lineParser
	// resume is the command that picks the session back up, or nil when the
	// summary lacks what the command needs.
	resume(sum Summary, path string) *Resume
}

// subagentFiler is the optional face of an adapter whose store keeps some
// files as accounting for another: parentPath names the transcript a file
// augments, or "" for a file that is a session itself. Claude's subagents/
// files are today's only case. A file with a parent is indexed like any
// other — incremental parse, persisted entry — but never listed as a
// session: its tokens are folded into the parent's summary by Snapshot.
type subagentFiler interface {
	parentPath(path string) string
}

// lineParser consumes newline-terminated transcript lines, in file order,
// accumulating a summary and yielding the normalized messages each line holds.
type lineParser interface {
	// line consumes one line found at byte offset off. Bookkeeping, unknown
	// and malformed lines yield nil.
	line(b []byte, off int64) []Message
	// result is everything accumulated so far — the summary plus the state an
	// incremental parse resumes from.
	result() parseState
}

// parseState is what the index persists per file beyond the stat fields: the
// summary as accumulated, and the few per-tool scraps a parse resuming
// mid-file cannot recover from the bytes behind it. It is one struct rather
// than one per tool because the whole of it is three strings and a bool, and
// a type parameter would cost more than the empty fields do.
type parseState struct {
	Summary Summary `json:"summary"`
	// LastRequestID is Claude's usage dedupe: the requestId whose usage was
	// counted last, so the next line of the same response adds nothing.
	LastRequestID string `json:"lastRequestId,omitempty"`
	// NamedTitle is a title a human set outright (Claude custom-title, Pi
	// session_info), AiTitle one the tool generated (Claude ai-title). Kept
	// apart from Summary.Title so the precedence can be re-decided every time
	// either changes: named beats generated beats first prompt.
	NamedTitle string `json:"namedTitle,omitempty"`
	AiTitle    string `json:"aiTitle,omitempty"`
	// SawSession says Pi's opening session line has been read, so the session
	// lines a resume appends later cannot re-identify the file.
	SawSession bool `json:"sawSession,omitempty"`
}

// count folds a line's messages into the summary: the message count and the
// session's span. System-role messages are deliberately outside both — hook
// context and environment preambles are not the conversation, and a caveat
// injected seconds before the first prompt must not predate the session.
func (st *parseState) count(msgs []Message) {
	for _, m := range msgs {
		if m.Role == "system" {
			continue
		}
		st.Summary.MessageCount++
		if t, err := time.Parse(time.RFC3339Nano, m.Ts); err == nil {
			if st.Summary.StartedAt.IsZero() {
				st.Summary.StartedAt = t
			}
			st.Summary.EndedAt = t
		}
	}
}

// title is the precedence every adapter shares. The tools that lack a rung
// simply never fill it: Codex sets neither NamedTitle nor AiTitle, so its
// title is its first prompt, which is the contract's rule for it.
func (st *parseState) title() string {
	switch {
	case st.NamedTitle != "":
		return st.NamedTitle
	case st.AiTitle != "":
		return st.AiTitle
	default:
		return st.Summary.FirstPrompt
	}
}

// newSummary is a fresh summary with the slices non-nil, so an empty session
// marshals `"models": []` rather than null — the same promise the wire's list
// fields keep, made at construction because every summary reaches the wire.
func newSummary(tool Tool, id string) Summary {
	return Summary{ID: id, Tool: tool, Models: []string{}}
}

// capPrompt cuts a first prompt to firstPromptBytes, on a rune boundary so
// the cut never leaves half a code point behind. A clean cut and nothing more
// — no ellipsis, no marker — because the capped prompt is a label, and the
// page is where the whole message lives. It is one shared helper, applied by
// every adapter at the moment it stores a first prompt, so no adapter can
// drift into persisting an uncapped one; the title fallback inherits the cap
// by falling back to the value this already cut.
func capPrompt(s string) string {
	if len(s) <= firstPromptBytes {
		return s
	}
	cut := firstPromptBytes
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}

// noteModel records a model once, preserving first-seen order.
func (s *Summary) noteModel(model string) {
	for _, m := range s.Models {
		if m == model {
			return
		}
	}
	s.Models = append(s.Models, model)
}

// normTS normalizes a transcript timestamp to RFC 3339 UTC, or hands back
// the raw string when it will not parse — a timestamp this package cannot
// read may still mean something to a reader.
func normTS(raw string) string {
	if raw == "" {
		return ""
	}
	t, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil {
		return raw
	}
	return t.UTC().Format(time.RFC3339Nano)
}

// adapters is the fixed set, in the order sweeps visit them.
var adapters = []adapter{claudeAdapter{}, codexAdapter{}, piAdapter{}}

func adapterFor(tool Tool) (adapter, bool) {
	for _, ad := range adapters {
		if ad.tool() == tool {
			return ad, true
		}
	}
	return nil, false
}

// entry is one transcript as the index knows it. Size and Mtime are the stat
// the summary was computed against; Offset is where a parse of a grown file
// resumes — always the byte after the last newline-terminated line consumed,
// so a file caught mid-append re-reads only its unfinished tail.
type entry struct {
	Summary Summary    `json:"summary"`
	Size    int64      `json:"size"`
	MtimeNs int64      `json:"mtimeNs"`
	Offset  int64      `json:"offset"`
	State   parseState `json:"state"`
	// ParentPath marks a subagent file: the transcript whose summary absorbs
	// this file's tokens (subagentFiler). Empty for a session of its own.
	ParentPath string `json:"parentPath,omitempty"`
	// Missing says the file has vanished from disk — Claude Code prunes
	// transcripts after its cleanup period — and the entry is a tombstone:
	// the summary still counts, the transcript can no longer be opened. Set
	// by the sweep, cleared by refresh the moment the file is back.
	Missing bool `json:"missing,omitempty"`
}

// Index is the in-memory map of every transcript the sweep has met, keyed by
// path, persisted as one JSON file so a daemon restart does not re-parse a
// hundred sessions to answer its first list.
type Index struct {
	persistDir string
	home       string

	mu      sync.Mutex
	entries map[string]*entry
	// building is true while a sweep is in flight — the flag every answer
	// carries so a client knows the list it got may still be filling in.
	building bool
	sweeping bool
	lastAt   time.Time

	// The backfill cache, its own lock because History and Snapshot share no
	// state and a stats-cache parse must not queue a list behind it.
	histMu      sync.Mutex
	histSize    int64
	histMtimeNs int64
	hist        []HistoryDay
}

// indexFileName is the one file this package writes.
const indexFileName = "index.json"

// indexFormat stamps the persisted file with the parser generation that wrote
// it. A summary is a cache of running this package's parsers over a
// transcript, so a parser fix silently coexisting with summaries computed by
// its buggy predecessor would pin the bug for exactly the files that never
// change again — most of them. Bump this on any change to what the adapters
// extract and every old cache is discarded whole, which costs one background
// re-sweep and nothing else. Format 2 is the firstPromptBytes cap: summaries
// written by format 1 can hold megabyte first prompts, which is exactly the
// shape the cap exists to keep out of the index.
const indexFormat = 3

// New returns an index over home's stores, persisting under persistDir. The
// persisted file is loaded if it is there and readable; a corrupt or missing
// one costs a rebuild on the first sweep and nothing else — the transcripts
// are the truth and the file only a cache of reading them.
func New(persistDir, home string) *Index {
	x := &Index{
		persistDir: persistDir,
		home:       home,
		entries:    map[string]*entry{},
	}
	x.load()
	return x
}

func (x *Index) load() {
	b, err := os.ReadFile(filepath.Join(x.persistDir, indexFileName))
	if err != nil {
		return
	}
	var p struct {
		Format  int               `json:"format"`
		Entries map[string]*entry `json:"entries"`
	}
	if json.Unmarshal(b, &p) != nil || p.Format != indexFormat || p.Entries == nil {
		return
	}
	for path, e := range p.Entries {
		if e == nil || e.Summary.ID == "" {
			continue
		}
		x.entries[path] = e
	}
}

// persist writes the index the way writeSnapshot writes a session snapshot:
// fresh inode at 0600 in a 0700 directory, renamed into place, so a crash
// mid-write leaves the old index rather than half of a new one. Failures are
// swallowed — the index works from memory, and a cache that cannot be written
// is a slower start, not a broken feature.
func (x *Index) persist() {
	x.mu.Lock()
	p := struct {
		Format  int               `json:"format"`
		Entries map[string]*entry `json:"entries"`
	}{Format: indexFormat, Entries: make(map[string]*entry, len(x.entries))}
	for path, e := range x.entries {
		cp := *e
		p.Entries[path] = &cp
	}
	x.mu.Unlock()

	b, err := json.Marshal(p)
	if err != nil {
		return
	}
	if err := os.MkdirAll(x.persistDir, 0o700); err != nil {
		return
	}
	// MkdirAll leaves a pre-existing directory's mode alone; enforce it the
	// way config.Dir does, since summaries carry working directories and
	// first prompts.
	if err := os.Chmod(x.persistDir, 0o700); err != nil {
		return
	}
	tmp, err := os.CreateTemp(x.persistDir, indexFileName+"-*.tmp")
	if err != nil {
		return
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath) // no-op once the rename has succeeded
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return
	}
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return
	}
	if err := tmp.Close(); err != nil {
		return
	}
	_ = os.Rename(tmpPath, filepath.Join(x.persistDir, indexFileName))
}

// poke starts a sweep unless one is running or one finished within
// sweepInterval. Every verb calls it: the index refreshes because it is being
// looked at, and sits idle when nothing is.
func (x *Index) poke() {
	x.mu.Lock()
	if x.sweeping || (!x.lastAt.IsZero() && time.Since(x.lastAt) < sweepInterval) {
		x.mu.Unlock()
		return
	}
	x.sweeping = true
	x.building = true
	x.mu.Unlock()
	go x.sweep()
}

// sweep walks every adapter's roots and brings the index into line with the
// files: new files parsed, grown files parsed from their stored offset,
// shrunk or replaced files re-parsed whole, vanished files tombstoned. A
// tombstone rather than a drop, because the stores prune themselves — Claude
// Code deletes transcripts past its cleanup period — and a session's
// accounting should outlive the file the way the tool's own /usage counters
// do. The summary stays, marked Missing; only the transcript behind it is
// gone.
func (x *Index) sweep() {
	dirty := false
	seen := map[string]bool{}
	for _, ad := range adapters {
		for _, root := range ad.roots(x.home) {
			for _, path := range ad.transcripts(root) {
				seen[path] = true
				if x.refresh(ad, path) {
					dirty = true
				}
			}
		}
	}

	x.mu.Lock()
	for path, e := range x.entries {
		if !seen[path] && !e.Missing {
			e.Missing = true
			dirty = true
		}
	}
	x.building = false
	x.sweeping = false
	x.lastAt = time.Now()
	x.mu.Unlock()

	if dirty {
		x.persist()
	}
}

// refresh brings one file's entry up to date, reporting whether anything
// changed. The parse itself runs without the index lock: transcripts can be
// large, and a Snapshot must not queue behind one being read.
func (x *Index) refresh(ad adapter, path string) bool {
	fi, err := os.Stat(path)
	if err != nil || !fi.Mode().IsRegular() {
		return false
	}
	size, mtime := fi.Size(), fi.ModTime().UnixNano()

	x.mu.Lock()
	prev := x.entries[path]
	var from int64
	var state parseState
	switch {
	case prev == nil:
		// New file: parse whole.
	case size == prev.Size && mtime == prev.MtimeNs:
		// Unchanged — but a tombstoned file that is back on disk unchanged
		// (restored from a backup, say) is a change worth recording.
		if prev.Missing {
			prev.Missing = false
			x.mu.Unlock()
			return true
		}
		x.mu.Unlock()
		return false
	case size > prev.Size:
		// Grown: an append-only transcript got longer, which is the ordinary
		// case, and the stored offset plus the stored state is everything the
		// consumed prefix contributed.
		from, state = prev.Offset, prev.State
	default:
		// Shrunk, or rewritten at the same length: whatever the old parse
		// knew describes bytes that are gone. Start over.
	}
	x.mu.Unlock()

	st, off, ok := x.parseFrom(ad, path, from, state)
	if !ok {
		return false
	}
	sum := st.Summary
	sum.Title = st.title()
	sum.FileSize = size
	sum.Resume = ad.resume(sum, path)

	var parent string
	if sf, ok := ad.(subagentFiler); ok {
		parent = sf.parentPath(path)
	}

	x.mu.Lock()
	x.entries[path] = &entry{Summary: sum, Size: size, MtimeNs: mtime, Offset: off, State: st, ParentPath: parent}
	x.mu.Unlock()
	return true
}

// parseFrom runs a parser over path from byte offset from, returning the
// accumulated state and the offset after the last complete line consumed.
func (x *Index) parseFrom(ad adapter, path string, from int64, state parseState) (parseState, int64, bool) {
	f, err := os.Open(path)
	if err != nil {
		return parseState{}, 0, false
	}
	defer f.Close()
	if from > 0 {
		if _, err := f.Seek(from, io.SeekStart); err != nil {
			return parseState{}, 0, false
		}
	}
	p := ad.parser(path, state)
	lr := newLineReader(f, from)
	for {
		line, off, ok := lr.next()
		if !ok {
			break
		}
		if line == nil {
			continue // over-long line, skipped whole
		}
		p.line(line, off)
	}
	return p.result(), lr.off, true
}

// Snapshot answers the agents verb: the sessions the index holds right now —
// filtered, newest first — and whether a sweep is still running. It also
// pokes the sweep, so looking at the list is what keeps the list fresh.
// tools filters by tool name when non-empty; a name that matches no adapter
// matches no session, which is what a filter means. cwd filters by exact
// working directory.
func (x *Index) Snapshot(tools []string, cwd string) ([]Summary, bool) {
	x.poke()
	x.mu.Lock()
	defer x.mu.Unlock()
	// Subagent files first: their tokens land on the conversation that
	// spawned them, keyed by the parent's path. Tombstoned subagents fold
	// too — the accounting outlives the file, which is the tombstone's whole
	// point. Everything else the aggregate carries exists for the orphan
	// case below, where the fold's target is gone and the aggregate is all
	// that remains of the session.
	folded := map[string]*subagentAgg{}
	for _, e := range x.entries {
		if e.ParentPath == "" {
			continue
		}
		agg := folded[e.ParentPath]
		if agg == nil {
			agg = &subagentAgg{}
			folded[e.ParentPath] = agg
		}
		agg.fold(e.Summary)
	}
	out := []Summary{}
	for path, e := range x.entries {
		// A subagent file is accounting, not a session; it was folded above.
		if e.ParentPath != "" {
			continue
		}
		// A file with no conversation — hook echoes, a bare last-prompt
		// stub, a session someone opened and closed — is bookkeeping, not a
		// session. It stays in the index (so the sweep does not re-parse it
		// forever) but never reaches a list: it has nothing to show, and its
		// zero StartedAt would poison any date arithmetic a client does.
		// Tokens folded onto a stub are dropped with it — a session that
		// spawned subagents always has a conversation, so a stub with a
		// subagents directory is not a shape the stores produce.
		if e.Summary.MessageCount == 0 {
			continue
		}
		if !toolAllowed(e.Summary.Tool, tools) {
			continue
		}
		if cwd != "" && e.Summary.Cwd != cwd {
			continue
		}
		sum := e.Summary
		if agg, ok := folded[path]; ok {
			sum.Tokens.add(agg.tokens)
		}
		if e.Missing {
			// A tombstone still counts, but it cannot be opened or resumed,
			// and the flag is how a client knows to keep it out of the list
			// of openable transcripts while still charting it.
			sum.Missing = true
			sum.Resume = nil
		}
		out = append(out, sum)
	}
	// Orphaned subagents: the conversation file was pruned before this index
	// ever saw it — Claude Code's cleanup deletes the .jsonl and leaves the
	// session directory behind — so there is no entry to fold into and no
	// tombstone to keep counting. The subagent files still name the session
	// (their directory does), still carry its working directory, and still
	// hold the bulk of its tokens, so what remains is served as a synthesized
	// tombstone: countable, never openable, exactly the history the fold
	// exists to keep.
	for parent, agg := range folded {
		if _, ok := x.entries[parent]; ok {
			continue
		}
		if agg.msgs == 0 || !toolAllowed(agg.tool, tools) || (cwd != "" && agg.cwd != cwd) {
			continue
		}
		ad, ok := adapterFor(agg.tool)
		if !ok {
			continue
		}
		sum := newSummary(agg.tool, ad.idFromPath(parent))
		sum.Cwd = agg.cwd
		sum.StartedAt, sum.EndedAt = agg.started, agg.ended
		sum.Tokens = agg.tokens
		// The subagents' own counts, honestly short: the conversation's are
		// unrecoverable, and "at least this much" beats zero.
		sum.MessageCount, sum.ToolCallCount = agg.msgs, agg.calls
		sum.Missing = true
		out = append(out, sum)
	}
	sortNewestFirst(out)
	return out, x.building
}

// subagentAgg is what a session's subagent files add up to, and — when the
// session's own file was pruned before it was ever indexed — everything the
// store still knows about the session at all.
type subagentAgg struct {
	tool           Tool
	cwd            string
	started, ended time.Time
	tokens         TokenUsage
	msgs, calls    int
}

func (a *subagentAgg) fold(s Summary) {
	a.tool = s.Tool
	if a.cwd == "" {
		a.cwd = s.Cwd
	}
	if !s.StartedAt.IsZero() && (a.started.IsZero() || s.StartedAt.Before(a.started)) {
		a.started = s.StartedAt
	}
	if s.EndedAt.After(a.ended) {
		a.ended = s.EndedAt
	}
	a.tokens.add(s.Tokens)
	a.msgs += s.MessageCount
	a.calls += s.ToolCallCount
}

// Resolve is the only way a (tool, id) becomes a path: reads and searches go
// through it, so a path never has to cross the wire to name a transcript.
func (x *Index) Resolve(tool Tool, id string) (string, Summary, bool) {
	x.mu.Lock()
	defer x.mu.Unlock()
	for path, e := range x.entries {
		if e.Summary.Tool == tool && e.Summary.ID == id {
			return path, e.Summary, true
		}
	}
	return "", Summary{}, false
}

func toolAllowed(tool Tool, filter []string) bool {
	if len(filter) == 0 {
		return true
	}
	for _, f := range filter {
		if Tool(f) == tool {
			return true
		}
	}
	return false
}

// ToolAllowed is toolAllowed for the daemon, which applies the agents verb's
// tool filter to History the way Snapshot applies it to sessions.
func ToolAllowed(tool Tool, filter []string) bool { return toolAllowed(tool, filter) }

// sortNewestFirst orders summaries by when they last spoke, ties broken by
// id so the order is stable across sweeps.
func sortNewestFirst(sums []Summary) {
	sort.Slice(sums, func(i, j int) bool {
		a, b := sums[i], sums[j]
		if !a.EndedAt.Equal(b.EndedAt) {
			return a.EndedAt.After(b.EndedAt)
		}
		return a.ID < b.ID
	})
}

// lineReader hands out newline-terminated lines with the byte offset each
// started at.
//
// Three answers per call: a line (ok, line non-nil), an over-long line
// consumed but withheld (ok, line nil), or no complete line left (not ok).
// A trailing fragment with no newline is the third — deliberately never
// consumed, because these files are written by live processes and a fragment
// is usually half of a line still being appended; the offset stays at its
// start so the next parse reads it whole.
type lineReader struct {
	r   *bufio.Reader
	off int64
}

func newLineReader(r io.Reader, off int64) *lineReader {
	return &lineReader{r: bufio.NewReaderSize(r, 64<<10), off: off}
}

func (lr *lineReader) next() (line []byte, off int64, ok bool) {
	start := lr.off
	var buf []byte
	overflow := false
	for {
		chunk, err := lr.r.ReadSlice('\n')
		lr.off += int64(len(chunk))
		if !overflow && len(chunk) > 0 {
			buf = append(buf, chunk...)
			if len(buf) > maxLineBytes {
				// Past the bound the line is skipped, but it still has to be
				// consumed to find the next one; the buffer is dropped so the
				// skip costs no memory.
				overflow, buf = true, nil
			}
		}
		switch err {
		case nil:
			if overflow {
				return nil, start, true
			}
			return buf[:len(buf)-1], start, true
		case bufio.ErrBufferFull:
			continue
		default:
			// EOF, or a read error indistinguishable from one for our
			// purposes: the bytes since start are an unfinished line. Rewind
			// the offset so nothing believes they were consumed.
			lr.off = start
			return nil, start, false
		}
	}
}
