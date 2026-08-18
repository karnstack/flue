package agentstore

import (
	"context"
	"os"
	"strings"
	"unicode/utf8"
)

// Searching transcripts.
//
// A search is a case-insensitive substring scan over the normalized message
// text — the same text a page shows, so what search finds a viewer can be
// paged to. It walks sessions newest first, because "that conversation about
// the nginx config" is nearly always recent, and it spends one bounded byte
// budget across every file it visits, so the sessions a busy store costs are
// the oldest — the honest place to be incomplete, and the truncated flag says
// when it was.

// Search answers one agentSearch. tools and cwd filter the way the agents
// verb filters; limit is clamped, zero meaning the default. building reports
// whether a sweep is still running — a client that wants the stragglers
// re-asks, the way it re-asks the list. An empty query is ErrBadQuery, the
// caller's bug: matching everything is an answer nobody is asking for.
//
// ctx is the caller's interest in the answer, checked between files and on
// every line: the budget is sixty-four megabytes, and a connection that
// closes mid-scan should stop costing this machine file reads the moment
// nobody is left to read the answer. A cancellation caught between files is
// ctx.Err(); one caught mid-file surfaces as an ordinary truncated result,
// which is fine — the one caller that cancels has already stopped listening.
func (x *Index) Search(ctx context.Context, query string, tools []string, cwd string, limit int) (hits []Hit, building, truncated bool, err error) {
	if strings.TrimSpace(query) == "" {
		return nil, false, false, ErrBadQuery
	}
	switch {
	case limit <= 0:
		limit = searchDefaultHits
	case limit > searchMaxHits:
		limit = searchMaxHits
	}
	needle := strings.ToLower(query)

	// Snapshot pokes the sweep, so a search is as freshening as a list.
	sessions, building := x.Snapshot(tools, cwd)
	hits = []Hit{}
	budget := int64(searchByteBudget)
	for _, sum := range sessions {
		if ctx.Err() != nil {
			return nil, false, false, ctx.Err()
		}
		if len(hits) >= limit || budget <= 0 {
			// Sessions remain and the cap or the budget is spent: whichever
			// it was, the client is told the answer is a prefix.
			truncated = true
			break
		}
		path, _, ok := x.Resolve(sum.Tool, sum.ID)
		if !ok {
			continue
		}
		scanned, whole := searchFile(ctx, path, sum, needle, &hits, limit, budget)
		budget -= scanned
		if !whole {
			truncated = true
			break
		}
	}
	return hits, building, truncated, nil
}

// searchFile scans one transcript, appending hits. It reports the bytes it
// consumed and whether it scanned everything there was — false means it
// stopped with input still unscanned: the byte budget ran out, the caller's
// context ended, or the hit cap landed with messages or lines still unread.
// The cap alone is not enough, because a cap reached on the very last message
// of a file's last line is a complete answer, and calling it truncated would
// tell the client a prefix was all it got when it got the whole thing.
func searchFile(ctx context.Context, path string, sum Summary, needle string, hits *[]Hit, limit int, budget int64) (scanned int64, whole bool) {
	ad, ok := adapterFor(sum.Tool)
	if !ok {
		return 0, true
	}
	f, err := os.Open(path)
	if err != nil {
		return 0, true
	}
	defer f.Close()

	p := ad.parser(path, parseState{})
	lr := newLineReader(f, 0)
	for {
		if ctx.Err() != nil || lr.off >= budget {
			return lr.off, false
		}
		line, off, ok := lr.next()
		if !ok {
			return lr.off, true
		}
		if line == nil {
			continue
		}
		msgs := p.line(line, off)
		for i, m := range msgs {
			idx := strings.Index(strings.ToLower(m.Text), needle)
			if idx < 0 {
				continue
			}
			*hits = append(*hits, Hit{
				Tool: sum.Tool, ID: sum.ID, Cwd: sum.Cwd, Title: sum.Title,
				Ts: m.Ts, Role: m.Role,
				Snippet: snippet(m.Text, idx, len(needle)),
				Offset:  m.Offset,
			})
			if len(*hits) >= limit {
				if i < len(msgs)-1 {
					return lr.off, false
				}
				// The cap fell on the line's last message: whether the answer
				// is complete now hangs on whether another line exists, so
				// look. An over-long line the reader would skip still counts
				// as input — it was never scanned — and a trailing fragment
				// does not, by the same doctrine as everywhere else: it is
				// not a line yet.
				_, _, more := lr.next()
				return lr.off, !more
			}
		}
	}
}

// snippetContext is how much text rides each side of a match.
const snippetContext = 80

// snippet is the match with its surroundings, folded onto one line. The
// window is cut on rune boundaries and its whitespace collapsed, so a match
// inside a JSON blob or a stack trace reads as a phrase rather than a wall.
// idx came from a lowercased copy of text; for the handful of runes whose
// case forms differ in length the window can sit a byte or two off, which a
// context this wide absorbs.
func snippet(text string, idx, matchLen int) string {
	lo := idx - snippetContext
	if lo < 0 {
		lo = 0
	}
	hi := idx + matchLen + snippetContext
	if hi > len(text) {
		hi = len(text)
	}
	for lo > 0 && lo < len(text) && !utf8.RuneStart(text[lo]) {
		lo--
	}
	for hi < len(text) && !utf8.RuneStart(text[hi]) {
		hi++
	}
	return strings.Join(strings.Fields(text[lo:hi]), " ")
}
