package wire

import (
	"encoding/binary"
	"errors"
	"fmt"
)

// Binary frame types. Layout is [1 byte type][4 bytes ref BE][payload].
const (
	FrameOutput byte = 0x00 // daemon -> client
	FrameInput  byte = 0x01 // client -> daemon
	// FrameFile carries one chunk of a file being read, under the ref the
	// daemon minted for that read. Daemon -> client only: nothing here reads a
	// file the client sends.
	FrameFile byte = 0x02 // daemon -> client
)

const binaryHeaderLen = 5

var ErrShortFrame = errors.New("wire: frame shorter than header")

// EncodeBinary builds a binary data frame.
func EncodeBinary(typ byte, ref uint32, payload []byte) []byte {
	out := make([]byte, binaryHeaderLen+len(payload))
	out[0] = typ
	binary.BigEndian.PutUint32(out[1:5], ref)
	copy(out[binaryHeaderLen:], payload)
	return out
}

// DecodeBinary parses a binary data frame. The returned payload aliases b.
func DecodeBinary(b []byte) (typ byte, ref uint32, payload []byte, err error) {
	if len(b) < binaryHeaderLen {
		return 0, 0, nil, ErrShortFrame
	}
	typ = b[0]
	if typ != FrameOutput && typ != FrameInput && typ != FrameFile {
		return 0, 0, nil, fmt.Errorf("wire: unknown frame type %#x", typ)
	}
	ref = binary.BigEndian.Uint32(b[1:5])
	return typ, ref, b[binaryHeaderLen:], nil
}
