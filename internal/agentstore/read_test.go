package agentstore

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// claudeFixtureMessages is the fixture's normalized shape, in file order:
// what every paging test below slices windows out of.
var claudeFixtureMessages = []struct{ role, kind string }{
	{"system", "text"}, // the caveat
	{"system", "text"}, // the /clear echo
	{"user", "text"},   // the prompt
	{"assistant", "thinking"},
	{"assistant", "text"},
	{"assistant", "tool_call"},
	{"user", "tool_result"},
	{"assistant", "text"},
}

func readPage(t *testing.T, x *Index, offset int64, dir string, limit int) Page {
	t.Helper()
	page, err := x.ReadPage(ToolClaude, claudeFixtureID, offset, dir, limit)
	if err != nil {
		t.Fatalf("ReadPage(%d, %s, %d): %v", offset, dir, limit, err)
	}
	return page
}

func wantShapes(t *testing.T, msgs []Message, from, to int) {
	t.Helper()
	want := claudeFixtureMessages[from:to]
	if len(msgs) != len(want) {
		t.Fatalf("page has %d messages, want %d", len(msgs), len(want))
	}
	for i, m := range msgs {
		if m.Role != want[i].role || m.Kind != want[i].kind {
			t.Errorf("message %d = (%s, %s), want (%s, %s)", i, m.Role, m.Kind, want[i].role, want[i].kind)
		}
	}
}

func TestReadPagesForwardInOrder(t *testing.T) {
	x, _, _ := newSweptIndex(t)

	page := readPage(t, x, 0, "forward", 3)
	wantShapes(t, page.Messages, 0, 3)
	if page.Eof {
		t.Error("Eof = true with five messages still unread")
	}
	if page.Start != page.Messages[0].Offset {
		t.Errorf("Start = %d, want the first message's line offset %d", page.Start, page.Messages[0].Offset)
	}

	// The next page starts exactly where the last one said.
	page2 := readPage(t, x, page.Next, "forward", 3)
	wantShapes(t, page2.Messages, 3, 6)

	// And the final page reaches the end of the file — through the ai-title,
	// snapshot and unknown lines behind the last message, which consume
	// offset without producing anything.
	page3 := readPage(t, x, page2.Next, "forward", 100)
	wantShapes(t, page3.Messages, 6, 8)
	if !page3.Eof {
		t.Error("Eof = false on the page that consumed the file")
	}
	if page3.Next != page3.FileSize {
		t.Errorf("Next = %d, want FileSize %d", page3.Next, page3.FileSize)
	}
}

func TestReadForwardAlignsAMidLineOffset(t *testing.T) {
	x, _, _ := newSweptIndex(t)
	whole := readPage(t, x, 0, "forward", 100)

	// Offset 3 is inside the first line, a bookkeeping line that yields no
	// message anyway: skipping to the next newline must lose nothing.
	aligned := readPage(t, x, 3, "forward", 100)
	if len(aligned.Messages) != len(whole.Messages) {
		t.Fatalf("mid-line offset read %d messages, aligned read %d", len(aligned.Messages), len(whole.Messages))
	}
	if !aligned.Eof || aligned.Next != whole.Next {
		t.Errorf("aligned page = next %d eof %v, want next %d eof true", aligned.Next, aligned.Eof, whole.Next)
	}
}

func TestReadPagesBackwardFromTheEnd(t *testing.T) {
	x, _, _ := newSweptIndex(t)

	// Jump to the end: offset = fileSize, the documented spelling.
	full := readPage(t, x, 0, "forward", 100)
	last := readPage(t, x, full.FileSize, "backward", 3)
	wantShapes(t, last.Messages, 5, 8)
	if !last.Eof {
		t.Error("Eof = false on a window that ends at the file's end")
	}
	if last.Next != full.FileSize {
		t.Errorf("Next = %d, want the requested offset %d", last.Next, full.FileSize)
	}
	if last.Start != last.Messages[0].Offset {
		t.Errorf("Start = %d, want the first returned message's offset %d", last.Start, last.Messages[0].Offset)
	}

	// Load earlier: the previous Start is the next request's end, and the
	// pages tile with no gap and no overlap.
	earlier := readPage(t, x, last.Start, "backward", 3)
	wantShapes(t, earlier.Messages, 2, 5)
	if earlier.Eof {
		t.Error("Eof = true on a window that ends mid-file")
	}
	first := readPage(t, x, earlier.Start, "backward", 10)
	wantShapes(t, first.Messages, 0, 2)
	if first.Start != full.Messages[0].Offset {
		t.Errorf("the earliest page starts at %d, want the first message's offset %d", first.Start, full.Messages[0].Offset)
	}
}

