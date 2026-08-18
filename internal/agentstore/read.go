package agentstore

import (
	"bytes"
	"io"
	"os"
	"unicode/utf8"
)

// Reading a page of a transcript.
//
// A page is a bounded window, never the file: transcripts run to tens of
// megabytes and the answer rides the same socket as the terminal. Forward
// parses from an offset until the message limit or the byte budget; backward
// parses the window of whole lines ending at the offset — a budget's worth,
// widened only when a single line outgrows it (see backwardWindow) — and
// keeps the last messages, which is what "load earlier" and "jump to the end"
// both are. In both directions the offsets a page reports are line offsets
// the client can hand straight back, so paging needs no cursor state on the
// daemon.
//
// Eof is "the parse reached the end of the file as it was", never "the
// session is over" — the same doctrine as the read verb's eof, and for the
// same reason: these files are appended to by live processes, and the only
// honest claim is about the bytes that were there. A trailing line with no
// newline yet is left unconsumed on the same grounds; the next page picks it
// up whole once the writer finishes it.

// ReadPage answers one agentRead. dir is "forward" or "backward" (the
// caller's to validate, forward being the default); limit is clamped to the
// package bounds, with zero meaning the default. A tool outside the protocol
// is ErrUnknownTool — the caller's bug — and an id the index does not hold,
// or one whose file has vanished since the sweep, is ErrNotFound — the
// ordinary kind of miss over a store another program prunes.
func (x *Index) ReadPage(tool Tool, id string, offset int64, dir string, limit int) (Page, error) {
	if !knownTool(tool) {
		return Page{}, ErrUnknownTool
	}
	x.poke()
	path, _, ok := x.Resolve(tool, id)
	if !ok {
		return Page{}, ErrNotFound
	}
	ad, _ := adapterFor(tool)

	f, err := os.Open(path)
	if err != nil {
		return Page{}, ErrNotFound
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return Page{}, ErrNotFound
	}
	size := fi.Size()

	switch {
	case limit <= 0:
		limit = readDefaultMessages
	case limit > readMaxMessages:
		limit = readMaxMessages
	}
	if offset < 0 {
		offset = 0
	}
	if offset > size {
		// Clamped rather than refused: offset=fileSize is the documented
		// jump-to-end, and a client holding a size the file has since shrunk
		// under wants the end that exists.
		offset = size
	}

	if dir == "backward" {
		return readBackward(ad, path, f, offset, limit, size)
	}
	return readForward(ad, path, f, offset, limit, size)
}

// readForward parses from offset until limit messages, the byte budget, or
// the end of the file. An offset that lands mid-line skips to the next
// newline rather than parsing the tail of a line as a line.
func readForward(ad adapter, path string, f *os.File, offset int64, limit int, size int64) (Page, error) {
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return Page{}, ErrNotFound
	}
	lr := newLineReader(f, offset)
	if !alignedAt(f, offset) {
		// The bytes up to the next newline belong to a line whose start is
		// behind the offset; consuming them as a discard is what aligns.
		if _, _, ok := lr.next(); !ok {
			return Page{Start: offset, Next: offset, Eof: true, FileSize: size}, nil
		}
	}
	parseStart := lr.off

	p := ad.parser(path, parseState{})
	msgs := []Message{}
	start, sawEnd := parseStart, false
	for {
		if len(msgs) >= limit || lr.off-parseStart >= readBudget {
			break
		}
		line, off, ok := lr.next()
		if !ok {
			sawEnd = true
			break
		}
		if line == nil {
			continue // over-long line, skipped
		}
		// One line's messages are taken whole, so a page can run a few
		// messages past limit. Deliberate: the line is the atomic unit of
		// offset paging, and splitting one would make Next land inside it —
		// an offset no later request could parse from.
		for _, m := range p.line(line, off) {
			if len(msgs) == 0 {
				start = m.Offset
			}
			msgs = append(msgs, capBlock(m))
		}
	}
	return Page{Messages: msgs, Start: start, Next: lr.off, Eof: sawEnd, FileSize: size}, nil
}

