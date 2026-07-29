package session

import (
	"bytes"
	"testing"
)

func TestRingWriteAndSince(t *testing.T) {
	r := NewRing(16)
	r.Write([]byte("hello"))

	if got := r.BaseSeq(); got != 0 {
		t.Fatalf("BaseSeq = %d, want 0", got)
	}
	if got := r.EndSeq(); got != 5 {
		t.Fatalf("EndSeq = %d, want 5", got)
	}

	data, ok := r.Since(0)
	if !ok {
		t.Fatal("Since(0) ok = false, want true")
	}
	if !bytes.Equal(data, []byte("hello")) {
		t.Fatalf("Since(0) = %q, want %q", data, "hello")
	}

	data, ok = r.Since(2)
	if !ok || !bytes.Equal(data, []byte("llo")) {
		t.Fatalf("Since(2) = %q, %v; want %q, true", data, ok, "llo")
	}

	data, ok = r.Since(5)
	if !ok || len(data) != 0 {
		t.Fatalf("Since(5) = %q, %v; want empty, true", data, ok)
	}
}

func TestRingEvictionAdvancesBaseSeq(t *testing.T) {
	r := NewRing(8)
	r.Write([]byte("abcdefgh"))
	r.Write([]byte("ijkl"))

	if got := r.BaseSeq(); got != 4 {
		t.Fatalf("BaseSeq = %d, want 4", got)
	}
	if got := r.EndSeq(); got != 12 {
		t.Fatalf("EndSeq = %d, want 12", got)
	}

	data, ok := r.Since(4)
	if !ok || !bytes.Equal(data, []byte("efghijkl")) {
		t.Fatalf("Since(4) = %q, %v; want %q, true", data, ok, "efghijkl")
	}

	if _, ok := r.Since(3); ok {
		t.Fatal("Since(3) ok = true, want false (evicted)")
	}
}

func TestRingWriteLargerThanCapacity(t *testing.T) {
	r := NewRing(4)
	r.Write([]byte("abcdefghij"))

	if got := r.BaseSeq(); got != 6 {
		t.Fatalf("BaseSeq = %d, want 6", got)
	}
	data, ok := r.Since(6)
	if !ok || !bytes.Equal(data, []byte("ghij")) {
		t.Fatalf("Since(6) = %q, %v; want %q, true", data, ok, "ghij")
	}
}

func TestRingWrapPreservesOrder(t *testing.T) {
	r := NewRing(6)
	for _, s := range []string{"ab", "cd", "ef", "gh"} {
		r.Write([]byte(s))
	}
	data, ok := r.Since(r.BaseSeq())
	if !ok || !bytes.Equal(data, []byte("cdefgh")) {
		t.Fatalf("Since(base) = %q, %v; want %q, true", data, ok, "cdefgh")
	}
}