func TestReadClampsLimitAndOffset(t *testing.T) {
	x, _, _ := newSweptIndex(t)
	// An offset beyond the file is the end of the file, not an error: the
	// client's fileSize can be stale under a store another program prunes.
	page := readPage(t, x, 1<<40, "backward", 2)
	wantShapes(t, page.Messages, 6, 8)

	// A zero limit is the default, not an empty page.
	page = readPage(t, x, 0, "forward", 0)
	if len(page.Messages) != len(claudeFixtureMessages) {
		t.Fatalf("limit 0 read %d messages, want all %d", len(page.Messages), len(claudeFixtureMessages))
	}
}

func TestReadTruncatesOversizedBlocks(t *testing.T) {
	home := t.TempDir()
	big := strings.Repeat("a", blockTruncBytes+512)
	content := fmt.Sprintf(`{"type":"user","message":{"role":"user","content":"%s"},"timestamp":"2026-08-10T09:00:00.000Z","cwd":"/p"}`+"\n", big)
	write(t, filepath.Join(home, ".claude", "projects", "-p", "aaaa.jsonl"), []byte(content))
	x := New(t.TempDir(), home)
	x.sweep()

	page, err := x.ReadPage(ToolClaude, "aaaa", 0, "forward", 10)
	if err != nil {
		t.Fatalf("ReadPage: %v", err)
	}
	if len(page.Messages) != 1 {
		t.Fatalf("page has %d messages, want 1", len(page.Messages))
	}
	m := page.Messages[0]
	if !m.Truncated {
		t.Error("Truncated = false on a block past the cap")
	}
	if len(m.Text) > blockTruncBytes {
		t.Errorf("Text is %d bytes, over the %d cap", len(m.Text), blockTruncBytes)
	}
}

func TestReadRefusesWhatItShould(t *testing.T) {
	x, _, paths := newSweptIndex(t)

	if _, err := x.ReadPage("cursor", "whatever", 0, "forward", 10); err != ErrUnknownTool {
		t.Errorf("unknown tool err = %v, want ErrUnknownTool", err)
	}
	if _, err := x.ReadPage(ToolClaude, "never-existed", 0, "forward", 10); err != ErrNotFound {
		t.Errorf("unknown id err = %v, want ErrNotFound", err)
	}

	// Indexed, then vanished before the read: the same not_found, because a
	// pruned store is ordinary, not exceptional.
	if err := os.Remove(paths[ToolClaude]); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if _, err := x.ReadPage(ToolClaude, claudeFixtureID, 0, "forward", 10); err != ErrNotFound {
		t.Errorf("vanished file err = %v, want ErrNotFound", err)
	}
}

// claudeUserLine is one plain user line, the smallest thing the Claude parser
// counts as a message.
func claudeUserLine(text string) string {
	return `{"type":"user","message":{"role":"user","content":"` + text + `"},"timestamp":"2026-08-10T09:00:00.000Z","cwd":"/p"}`
}

