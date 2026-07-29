package session

import "testing"

func TestTitleScannerBEL(t *testing.T) {
	s := NewTitleScanner()
	title, ok := s.Feed([]byte("\x1b]0;my title\x07rest"))
	if !ok || title != "my title" {
		t.Fatalf("Feed = %q, %v; want %q, true", title, ok, "my title")
	}
}

func TestTitleScannerST(t *testing.T) {
	s := NewTitleScanner()
	title, ok := s.Feed([]byte("\x1b]2;other\x1b\\"))
	if !ok || title != "other" {
		t.Fatalf("Feed = %q, %v; want %q, true", title, ok, "other")
	}
}

func TestTitleScannerSplitAcrossChunks(t *testing.T) {
	s := NewTitleScanner()
	if _, ok := s.Feed([]byte("\x1b]0;split ")); ok {
		t.Fatal("Feed returned a title before the terminator")
	}
	title, ok := s.Feed([]byte("title\x07"))
	if !ok || title != "split title" {
		t.Fatalf("Feed = %q, %v; want %q, true", title, ok, "split title")
	}
}

func TestTitleScannerIgnoresOtherOSC(t *testing.T) {
	s := NewTitleScanner()
	if title, ok := s.Feed([]byte("\x1b]8;;https://example.com\x07")); ok {
		t.Fatalf("Feed = %q, true; want ok=false for OSC 8", title)
	}
}

func TestTitleScannerLastWins(t *testing.T) {
	s := NewTitleScanner()
	title, ok := s.Feed([]byte("\x1b]0;first\x07\x1b]0;second\x07"))
	if !ok || title != "second" {
		t.Fatalf("Feed = %q, %v; want %q, true", title, ok, "second")
	}
}

func TestTitleScannerBoundsRunawaySequence(t *testing.T) {
	s := NewTitleScanner()
	long := make([]byte, 0, maxTitleLen+64)
	long = append(long, "\x1b]0;"...)
	for i := 0; i < maxTitleLen+32; i++ {
		long = append(long, 'x')
	}
	if _, ok := s.Feed(long); ok {
		t.Fatal("Feed accepted an unterminated oversized title")
	}
	// The scanner must have abandoned the sequence, so a well-formed one
	// that follows still parses.
	title, ok := s.Feed([]byte("\x1b]0;ok\x07"))
	if !ok || title != "ok" {
		t.Fatalf("Feed = %q, %v; want %q, true", title, ok, "ok")
	}
}

func TestTitleScannerUnterminatedOtherOSCFollowedByTitle(t *testing.T) {
	s := NewTitleScanner()
	// Long unterminated OSC 8 sequence, longer than maxTitleLen
	long := make([]byte, 0, maxTitleLen+64)
	long = append(long, "\x1b]8;;"...)
	for i := 0; i < maxTitleLen+32; i++ {
		long = append(long, 'x')
	}
	if _, ok := s.Feed(long); ok {
		t.Fatal("Feed accepted an unterminated oversized ignored sequence")
	}
	// The scanner must have abandoned the ignored sequence, so a well-formed
	// OSC 0 title that follows still parses.
	title, ok := s.Feed([]byte("\x1b]0;recovered\x07"))
	if !ok || title != "recovered" {
		t.Fatalf("Feed = %q, %v; want %q, true", title, ok, "recovered")
	}
}

func TestTitleScannerESCMidParameter(t *testing.T) {
	s := NewTitleScanner()
	// ESC in the middle of the parameter should reset and re-dispatch
	title, ok := s.Feed([]byte("\x1b]0\x1b]0;second\x07"))
	if !ok || title != "second" {
		t.Fatalf("Feed = %q, %v; want %q, true", title, ok, "second")
	}
}

func TestTitleScannerESCMidPayload(t *testing.T) {
	s := NewTitleScanner()
	// ESC in the middle of the payload should reset and re-dispatch
	title, ok := s.Feed([]byte("\x1b]0;first\x1b\x1b]0;second\x07"))
	if !ok || title != "second" {
		t.Fatalf("Feed = %q, %v; want %q, true", title, ok, "second")
	}
}
