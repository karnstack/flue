package session

// Ring is a fixed-capacity byte buffer that tracks a monotonic sequence
// number for every byte ever written. Bytes are addressed by absolute seq,
// so a reattaching client can ask for everything since the offset it last
// saw. Once the buffer is full, the oldest bytes are evicted and BaseSeq
// advances past them.
//
// Ring is not safe for concurrent use; Session serialises access.
type Ring struct {
	buf []byte
	w   int    // next write index
	n   int    // bytes currently stored, <= len(buf)
	end uint64 // seq just past the most recently written byte
}

// NewRing returns a Ring holding at most size bytes.
func NewRing(size int) *Ring {
	if size < 1 {
		size = 1
	}
	return &Ring{buf: make([]byte, size)}
}

// Write appends p, evicting the oldest bytes if necessary.
func (r *Ring) Write(p []byte) {
	r.end += uint64(len(p))

	// A write larger than capacity keeps only the tail.
	if len(p) >= len(r.buf) {
		copy(r.buf, p[len(p)-len(r.buf):])
		r.w = 0
		r.n = len(r.buf)
		return
	}

	first := copy(r.buf[r.w:], p)
	if first < len(p) {
		copy(r.buf, p[first:])
	}
	r.w = (r.w + len(p)) % len(r.buf)
	if r.n += len(p); r.n > len(r.buf) {
		r.n = len(r.buf)
	}
}

// BaseSeq is the seq of the oldest byte still retained.
func (r *Ring) BaseSeq() uint64 { return r.end - uint64(r.n) }

// EndSeq is the seq just past the newest byte written.
func (r *Ring) EndSeq() uint64 { return r.end }

// Tail returns the last n retained bytes, or everything retained when there
// are fewer than n. A non-positive n is an empty answer rather than an error:
// callers size it from a request, and "show me nothing" is a coherent ask.
//
// It is Since expressed as a distance from the end rather than an absolute
// offset, which is what a reader who holds no seq at all needs — a preview
// wants "the last few kilobytes", and computing the offset for that at every
// call site means every call site has to know about BaseSeq eviction.
func (r *Ring) Tail(n int) []byte {
	if n <= 0 {
		return []byte{}
	}
	if n > r.n {
		n = r.n
	}
	out, _ := r.Since(r.end - uint64(n))
	return out
}

// Since returns every retained byte at or after seq. ok is false when seq
// has already been evicted, which means the caller must send a full
// snapshot instead of a delta. A seq beyond EndSeq yields an empty slice
// and ok=true; that is a client that is simply up to date.
func (r *Ring) Since(seq uint64) ([]byte, bool) {
	if seq < r.BaseSeq() {
		return nil, false
	}
	if seq >= r.end {
		return []byte{}, true
	}
	count := int(r.end - seq)
	out := make([]byte, count)
	start := (r.w - count + len(r.buf)) % len(r.buf)
	first := copy(out, r.buf[start:])
	if first < count {
		copy(out[first:], r.buf)
	}
	return out, true
}