// TestReadBackwardCrossesALineBiggerThanTheBudget: a single line past
// readBudget used to wedge backward paging — the window ending at the
// client's offset held no line start, so the page came back empty at the same
// offset forever. Backward pages must always make progress, and the pages
// must tile: walked to the top, they reproduce exactly the messages a forward
// walk reads.
func TestReadBackwardCrossesALineBiggerThanTheBudget(t *testing.T) {
	home := t.TempDir()
	giant := strings.Repeat("b", 3<<20) // one line past readBudget, under maxLineBytes
	content := claudeUserLine("alpha") + "\n" + claudeUserLine(giant) + "\n" + claudeUserLine("omega") + "\n"
	write(t, filepath.Join(home, ".claude", "projects", "-p", "cccc.jsonl"), []byte(content))
	x := New(t.TempDir(), home)
	x.sweep()

	// Forward is the reference: three messages, in file order.
	var forward []int64
	var size int64
	for off := int64(0); ; {
		page, err := x.ReadPage(ToolClaude, "cccc", off, "forward", 10)
		if err != nil {
			t.Fatalf("ReadPage forward(%d): %v", off, err)
		}
		for _, m := range page.Messages {
			forward = append(forward, m.Offset)
		}
		size = page.FileSize
		if page.Eof {
			break
		}
		off = page.Next
	}
	if len(forward) != 3 {
		t.Fatalf("forward walk read %d messages, want 3", len(forward))
	}

	// Backward from the end, one message per page: every page starts strictly
	// earlier, and the walk collects the same offsets in reverse.
	var backward []int64
	off := size
	for steps := 0; off > 0; steps++ {
		if steps > 16 {
			t.Fatalf("backward walk took over 16 pages for a 3-line file")
		}
		page, err := x.ReadPage(ToolClaude, "cccc", off, "backward", 1)
		if err != nil {
			t.Fatalf("ReadPage backward(%d): %v", off, err)
		}
		if page.Start >= off {
			t.Fatalf("backward page from %d reported Start %d: no progress", off, page.Start)
		}
		for i := len(page.Messages) - 1; i >= 0; i-- {
			backward = append(backward, page.Messages[i].Offset)
		}
		off = page.Start
	}
	if len(backward) != len(forward) {
		t.Fatalf("backward walk read %d messages, forward read %d", len(backward), len(forward))
	}
	for i := range forward {
		if backward[len(backward)-1-i] != forward[i] {
			t.Fatalf("backward walk = %v reversed, want the forward offsets %v", backward, forward)
		}
	}
}

// TestReadBackwardFromInsideAGiantLineProgresses: the offset itself can land
// mid-line — a client holding a Start from before the file was rewritten, or
// simply an arbitrary jump — and the window behind it is all line interior.
// The page is empty, honestly, but its Start is the line's beginning, which
// is behind the request and parseable forward.
func TestReadBackwardFromInsideAGiantLineProgresses(t *testing.T) {
	home := t.TempDir()
	giant := strings.Repeat("b", 3<<20)
	content := claudeUserLine("alpha") + "\n" + claudeUserLine(giant) + "\n" + claudeUserLine("omega") + "\n"
	write(t, filepath.Join(home, ".claude", "projects", "-p", "eeee.jsonl"), []byte(content))
	x := New(t.TempDir(), home)
	x.sweep()

	giantOff := int64(len(claudeUserLine("alpha")) + 1)
	mid := giantOff + readBudget + (512 << 10) // deep in the giant line, over a budget past its start

	page, err := x.ReadPage(ToolClaude, "eeee", mid, "backward", 10)
	if err != nil {
		t.Fatalf("ReadPage: %v", err)
	}
	if page.Start >= mid {
		t.Fatalf("Start = %d for offset %d: no progress", page.Start, mid)
	}
	if len(page.Messages) != 0 {
		t.Fatalf("a window inside one line returned %d messages, want none", len(page.Messages))
	}
	if page.Start != giantOff {
		t.Errorf("Start = %d, want the giant line's own start %d", page.Start, giantOff)
	}
	// And the Start it handed back parses forward, reading the line whole.
	fwd, err := x.ReadPage(ToolClaude, "eeee", page.Start, "forward", 1)
	if err != nil {
		t.Fatalf("ReadPage forward(Start): %v", err)
	}
	if len(fwd.Messages) != 1 || fwd.Messages[0].Offset != giantOff {
		t.Fatalf("forward from Start read %+v, want the giant line's message", fwd.Messages)
	}
}

