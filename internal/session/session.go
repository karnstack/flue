package session

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"sync"
	"syscall"
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
	reaped     bool // true once cmd.Wait() has returned; the pid may be recycled
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
	if s.reaped {
		// cmd.Wait() has already returned, so the OS is free to recycle
		// this pid for an unrelated process at any time — signalling -pid
		// again could hit whatever now leads that group instead. There is
		// nothing left to signal, which is not an error the caller needs
		// to special-case; it's the same "already gone" outcome
		// signalGroup already treats as success via ESRCH, just observed
		// a different way.
		return nil
	}
	return signalGroup(s.cmd.Process.Pid, sig)
}

// killGroup is syscall.Kill, indirected through a package variable so tests
// can substitute a spy and assert a group signal was (or was not) issued
// without depending on real process lifecycle or pid-reuse timing.
var killGroup = syscall.Kill

// signalGroup delivers sig to the process group led by pid. pty.StartWithSize
// starts the leader in a new session (Setsid), which makes it its own
// process-group leader too (pgid == pid), so signalling -pid reaches the
// leader and everything it has spawned — not just the leader — the same way
// closing a real terminal window takes its whole job tree down with it. A
// group that has already exited (ESRCH) is not treated as an error the
// caller needs to handle.
//
// Callers must have already established (under s.mu, consistently with how
// markExited sets s.reaped under the same lock) that the pid has not yet
// been reaped: once cmd.Wait() has returned, the pid is eligible for reuse
// by the kernel and must never be signalled again.
func signalGroup(pid int, sig os.Signal) error {
	ss, ok := sig.(syscall.Signal)
	if !ok {
		return fmt.Errorf("session: signal %v is not a syscall.Signal", sig)
	}
	if err := killGroup(-pid, ss); err != nil && !errors.Is(err, syscall.ESRCH) {
		return err
	}
	return nil
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
	if s.closed {
		// Close has already run its one-time drop loop, and nothing will
		// ever visit this session's subs again — a subscriber registered
		// now would sit on an open channel forever. Close it immediately
		// instead: the invariant "every Sub's channel is eventually
		// closed" then holds trivially for both the open and closed cases,
		// rather than depending on a future event that will never come.
		sub.closed = true
		close(ch)
		return sub
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
	if !s.reaped && s.cmd.Process != nil {
		// Kill the whole process group, not just the leader: a background
		// child (e.g. a job started with &) keeps its inherited stdout/
		// stderr open on the pty slave even after the leader exits, which
		// would otherwise keep pump's Read blocked forever waiting for a
		// hangup that never comes.
		//
		// This runs while still holding s.mu, the same lock markExited
		// holds across its own cmd.Wait() call (see below), so this check
		// and that reap are fully serialised: either this observes
		// s.reaped already true (Wait has returned, pid may be recycled,
		// skip signalling) and does nothing, or it runs first and the pid
		// is still guaranteed live for the signal to land on. A session
		// that already exited on its own has nothing left to kill.
		_ = signalGroup(s.cmd.Process.Pid, syscall.SIGKILL)
	}
	s.mu.Unlock()

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
		// s.mu is held across cmd.Wait() itself, not just the state update
		// after it: Signal and Close both check s.reaped and (if not
		// reaped) call signalGroup while holding s.mu too, so this is what
		// makes "is the pid still safe to signal" and "reap the pid" fully
		// mutually exclusive. pump only calls markExited after the pty's
		// master Read has already errored out, which — since that error
		// means the slave has been fully released — implies the process
		// is already a zombie; Wait() here just collects it and should
		// return immediately, so holding the lock across it does not
		// stall other session operations in practice.
		s.mu.Lock()
		defer s.mu.Unlock()

		code := 0
		if err := s.cmd.Wait(); err != nil {
			var ee *exec.ExitError
			if errors.As(err, &ee) {
				code = ee.ExitCode()
			} else {
				code = -1
			}
		}
		s.info.State = "exited"
		s.info.ExitCode = code
		s.exitedAt = s.clock()
		s.reaped = true
		for sub := range s.subs {
			s.dropLocked(sub)
		}
	})
}
