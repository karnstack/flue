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

// reapPollMin and reapPollMax bound how often a session's supervisor asks the
// kernel whether its child has exited. See supervise for why that check has to
// be a poll rather than a blocking wait.
//
// The interval starts at reapPollMin and doubles on every miss, and is reset to
// reapPollMin whenever something makes an exit likely — the pty master going
// quiet, or a signal being delivered. So an exit is normally noticed within a
// few milliseconds of the event that caused it, while a session that has been
// running quietly for hours costs two syscalls a second.
const (
	reapPollMin = 5 * time.Millisecond
	reapPollMax = 500 * time.Millisecond
)

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

// sigRequest asks a session's supervisor to deliver sig to the session's
// process group and to report the outcome on reply. reply is always buffered
// so the supervisor never blocks on a caller that has gone away.
type sigRequest struct {
	sig   syscall.Signal
	reply chan error
}

// Session owns one PTY and its scrollback.
//
// Three kinds of goroutine touch a Session: callers, through the exported
// methods; pump, which copies PTY output into the ring and fans it out to
// subscribers; and supervise, which owns the child process's lifecycle.
//
// The locking rules, in full:
//
//   - s.mu guards ring, title, subs, info, exitedAt and closed. It is never
//     held across a syscall that can block, and callers release it before
//     waiting on the supervisor, which takes s.mu itself when the child
//     exits. That second rule is a courtesy rather than a correctness
//     requirement: the supervisor takes s.mu with TryLock and retries rather
//     than blocking, so a caller that holds the lock and waits still gets an
//     answer.
//   - Registry.mu is only ever acquired before s.mu, never after.
type Session struct {
	id    string
	pty   *os.File
	cmd   *exec.Cmd
	clock func() time.Time

	// pid is the child's pid, captured at spawn so nothing has to read it
	// back off cmd.Process later. pty.StartWithSize starts the child with
	// Setsid, which makes it lead both a new session and a new process group,
	// so pgid == pid: signalling -pid reaches the child and everything it has
	// spawned, the way closing a real terminal window takes its whole job
	// tree down with it.
	pid int

	// kill is syscall.Kill, captured per session at spawn so that a test
	// swapping the package-level killGroup is never racing a supervisor
	// goroutine that is reading it.
	kill func(pid int, sig syscall.Signal) error

	// sigReq carries group-signal requests to the supervisor. Nothing else
	// signals the process group; see supervise for why.
	sigReq chan sigRequest
	// masterEnd is a one-slot hint from pump that the PTY master has stopped
	// producing output. It is a hint about the file descriptor, not about the
	// process; see noteMasterEnded.
	masterEnd chan struct{}
	// gone is closed once the child has been reaped *and* its process group
	// has been observed empty — not merely once the child has exited. Until
	// then the surviving members pin the pgid and it is still ours to signal;
	// after it, the number may be recycled and must never be signalled again.
	gone chan struct{}

	mu       sync.Mutex
	ring     *Ring
	title    *TitleScanner
	subs     map[*Sub]struct{}
	info     Info
	exitedAt time.Time
	closed   bool
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

// Signal delivers a signal to the session's process group.
//
// The signal is not sent from here. It is handed to the supervisor, which is
// the only goroutine allowed to signal or to reap; see supervise. s.mu is
// released before the handoff, so that this never waits on the supervisor
// while holding the lock the supervisor needs to record an exit.
func (s *Session) Signal(sig os.Signal) error {
	ss, ok := sig.(syscall.Signal)
	if !ok {
		return fmt.Errorf("session: signal %v is not a syscall.Signal", sig)
	}
	s.mu.Lock()
	closed := s.closed
	s.mu.Unlock()
	if closed {
		return ErrSessionClosed
	}
	return s.requestGroupSignal(ss)
}

// requestGroupSignal asks the supervisor to signal the process group and waits
// for it to report back.
//
// Reaping the child does not end this: the group outlives its leader, and
// while it has members its id is still unambiguously ours (see groupGone). The
// supervisor keeps serving requests until the group is empty. Only then does
// it close gone, and only then does this refuse — because there is by then
// nothing to signal and the id may be recycled. That is not an error the
// caller needs to special-case; it is the same "already gone" outcome
// signalGroup reports as success when the kernel answers ESRCH.
func (s *Session) requestGroupSignal(sig syscall.Signal) error {
	reply := make(chan error, 1)
	select {
	case s.sigReq <- sigRequest{sig: sig, reply: reply}:
		// The supervisor always answers a request it has accepted.
		return <-reply
	case <-s.gone:
		return nil
	}
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

// Close terminates the session's process group and releases the PTY.
//
// "Process group", not "child": a shell that exits leaving `sleep 1000 &`
// behind has been reaped long before anyone calls Close, and the survivor is
// exactly what Close exists to clean up. It is still reachable, because the
// group pins its own id until the last member goes (see groupGone).
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

	// Ask the supervisor to kill the whole group rather than killing it from
	// here. Whether the pid still names our child or has already gone back to
	// the kernel is knowable only to the goroutine that does the reaping: any
	// flag we could read here might go stale between the read and the
	// syscall. Handing the request over means the kill either lands before
	// that goroutine reaps — which is safe even while the child is still
	// running, since the pid is not freed until it is reaped — or does not
	// happen at all.
	//
	// s.mu is deliberately released first, so that this never waits on the
	// supervisor while holding the lock the supervisor needs to record an
	// exit. Note that Close waits only for the signal to be issued, never for
	// the child to actually die.
	_ = s.requestGroupSignal(syscall.SIGKILL)

	return s.pty.Close()
}

// pump copies PTY output into the ring and fans it out to subscribers.
func (s *Session) pump() {
	// A read error on the master ends the output stream and nothing else. It
	// is reported to the supervisor as a hint, never as an exit.
	defer s.noteMasterEnded()

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
			return
		}
	}
}

