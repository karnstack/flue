// Package holdwire is the protocol between the daemon and a session holder:
// framing here, message shapes in msg.go. It is deliberately tiny and
// version 1 is meant to stay the only version for a long time — a holder
// keeps running the binary that spawned it across daemon updates, so every
// verb added here is a compatibility promise to every holder already alive.
package holdwire

import (
	"encoding/binary"
	"fmt"
	"io"
)

// Proto is the protocol version a holder reports in its hello. A daemon
// that meets a version it does not know must surface the holder as
// unreachable, never guess at it.
const Proto = 1

// Frame types. Control connections carry only TJSON; an attach connection
// carries one TJSON header and then TChunk frames of raw session output.
const (
	TJSON  byte = 1
	TChunk byte = 2
)

// MaxFrame bounds a single frame's payload. The largest legitimate frame is
// a spawn request carrying a revived ring (2 MiB by default) inside JSON
// base64, so 8 MiB clears every real message while keeping a corrupt or
// hostile length prefix from turning into an allocation.
const MaxFrame = 8 << 20

// WriteFrame writes one frame: type byte, big-endian uint32 length, payload.
func WriteFrame(w io.Writer, t byte, p []byte) error {
	if len(p) > MaxFrame {
		return fmt.Errorf("holdwire: frame of %d bytes exceeds MaxFrame", len(p))
	}
	var hdr [5]byte
	hdr[0] = t
	binary.BigEndian.PutUint32(hdr[1:], uint32(len(p)))
	if _, err := w.Write(hdr[:]); err != nil {
		return err
	}
	_, err := w.Write(p)
	return err
}

// ReadFrame reads one frame. A cleanly closed peer surfaces as io.EOF from
// the header read; a connection cut mid-frame is io.ErrUnexpectedEOF, which
// callers must treat as an error rather than a short frame.
func ReadFrame(r io.Reader) (t byte, p []byte, err error) {
	var hdr [5]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return 0, nil, err
	}
	n := binary.BigEndian.Uint32(hdr[1:])
	if n > MaxFrame {
		return 0, nil, fmt.Errorf("holdwire: frame of %d bytes exceeds MaxFrame", n)
	}
	p = make([]byte, n)
	if _, err := io.ReadFull(r, p); err != nil {
		if err == io.EOF {
			err = io.ErrUnexpectedEOF
		}
		return 0, nil, err
	}
	return hdr[0], p, nil
}
