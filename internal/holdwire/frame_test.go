package holdwire

import (
	"bytes"
	"errors"
	"io"
	"testing"
)

func TestFrameRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	payloads := [][]byte{[]byte("{}"), {}, bytes.Repeat([]byte("x"), 100_000)}
	types := []byte{TJSON, TChunk, TJSON}
	for i, p := range payloads {
		if err := WriteFrame(&buf, types[i], p); err != nil {
			t.Fatalf("WriteFrame #%d: %v", i, err)
		}
	}
	for i, want := range payloads {
		typ, got, err := ReadFrame(&buf)
		if err != nil {
			t.Fatalf("ReadFrame #%d: %v", i, err)
		}
		if typ != types[i] {
			t.Fatalf("frame #%d type = %d, want %d", i, typ, types[i])
		}
		if !bytes.Equal(got, want) {
			t.Fatalf("frame #%d payload mismatch: %d bytes, want %d", i, len(got), len(want))
		}
	}
	if _, _, err := ReadFrame(&buf); !errors.Is(err, io.EOF) {
		t.Fatalf("read past the last frame = %v, want io.EOF", err)
	}
}

// A length prefix from a confused or hostile peer must not become an
// allocation. The reader refuses the frame before reading a byte of it.
func TestReadFrameRefusesOversize(t *testing.T) {
	var buf bytes.Buffer
	buf.Write([]byte{TJSON, 0xFF, 0xFF, 0xFF, 0xFF})
	if _, _, err := ReadFrame(&buf); err == nil {
		t.Fatal("ReadFrame accepted a 4 GiB length prefix")
	}
}

// A frame cut off mid-payload is an error, not a short read silently
// returned as a whole frame.
func TestReadFrameReportsTruncation(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteFrame(&buf, TChunk, []byte("hello")); err != nil {
		t.Fatalf("WriteFrame: %v", err)
	}
	cut := buf.Bytes()[:buf.Len()-2]
	if _, _, err := ReadFrame(bytes.NewReader(cut)); err == nil {
		t.Fatal("ReadFrame returned a truncated frame as complete")
	}
}

func TestWriteFrameRefusesOversize(t *testing.T) {
	big := make([]byte, MaxFrame+1)
	if err := WriteFrame(io.Discard, TChunk, big); err == nil {
		t.Fatal("WriteFrame accepted a payload past MaxFrame")
	}
}