// noteMasterEnded tells the supervisor that no more output will arrive on the
// PTY master.
//
// This says nothing about whether the child has exited, and the two must not
// be conflated. The platforms disagree about what the master's stream even
// tracks:
//
//   - On Linux it tracks the slave descriptors. It ends when the last one is
//     released, which skews in both directions: a script that does
//     `exec >log 2>&1 </dev/null` and then works for an hour ends the stream
//     immediately while its process group runs on and still needs killing,
//     and conversely a background job holding the slave keeps the master
//     readable long after the leader has gone.
//   - On Darwin it tracks the session leader. BSD ctty semantics keep the
//     master readable while the leader lives even after every slave
//     descriptor is released, and error it when the leader exits even though
//     a background job still holds one. So the early-EOF case above cannot be
//     reproduced on Darwin at all.
//
// No platform makes the two events coincide reliably, so the supervisor uses
// this only to shorten its poll interval — never to decide the session's
// state.
//
// The hint is delivered at most once per call and dropped if one is already
// pending, so it is safe to call more than once and from more than one place.
func (s *Session) noteMasterEnded() {
	select {
	case s.masterEnd <- struct{}{}:
	default:
	}
}

// supervise is the sole owner of the two operations that must never be
// reordered against each other: delivering a signal to the child's process
// group, and reaping the child.
//
// Reaping hands the pid back to the kernel's allocator, and the pid is also
// the process-group id, so a kill(-pid, sig) issued after the reap can land on
// an unrelated process group belonging to the same user — silently, and
// destructively. (os.Process.Signal is immune because the os package flips an
// internal "done" flag before it reaps and drains in-flight signals behind a
// lock; that is golang.org/issue/13987. A raw group kill has no such
// protection, and tolerating ESRCH does not substitute for one: a recycled pid
// is a live process, not a missing one.) Doing both jobs in a single goroutine
// makes "signal, then reap" a local ordering rather than a race between
// goroutines — every signal this goroutine issues is issued from the select
// below, and it never reaches that select again once the group is gone.
// Callers ask for a signal on sigReq; they never issue one themselves.
//
// Note that the reap is not the point at which signalling has to stop: the
// process group outlives its leader, and while it has members the pgid is
// still ours. See groupGone, which is what actually ends signalling.
//
// The reap is a non-blocking wait4(WNOHANG) poll rather than cmd.Wait().
// cmd.Wait() blocks until the child exits, and a supervisor parked there could
// not serve Close's kill request — which is exactly the case that matters,
// because the master going quiet is not the child exiting (see
// noteMasterEnded), so "no more output, child still running, please kill it"
// is an ordinary state to be in rather than a corner case. The alternative,
// a blocking wait that does not reap, is waitid(WNOWAIT) — which is what
// os.Process.Wait uses internally to get this same ordering, but it is not
// reachable from the standard library and wait4 rejects WNOWAIT on Linux. So
// polling is the portable way to keep the reap under this goroutine's control.
func (s *Session) supervise() {
	var (
		delay    = reapPollMin
		exitCode int
		reaped   bool
		recorded bool
	)
	for {
		if !reaped {
			if code, exited := s.reapIfExited(); exited {
				exitCode, reaped = code, true
				delay = reapPollMin
			}
		}
		if reaped && !recorded {
			// Publish the exit without ever blocking this loop on s.mu. A
			// caller can be waiting on this goroutine for a signal reply, and
			// though Close and Signal both release s.mu before they wait,
			// blocking here on a lock such a caller holds would deadlock the
			// pair — the request channel would have no reader until this
			// returned, and it could not return until the caller let go. A
			// busy lock is simply a reason to come back next turn.
			if s.mu.TryLock() {
				s.markExitedLocked(exitCode)
				s.mu.Unlock()
				recorded = true
			}
			delay = reapPollMin
		}
		if recorded && s.groupGone() {
			// Nothing pins the pgid any more, so from here it may name a
			// stranger. Stop signalling, permanently.
			close(s.gone)
			return
		}
		select {
		case req := <-s.sigReq:
			// Either the child is unreaped, or it is reaped and the probe
			// above found the group still populated. Either way the pgid is
			// still pinned by a process of ours, so -pid names our group.
			req.reply <- s.signalGroup(req.sig)
			delay = reapPollMin
		case <-s.masterEnd:
			delay = reapPollMin
		case <-time.After(delay):
			delay *= 2
			if delay > reapPollMax {
				delay = reapPollMax
			}
		}
	}
}

