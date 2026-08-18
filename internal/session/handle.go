package session

import (
	"os"
	"time"
)

// Handle is a session as the daemon consumes one: everything conn.go and
// server.go need, and nothing about where the pty actually lives. *Session
// is the in-process implementation; a holder-backed session implements the
// same surface from the far side of a unix socket. The daemon depends on
// this interface so that the two are interchangeable per session, not per
// build.
type Handle interface {
	ID() string
	Info() Info
	ApplyMeta(MetaPatch) Info
	Tail(n int) (data []byte, cols, rows uint16)
	Write(p []byte) error
	Resize(cols, rows uint16) error
	Signal(sig os.Signal) error
	Subscribe(fromSeq uint64) *Sub
	Unsubscribe(*Sub)
	Close() error
}

// handle is what the registry itself needs beyond Handle: the reap sweep's
// questions. Unexported because they are policy inputs, not client surface.
type handle interface {
	Handle
	exitStatus() (exited bool, at time.Time, ephemeral bool)
	groupID() string
}

var _ handle = (*Session)(nil)