// readBackward parses the window that ends at offset and keeps the last
// limit messages, kept in whole-line groups so Start always names a line the
// page returned every message of — the next "load earlier" excludes that
// line and loses nothing.
func readBackward(ad adapter, path string, f *os.File, offset int64, limit int, size int64) (Page, error) {
	buf, aligned, err := backwardWindow(f, offset)
	if err != nil {
		return Page{}, ErrNotFound
	}

	type group struct {
		off  int64
		msgs []Message
	}
	var groups []group
	p := ad.parser(path, parseState{})
	lr := newLineReader(bytes.NewReader(buf), aligned)
	for {
		line, off, ok := lr.next()
		if !ok {
			break
		}
		if line == nil {
			continue
		}
		if msgs := p.line(line, off); len(msgs) > 0 {
			groups = append(groups, group{off: off, msgs: msgs})
		}
	}

	// Keep the last limit messages, rounded outward to line groups: walk
	// backward over groups while they still fit, and always take at least the
	// final group so a single line richer than the limit still pages.
	first, total := len(groups), 0
	for first > 0 && total+len(groups[first-1].msgs) <= limit {
		total += len(groups[first-1].msgs)
		first--
	}
	if first == len(groups) && len(groups) > 0 {
		first--
	}

	msgs := []Message{}
	start := aligned
	for _, g := range groups[first:] {
		if len(msgs) == 0 {
			start = g.off
		}
		for _, m := range g.msgs {
			msgs = append(msgs, capBlock(m))
		}
	}
	return Page{Messages: msgs, Start: start, Next: offset, Eof: offset >= size, FileSize: size}, nil
}

// backwardWindow reads the window a backward page parses: its bytes, and the
// file offset of its first byte, sitting at a line start whenever one could
// be found.
//
// The plain case is one readBudget ending at offset, cut down to its first
// newline — the bytes before that newline are the tail of a line that started
// earlier, and the bytes after it are whole lines. But a single line can
// outgrow the budget (these files hold pasted images as base64), and a window
// that lands entirely inside one line holds no line start at all. Returning
// the empty page from there would wedge a client paging up: every retry from
// the same offset meets the same lineless window, so a transcript with one
// line past the budget in it would have everything before that line
// unreachable backward while forward reads walk it fine. So the window widens
// backward, a budget per step, until a newline turns up or the window reaches
// maxLineBytes plus the budget — the widest window a parseable line can need,
// since a line longer than maxLineBytes is one the parser skips in either
// direction. Whatever happens, the returned window starts strictly before any
// offset > 0, which is the progress guarantee paging up rests on.
func backwardWindow(f *os.File, offset int64) (buf []byte, aligned int64, err error) {
	winStart := offset - readBudget
	if winStart < 0 {
		winStart = 0
	}
	buf = make([]byte, offset-winStart)
	if _, err := io.ReadFull(io.NewSectionReader(f, winStart, int64(len(buf))), buf); err != nil {
		return nil, 0, err
	}
	if winStart == 0 {
		return buf, 0, nil
	}
	// A newline in the window's final byte closes a line that began before
	// the window, so it aligns nothing by itself; only a newline with bytes
	// after it puts a line start inside the window.
	if nl := bytes.IndexByte(buf, '\n'); nl >= 0 && nl < len(buf)-1 {
		return buf[nl+1:], winStart + int64(nl) + 1, nil
	}
	for winStart > 0 && offset-winStart < maxLineBytes+readBudget {
		newStart := winStart - readBudget
		if newStart < 0 {
			newStart = 0
		}
		if offset-newStart > maxLineBytes+readBudget {
			newStart = offset - (maxLineBytes + readBudget)
		}
		ext := make([]byte, winStart-newStart)
		if _, err := io.ReadFull(io.NewSectionReader(f, newStart, int64(len(ext))), ext); err != nil {
			return nil, 0, err
		}
		// The last newline in the extension is the nearest line start behind
		// the old window — the tightest alignment that still puts a whole
		// line in front of the parser. Everything already read had none.
		nl := bytes.LastIndexByte(ext, '\n')
		buf = append(ext, buf...)
		winStart = newStart
		if nl >= 0 {
			return buf[nl+1:], winStart + int64(nl) + 1, nil
		}
	}
	if winStart == 0 {
		return buf, 0, nil
	}
	// No line start within the bound: offset sits inside — or at the very end
	// of — a line longer than maxLineBytes, which the parser would skip even
	// if its start were in hand. An empty window whose Start is a whole bound
	// earlier pages the client through the line — the same skip forward
	// parsing performs, spelt as offsets — and ordinary paging resumes once
	// Start lands within reach of the line's beginning.
	return nil, winStart, nil
}

// alignedAt says whether offset sits at a line start: the file's own start,
// or a byte whose predecessor is a newline.
func alignedAt(f *os.File, offset int64) bool {
	if offset == 0 {
		return true
	}
	var b [1]byte
	if _, err := f.ReadAt(b[:], offset-1); err != nil {
		return false
	}
	return b[0] == '\n'
}

// capBlock cuts one message's text to the per-block cap, on a rune boundary,
// and says so. Pages only: search matches against the whole text.
func capBlock(m Message) Message {
	if len(m.Text) <= blockTruncBytes {
		return m
	}
	cut := blockTruncBytes
	for cut > 0 && !utf8.RuneStart(m.Text[cut]) {
		cut--
	}
	m.Text, m.Truncated = m.Text[:cut], true
	return m
}