// groupGone reports whether the child's process group has emptied, which is
// the moment signalling must stop for good.
//
// The reasoning this rests on is worth spelling out, because the obvious
// assumption — that reaping the leader frees its pid — is what made an earlier
// version of this code refuse to kill surviving background jobs. A pid is not
// returned to the allocator while it is still in use as a process-group id:
// Linux frees a struct pid only once no task references it under any type,
// PIDTYPE_PGID included, and XNU's pid allocator skips any candidate that
// pgfind or session_find still resolves. So a group outlives its leader, and
// for as long as it has members, -pgid unambiguously names our group even
// though its leader has been reaped and waited for. kill reports the
// transition to empty as ESRCH, and that first ESRCH is the moment to stop.
//
// The probe runs on the supervisor's poll schedule rather than lazily at the
// next signal, and that is load-bearing rather than tidiness. A session sits
// in the registry for ExitedRetention — ten minutes — before Reap closes it,
// which is ample time for a busy machine to cycle the pid space; and since
// every session flue spawns calls setsid, a recycled pid plausibly leads a
// brand-new process group. Deferring the check to Close would mean signalling
// a ten-minute-stale pgid. Probing bounds the exposure to one poll interval.
//
// A non-ESRCH error (EPERM, say, from a member that changed uid) leaves the
// group presumed alive. That is the conservative answer: it keeps signalling
// enabled for an id that is definitely not recycled.
//
// The probe deliberately does not go through s.kill. The test spy counts the
// signals a session delivers, and a liveness probe is not a delivery.
func (s *Session) groupGone() bool {
	return errors.Is(syscall.Kill(-s.pid, 0), syscall.ESRCH)
}

// reapIfExited collects the child if it has already exited, without blocking.
// It returns (code, true) once the child has been reaped — after which its pid
// must never be signalled again — and (0, false) while the child is still
// running, in which case the pid is still safely the child's.
//
// Only supervise may call this.
func (s *Session) reapIfExited() (int, bool) {
	var ws syscall.WaitStatus
	for {
		wpid, err := syscall.Wait4(s.pid, &ws, syscall.WNOHANG, nil)
		switch {
		case errors.Is(err, syscall.EINTR):
			continue
		case errors.Is(err, syscall.ECHILD):
			// Something outside this package reaped the child. It is gone
			// and its status is now unknowable, which is the one case worth
			// reporting as an exit we cannot describe.
			return -1, true
		case err != nil:
			// No other errno is expected. Do not treat an unknown one as an
			// exit: that would declare a live session dead and, worse, start
			// the countdown to disabling its signalling. Leave it running
			// and ask again on the next poll.
			return 0, false
		case wpid == 0:
			return 0, false
		}
		// ExitStatus is -1 unless the child exited normally, which is what
		// os.ProcessState.ExitCode reports for a signalled process too.
		code := ws.ExitStatus()
		// cmd.Wait would have released the os.Process handle (a pidfd on
		// Linux). We reaped by hand, so we release by hand: Release is
		// documented as what to call when Wait is not.
		if s.cmd.Process != nil {
			_ = s.cmd.Process.Release()
		}
		return code, true
	}
}

// markExitedLocked records the child's exit and closes out its subscribers.
// The caller must hold s.mu.
//
// It runs only once reapIfExited has confirmed the child is actually gone, so
// State never reports "exited" on the strength of a read error on the master.
// Note that it says nothing about the child's process group, which may well
// outlive it.
func (s *Session) markExitedLocked(code int) {
	s.info.State = "exited"
	s.info.ExitCode = code
	s.exitedAt = s.clock()
	for sub := range s.subs {
		s.dropLocked(sub)
	}
}

// exitStatus reports whether the child has exited and, if so, when — the two
// fields Registry.Reap needs. It is a plain read of two fields under s.mu,
// which is never held across anything that can block.
func (s *Session) exitStatus() (bool, time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.info.State == "exited", s.exitedAt
}

// signalGroup delivers sig to the process group led by the child. A group that
// has already exited (ESRCH) is not an error the caller needs to handle.
//
// Only supervise may call this; see the ordering argument there.
func (s *Session) signalGroup(sig syscall.Signal) error {
	if err := s.kill(-s.pid, sig); err != nil && !errors.Is(err, syscall.ESRCH) {
		return err
	}
	return nil
}

// killGroup is syscall.Kill, indirected through a package variable so tests
// can substitute a spy and assert that a group signal was (or was not) issued
// without depending on real process lifecycle or pid-reuse timing. Spawn
// copies it into each Session, so a supervisor goroutine never reads the
// variable itself and a test that swaps it before spawning is not writing to
// something a running session is reading.
var killGroup func(pid int, sig syscall.Signal) error = syscall.Kill