// TestReadBackwardStepsThroughAnUnparseableLine: past maxLineBytes a line is
// never parsed, only crossed. Backward, no window can hold a start for it, so
// the pages are empty and Start advances a whole window bound per request —
// the forward skip, spelt as offsets — until ordinary paging resumes on the
// far side.
func TestReadBackwardStepsThroughAnUnparseableLine(t *testing.T) {
	home := t.TempDir()
	// Not JSON on purpose: nothing past maxLineBytes is ever unmarshalled.
	giant := strings.Repeat("x", maxLineBytes+readBudget+(1<<20))
	content := claudeUserLine("alpha") + "\n" + giant + "\n" + claudeUserLine("omega") + "\n"
	write(t, filepath.Join(home, ".claude", "projects", "-p", "ffff.jsonl"), []byte(content))
	x := New(t.TempDir(), home)
	x.sweep()

	head := readPageOf(t, x, "ffff", 0, "forward", 1)
	last := readPageOf(t, x, "ffff", head.FileSize, "backward", 10)
	if len(last.Messages) != 1 {
		t.Fatalf("the last page read %d messages, want omega alone", len(last.Messages))
	}
	omegaOff := last.Messages[0].Offset

	step := readPageOf(t, x, "ffff", omegaOff, "backward", 10)
	if len(step.Messages) != 0 {
		t.Fatalf("a page inside the unparseable line read %d messages, want none", len(step.Messages))
	}
	if want := omegaOff - (maxLineBytes + readBudget); step.Start != want {
		t.Fatalf("Start = %d, want a whole window bound earlier (%d)", step.Start, want)
	}

	first := readPageOf(t, x, "ffff", step.Start, "backward", 10)
	if len(first.Messages) != 1 || first.Messages[0].Offset != 0 {
		t.Fatalf("the far side read %+v, want alpha at offset 0", first.Messages)
	}
	if first.Start != 0 {
		t.Fatalf("Start = %d, want 0", first.Start)
	}
}

// readPageOf is readPage for a session other than the shared fixture's.
func readPageOf(t *testing.T, x *Index, id string, offset int64, dir string, limit int) Page {
	t.Helper()
	page, err := x.ReadPage(ToolClaude, id, offset, dir, limit)
	if err != nil {
		t.Fatalf("ReadPage(%s, %d, %s, %d): %v", id, offset, dir, limit, err)
	}
	return page
}

// TestReadEofIsNotACompletenessClaim: a page that consumed the file says eof,
// the file grows, and the same offset asked again has more to say — the
// doctrine shared with the read verb.
func TestReadEofIsNotACompletenessClaim(t *testing.T) {
	home := t.TempDir()
	line1 := `{"type":"user","message":{"role":"user","content":"one"},"timestamp":"2026-08-10T09:00:00.000Z","cwd":"/p"}` + "\n"
	line2 := `{"type":"user","message":{"role":"user","content":"two"},"timestamp":"2026-08-10T09:00:01.000Z","cwd":"/p"}` + "\n"
	path := filepath.Join(home, ".claude", "projects", "-p", "bbbb.jsonl")
	write(t, path, []byte(line1))
	x := New(t.TempDir(), home)
	x.sweep()

	page, err := x.ReadPage(ToolClaude, "bbbb", 0, "forward", 10)
	if err != nil {
		t.Fatalf("ReadPage: %v", err)
	}
	if !page.Eof || len(page.Messages) != 1 {
		t.Fatalf("first page = %d messages eof %v, want 1 and true", len(page.Messages), page.Eof)
	}

	write(t, path, []byte(line1+line2))
	page, err = x.ReadPage(ToolClaude, "bbbb", page.Next, "forward", 10)
	if err != nil {
		t.Fatalf("ReadPage after growth: %v", err)
	}
	if len(page.Messages) != 1 || page.Messages[0].Text != "two" {
		t.Fatalf("the grown file's page = %+v, want the appended message", page.Messages)
	}
}
