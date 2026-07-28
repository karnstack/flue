package session

import (
	"errors"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/creack/pty"
)

// ExitedRetention is how long an exited session stays listable so its final
// output remains readable before the registry reaps it.
const ExitedRetention = 10 * time.Minute

// DefaultRingSize is the default scrollback capacity per session.
const DefaultRingSize = 2 << 20 // 2 MiB

// subChanDepth bounds how far a subscriber may fall behind before it is
// dropped. A dropped subscriber reconnects and reattaches with its lastSeq,
// so no output is lost — it is re-fetched from the ring.
const subChanDepth = 256

var ErrSessionClosed = errors.New("session closed")

// SpawnOpts configures a new session.
type SpawnOpts struct {
	Cwd      string
	Cmd      []string // empty means the user's login shell
	Cols     uint16
	Rows     uint16
	RingSize int // zero means DefaultRingSize
}

// Info is a snapshot of session state safe to serialise.
type Info struct {
	ID         string    `json:"id"`
	Title      string    `json:"title"`
	Cwd        string    `json:"cwd"`
	Cmd        []string  `json:"cmd"`
	State      string    `json:"state"` // "running" | "exited"
	ExitCode   int       `json:"exitCode"`
	Cols       uint16    `json:"cols"`
	Rows       uint16    `json:"rows"`
	LastActive time.Time `json:"lastActive"`
}

// Sub is one subscriber's view of a session's output stream. Backlog plus
// everything delivered on C is exactly the byte stream from StartSeq
// onward. Truncated reports that the requested seq had already been
// evicted, so StartSeq is later than what was asked for and the client must
// reset its emulator before writing Backlog.
type Sub struct {
	Backlog   []byte
	StartSeq  uint64
	Truncated bool
	C         <-chan []byte

	ch     chan []byte
	closed bool
}

// Session owns one PTY and its scrollback.
type Session struct {
	id    string
	pty   *os.File
	cmd   *exec.Cmd
	clock func() time.Time

	mu         sync.Mutex
	ring       *Ring
	title      *TitleScanner
	subs       map[*Sub]struct{}
	info       Info
	exitedAt   time.Time
	closed     bool
	exitedOnce sync.Once
}

func (s *Session) ID() string { return s.id }

// Info returns a snapshot of the session's state.
func (s *Session) Info() Info {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.info
}

// Write sends bytes to the PTY.
func (s *Session) Write(p []byte) error {
	s.mu.Lock()
	closed := s.closed
	s.info.LastActive = s.clock()
	s.mu.Unlock()
	if closed {
		return ErrSessionClosed
	}
	_, err := s.pty.Write(p)
	return err
}

// Resize changes the PTY window size.
func (s *Session) Resize(cols, rows uint16) error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return ErrSessionClosed
	}
	s.info.Cols, s.info.Rows = cols, rows
	s.mu.Unlock()
	return pty.Setsize(s.pty, &pty.Winsize{Cols: cols, Rows: rows})
}

// Signal delivers a signal to the process group.
func (s *Session) Signal(sig os.Signal) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.cmd.Process == nil {
		return ErrSessionClosed
	}
	return s.cmd.Process.Signal(sig)
}

// Subscribe registers a subscriber for output at or after fromSeq. The
// backlog and the channel together are gap-free.
func (s *Session) Subscribe(fromSeq uint64) *Sub {
	s.mu.Lock()
	defer s.mu.Unlock()

	start := fromSeq
	truncated := false
	data, ok := s.ring.Since(fromSeq)
	if !ok {
		truncated = true
		start = s.ring.BaseSeq()
		data, _ = s.ring.Since(start)
	}

	ch := make(chan []byte, subChanDepth)
	sub := &Sub{
		Backlog:   data,
		StartSeq:  start,
		Truncated: truncated,
		C:         ch,
		ch:        ch,
	}
	s.subs[sub] = struct{}{}
	return sub
}

// Unsubscribe removes a subscriber and closes its channel.
func (s *Session) Unsubscribe(sub *Sub) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.dropLocked(sub)
}

func (s *Session) dropLocked(sub *Sub) {
	if _, ok := s.subs[sub]; !ok {
		return
	}
	delete(s.subs, sub)
	if !sub.closed {
		sub.closed = true
		close(sub.ch)
	}
}

// Close terminates the process and releases the PTY.
func (s *Session) Close() error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	for sub := range s.subs {
		s.dropLocked(sub)
	}
	s.mu.Unlock()

	if s.cmd.Process != nil {
		_ = s.cmd.Process.Kill()
	}
	return s.pty.Close()
}

// pump copies PTY output into the ring and fans it out to subscribers.
func (s *Session) pump() {
	buf := make([]byte, 32*1024)
	for {
		n, err := s.pty.Read(buf)
		if n > 0 {
			chunk := make([]byte, n)
			copy(chunk, buf[:n])

			s.mu.Lock()
			s.ring.Write(chunk)
			if title, ok := s.title.Feed(chunk); ok {
				s.info.Title = title
			}
			s.info.LastActive = s.clock()
			for sub := range s.subs {
				select {
				case sub.ch <- chunk:
				default:
					// Subscriber is too far behind. Drop it; it will
					// reattach with its lastSeq and re-read the ring.
					s.dropLocked(sub)
				}
			}
			s.mu.Unlock()
		}
		if err != nil {
			s.markExited()
			return
		}
	}
}

func (s *Session) markExited() {
	s.exitedOnce.Do(func() {
		code := 0
		if err := s.cmd.Wait(); err != nil {
			var ee *exec.ExitError
			if errors.As(err, &ee) {
				code = ee.ExitCode()
			} else {
				code = -1
			}
		}
		s.mu.Lock()
		s.info.State = "exited"
		s.info.ExitCode = code
		s.exitedAt = s.clock()
		for sub := range s.subs {
			s.dropLocked(sub)
		}
		s.mu.Unlock()
	})
}
