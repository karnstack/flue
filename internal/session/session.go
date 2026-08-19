package session

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/creack/pty"
	"golang.org/x/sys/unix"
)

// ExitedRetention is how long an exited session stays listable so its final
// output remains readable before the registry reaps it.
const ExitedRetention = 10 * time.Minute

// EphemeralRetention is ExitedRetention for a session marked ephemeral: long
// enough for the client that owns it to hear the exit, and no longer. It is
// not an expiry on a running scratch terminal — a dismissed scratch keeps
// running until its parent session ends (see Registry.Reap) — it only keeps
// exited ones from waiting out ten minutes hidden from every list.
const EphemeralRetention = 10 * time.Second

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

	// Group is the id of the session this one is grouped under — the anchor a
	// client renders it beside as a split or a tab. It is metadata and nothing
	// more: the daemon never resolves it, never requires the anchor to exist,
	// and never treats members differently. Empty is every session spawned
	// before the field existed, and every session that stands alone.
	Group string
	// Ephemeral marks a session a client considers disposable — a scratch
	// terminal, spawned with Group naming the session it was opened from. Its
	// life is tied to that parent: dismissing the scratch UI merely detaches,
	// and the shell runs on until the parent session ends, at which point the
	// registry closes it (see Reap). Server-side it is otherwise only the
	// shorter exited retention; whether to hide it from a list is a client
	// decision.
	Ephemeral bool
}

// Info is a snapshot of session state safe to serialise.
//
// Title and Name are both labels and they are deliberately not the same field.
// Title is what the program running in the session says it is, scraped from
// OSC 0/2 and overwritten whenever it says something else; Name is what a
// human decided to call this session, and nothing running inside it may touch
// it. A UI shows the name when there is one and falls back to the title.
//
// CreatedAt is the one timestamp that never moves. LastActive is the useful
// sort key right up until it isn't — a list ordered by it rearranges itself
// under the reader's cursor as output arrives — so a stable ordering needs a
// field that output cannot disturb.
type Info struct {
	ID         string    `json:"id"`
	Title      string    `json:"title"`
	Name       string    `json:"name"`
	Tags       []string  `json:"tags"`
	Pinned     bool      `json:"pinned"`
	Cwd        string    `json:"cwd"`
	Cmd        []string  `json:"cmd"`
	State      string    `json:"state"` // "running" | "exited"
	ExitCode   int       `json:"exitCode"`
	Cols       uint16    `json:"cols"`
	Rows       uint16    `json:"rows"`
	CreatedAt  time.Time `json:"createdAt"`
	LastActive time.Time `json:"lastActive"`
	// Group and Ephemeral mirror SpawnOpts; see there. Both omitempty, so a
	// session that carries neither serialises exactly as it always has.
	Group     string `json:"group,omitempty"`
	Ephemeral bool   `json:"ephemeral,omitempty"`
}

// MetaPatch is a partial update to a session's human-owned metadata: a nil
// field means "leave this one alone".
//
// Partial rather than whole-record on purpose. Two tabs open on the same
// session are the normal case, not the exotic one, and a client that had to
// send back every field would silently undo whatever the other one changed
// between its last read and this write. With a patch, an edit can only affect
// what it names.
type MetaPatch struct {
	Name   *string
	Tags   *[]string
	Pinned *bool
	// Ephemeral is here for exactly one edit: a scratch terminal being kept.
	// Clearing the flag promotes it to an ordinary session — listable by the
	// client's rules and back on the ordinary exited retention.
	Ephemeral *bool
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
//     held across a syscall that can block — Resize holds it across TIOCSWINSZ,
//     which cannot, and has to; see Resize — and callers release it before
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

	// setsize is pty.Setsize, captured per session at spawn for the same
	// reason as kill. See setWinsize.
	setsize func(f *os.File, ws *pty.Winsize) error

	// cwdOf is processCwd, captured per session at spawn. Info reads it
	// without holding s.mu, so the capture discipline is stricter than for
	// kill and setsize: a test that wants a substitute must swap it before
	// the session's Info is ever called, never while readers are live.
	cwdOf func(pid int) (string, error)

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
	// pumpDone records that pump has returned: the master's stream is over
	// and nothing will ever be read from it again.
	pumpDone bool
	// pumpParked and pumpReads are the supervisor's evidence against a byte
	// in flight: the master can poll quiet while the pump holds a just-read
	// tail it has not yet delivered. parked is true only while the pump is
	// inside Read — holding nothing — and reads counts Read's returns, so a
	// wake-deliver-park cycle between two looks moves the counter even
	// though both looks saw the pump parked. A look believes quiet only
	// with the pump parked and the counter still; the one unobservable
	// instant left is the pump entering Read with nothing in hand, which is
	// exactly the state quiet claims. Atomics because the pump maintains
	// both without the lock.
	pumpParked atomic.Bool
	pumpReads  atomic.Uint64

	// drainPending is set by markExitedLocked instead of dropping subscribers:
	// the child has exited but its final output may still sit unread in the
	// pty buffer, and closing the stream first is how a CI run once watched
	// a subscriber die over an empty ring in the test's first millisecond
	// (docs/FOLLOW-UPS.md §6). While it is set, the drop belongs to whoever
	// can prove the drain is finished — pump, after the chunk that empties
	// the master, or the supervisor, after two spaced looks agree; see both.
	drainPending bool
}

func (s *Session) ID() string { return s.id }

// groupID reads the session's group link under s.mu. It is set at spawn and
// never rewritten, but the lock keeps the read on the right side of the rule
// rather than leaning on that.
func (s *Session) groupID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.info.Group
}

// Info returns a snapshot of the session's state, and is also where the
// child's cwd is refreshed — the kernel is the only party that knows where a
// `cd` left the shell, so every snapshot asks it.
//
// The read happens before s.mu is taken. It needs nothing the lock guards —
// only the pid, which is immutable after spawn — so keeping it outside costs
// nothing and keeps the rule that s.mu is never held across a syscall intact
// without having to argue about whether this one can block.
//
// A failed read keeps the previous value rather than blanking it: the common
// failure is a child that has exited, and "where it last was" remains the
// honest answer for as long as the session is listed. The store is gated on
// State == "running" for the same reason signalling stops at groupGone —
// after the reap the pid may be recycled, and a read that "succeeds" then
// may be describing a stranger's directory.
func (s *Session) Info() Info {
	cwd, err := s.cwdOf(s.pid)
	s.mu.Lock()
	defer s.mu.Unlock()
	if err == nil && s.info.State == "running" {
		s.info.Cwd = cwd
	}
	return s.info
}

// ApplyMeta applies a partial metadata update and returns the resulting
// snapshot — the same one a subsequent Info would report, so a caller can
// answer a client and broadcast the change without a second read.
//
// Naming a session is not activity in it: LastActive is left alone, so
// tidying up a list of sessions cannot reorder the list being tidied.
func (s *Session) ApplyMeta(p MetaPatch) Info {
	s.mu.Lock()
	defer s.mu.Unlock()
	if p.Name != nil {
		s.info.Name = *p.Name
	}
	if p.Tags != nil {
		// normalizeTags always allocates, which is what keeps the caller's
		// slice out of the snapshot Info hands to readers. Sharing it would
		// be a data race nothing in this package could see: the caller may
		// reuse its buffer the moment this returns.
		s.info.Tags = normalizeTags(*p.Tags)
	}
	if p.Pinned != nil {
		s.info.Pinned = *p.Pinned
	}
	if p.Ephemeral != nil {
		s.info.Ephemeral = *p.Ephemeral
	}
	return s.info
}

// normalizeTags settles what a tag is, once, at the edge: trimmed, non-empty,
// unique, sorted. Downstream — filtering, grouping, comparing two sessions'
// tags — then never has to ask whether " prod" and "prod" are the same thing,
// and a stored set has no ordering for two clients to disagree about.
//
// It never returns nil, even for no tags at all. A nil slice serialises as
// JSON null, and a field that is sometimes null and sometimes a list is a
// guard every client has to remember to write.
//
// The result is clipped, so it has no spare capacity for a consumer to append
// into. Info hands the same slice header to every reader; one of them doing
// append(info.Tags, x) on a slice with room to spare would write into the
// array all the others are reading, which is a data race in a caller that did
// nothing wrong.
func normalizeTags(tags []string) []string {
	out := make([]string, 0, len(tags))
	seen := make(map[string]struct{}, len(tags))
	for _, tag := range tags {
		tag = strings.TrimSpace(tag)
		if tag == "" {
			continue
		}
		if _, dup := seen[tag]; dup {
			continue
		}
		seen[tag] = struct{}{}
		out = append(out, tag)
	}
	slices.Sort(out)
	return slices.Clip(out)
}

// Tail returns the last n bytes of this session's scrollback, with the
// dimensions they were drawn at.
//
// It is deliberately not a Subscribe: a caller that only wants to look does
// not want the delivery channel, the backlog bookkeeping or the eventual
// Unsubscribe that a real attachment costs, and a list that peeked at twenty
// rows by attaching to each of them would leave twenty subscribers on the
// session for as long as the daemon took to notice. Nothing about the session
// changes here — LastActive in particular is left alone, because reading a
// preview is not activity *in* the session, and moving the stamp would
// reshuffle the very list the preview is being drawn for.
func (s *Session) Tail(n int) (data []byte, cols, rows uint16) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ring.Tail(n), s.info.Cols, s.info.Rows
}

// Pid is the child's pid, immutable after spawn. A holder's hello carries
// it so the daemon can keep reading the child's cwd itself — processCwd
// needs the same uid, not the same parent.
func (s *Session) Pid() int { return s.pid }

// Seqs reports the ring's retained range: the oldest byte still held and
// the seq just past the newest. A holder's hello carries them so a daemon
// deciding where to attach knows what the ring can still answer for.
func (s *Session) Seqs() (base, end uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ring.BaseSeq(), s.ring.EndSeq()
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
//
// s.mu is held across the ioctl, and that is the whole point rather than an
// oversight. creack/pty's ioctl helper reaches the descriptor through
// os.File.Fd(), which hands over the raw number with no reference held on it —
// its refcounted sibling, ioctlNonblock, is marked "Unused" in that package.
// Write is safe releasing the lock first because os.File.Write *is* refcounted
// and answers ErrClosed; this is not. Released early, a concurrent Close — a
// client's `close`, or Registry.Reap on a session a tab is still watching —
// could close that descriptor between the check above and the ioctl, and the
// kernel hands the number straight back: measured, the next session's pty
// master takes it. TIOCSWINSZ would then land on an unrelated descriptor,
// plausibly another session's terminal.
//
// Nothing can deadlock behind this. TIOCSWINSZ cannot block — the kernel
// writes the winsize and posts SIGWINCH — and the one goroutine that must
// never wait on s.mu, the supervisor, takes it with TryLock.
func (s *Session) Resize(cols, rows uint16) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return ErrSessionClosed
	}
	s.info.Cols, s.info.Rows = cols, rows
	return s.setsize(s.pty, &pty.Winsize{Cols: cols, Rows: rows})
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
// supervisor delivers on request until the group is empty. From that moment it
// delivers nothing — there is nothing left to signal and the id may be recycled
// — and it closes gone once it has also published the exit, after which this
// takes the second branch below instead. Both roads answer nil. That is not an
// error the caller needs to special-case; it is the same "already gone" outcome
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
	// is reported to the supervisor as a hint, never as an exit — but a
	// stream that is over is also the end of any drain the exit was waiting
	// on, and if the exit is already on record the subscribers close here,
	// because no other event is coming to close them.
	defer func() {
		s.mu.Lock()
		s.pumpDone = true
		if s.drainPending || s.info.State == "exited" {
			s.drainPending = false
			s.dropSubsLocked()
		}
		s.mu.Unlock()
		s.noteMasterEnded()
	}()

	buf := make([]byte, 32*1024)
	for {
		s.pumpParked.Store(true)
		n, err := s.pty.Read(buf)
		s.pumpParked.Store(false)
		s.pumpReads.Add(1)
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
			// The pump's own quiet verdict is authoritative: it is the only
			// reader, so under this lock any byte it has not delivered is
			// still visible on the master. Nothing visible and an exit
			// waiting means the drain the exit deferred to is finished.
			if s.drainPending && !masterReadable(s.pty) {
				s.drainPending = false
				s.dropSubsLocked()
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
//   - On Linux it tracks the slave descriptors *and* the leader. It ends
//     when the last slave descriptor is released — a script that does
//     `exec >log 2>&1 </dev/null` and then works for an hour ends the
//     stream immediately while its process group runs on and still needs
//     killing — and it also ends when the session leader exits, whatever
//     still holds a slave: the kernel hangs the tty up as it disassociates
//     the leader's controlling terminal, measured here with a setsid'd
//     grandchild whose open descriptors did not keep the stream alive.
//     Buffered output survives the hangup — the master delivers what was
//     written before erroring — which is what the exit drain leans on.
//   - On Darwin it tracks the session leader. BSD ctty semantics keep the
//     master readable while the leader lives even after every slave
//     descriptor is released, and error it when the leader exits even though
//     a background job still holds one. So the early-EOF case above cannot be
//     reproduced on Darwin at all.
//
// On no platform does the master ending imply the child is reapable or its
// group empty, so the supervisor uses this only to shorten its poll interval
// — never to decide the session's state.
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
// below, and it issues none at all once the group has been observed empty.
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
		// groupEmpty latches the one-way transition groupGone reports. It is
		// deliberately separate from recorded: one is about what the kernel
		// says of the pgid, the other about whether this goroutine has managed
		// to publish the exit to callers, and conflating them is what let a
		// signal go out with no probe behind it.
		groupEmpty bool
		// The supervisor's view of the exit drain across turns: quiet is
		// only believed when two looks spaced at least reapPollMin apart
		// agree, and neither the ring nor the pump's read counter has moved
		// between them. drainSettled gates this goroutine's exit — see the
		// note at the return below.
		drainQuiet   bool
		drainSeq     uint64
		drainReads   uint64
		drainLook    time.Time
		drainSettled bool
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
		// Gated on the reap and on nothing else, because the reap is the event
		// that makes the pgid a question at all. Gating the probe on recorded
		// instead left a reachable state — reaped, exit not yet published
		// because the TryLock above lost — in which this loop fell through to
		// the select and signalled with no probe having run. The pump holds
		// s.mu on every output chunk, so losing that TryLock is ordinary.
		if reaped && !groupEmpty {
			groupEmpty = s.groupGone()
		}
		// The drain the exit deferred (markExitedLocked): the pump settles
		// it after its next chunk, but a pump blocked in read with nothing
		// buffered never wakes — a background job holding the slave in
		// silence is the ordinary shape of that. The supervisor is the
		// actor that still runs, so it confirms quiet from outside: two
		// looks at least reapPollMin apart that agree the master polls
		// quiet, the pump sits parked inside a read, the ring has not
		// grown, and the read counter has not moved between them. Un-spaced
		// looks would not do: the select below also wakes for signal
		// requests and the master hint, which would compress "two
		// consecutive polls" into microseconds — the spacing comes from the
		// wall clock, not the loop. The parked flag is what rules out a
		// tail lifted off the master but not yet under the lock, and the
		// counter rules out a whole wake-deliver-park cycle hiding between
		// the looks.
		if recorded && s.mu.TryLock() {
			if s.drainPending {
				delay = reapPollMin
				if now := time.Now(); now.Sub(drainLook) >= reapPollMin {
					quiet := !masterReadable(s.pty) && s.pumpParked.Load()
					seq := s.ring.EndSeq()
					reads := s.pumpReads.Load()
					if quiet && drainQuiet && seq == drainSeq && reads == drainReads {
						s.drainPending = false
						s.dropSubsLocked()
						drainSettled = true
					}
					drainQuiet, drainSeq, drainReads, drainLook = quiet, seq, reads, now
				}
			} else {
				// Nothing pending: either the exit never had a drain to
				// wait for, or the pump has settled it. Either way the
				// supervisor's part is done.
				drainSettled = true
			}
			s.mu.Unlock()
		}
		if recorded && groupEmpty && drainSettled {
			// Nothing pins the pgid any more, so from here it may name a
			// stranger. Stop signalling, permanently. Gated on the drain
			// having settled, and that gate is load-bearing: the child's
			// own group can empty at the very reap that armed the drain —
			// a job-control background job lives in a group of its own —
			// and a supervisor that returned here after a single look
			// would leave a parked pump's subscribers with no closer at
			// all until the registry reaps the session ten minutes on.
			close(s.gone)
			return
		}

		select {
		case req := <-s.sigReq:
			if groupEmpty {
				// The group has emptied, so nothing is delivered: the pgid is
				// pinned by nothing of ours and may already name a stranger.
				//
				// Answered here rather than left for gone to answer, and that
				// is load-bearing. This goroutine may not have published the
				// exit yet, which needs s.mu, and the caller waiting on this
				// reply may be the very thing holding s.mu — the TryLock above
				// exists precisely so that pair cannot deadlock. nil is what
				// gone would have given a moment later anyway.
				req.reply <- nil
			} else {
				// Either the child is unreaped — so the pid is still the
				// kernel's record of it — or it is reaped and the probe on this
				// very turn found the group still populated. Either way the
				// pgid is pinned by a process of ours, so -pid names our group.
				req.reply <- s.signalGroup(req.sig)
			}
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

// markExitedLocked records the child's exit. The caller must hold s.mu.
//
// It runs only once reapIfExited has confirmed the child is actually gone, so
// State never reports "exited" on the strength of a read error on the master.
// Note that it says nothing about the child's process group, which may well
// outlive it.
//
// It no longer closes the subscribers itself. A child that writes and exits
// in the same breath is reaped while its last bytes still sit unread in the
// pty buffer, and dropping the subscribers here closed their stream ahead of
// its own tail — observed twice on CI as a subscriber dead over an empty
// ring (docs/FOLLOW-UPS.md §6). With the stream already over the drop is
// safe and immediate; otherwise drainPending hands it to the pump and the
// supervisor, whichever proves the drain finished first.
func (s *Session) markExitedLocked(code int) {
	s.info.State = "exited"
	s.info.ExitCode = code
	s.exitedAt = s.clock()
	if s.pumpDone {
		s.dropSubsLocked()
		return
	}
	s.drainPending = true
}

// dropSubsLocked closes out every subscriber. The caller must hold s.mu.
func (s *Session) dropSubsLocked() {
	for sub := range s.subs {
		s.dropLocked(sub)
	}
}

// masterReadable reports whether the PTY master holds bytes its reader has
// not consumed, without blocking and without consuming them. It is the
// probe the drain-then-drop rule rests on: a child's write completes into
// the pty buffer before its exit can be reaped, so at reap time the tail is
// either already in the ring or visible here. A master that cannot be
// polled — closed, or already past end of stream — reads as quiet.
func masterReadable(f *os.File) bool {
	conn, err := f.SyscallConn()
	if err != nil {
		return false
	}
	readable := false
	_ = conn.Control(func(fd uintptr) {
		fds := []unix.PollFd{{Fd: int32(fd), Events: unix.POLLIN}}
		n, err := unix.Poll(fds, 0)
		readable = err == nil && n > 0 && fds[0].Revents&unix.POLLIN != 0
	})
	return readable
}

// exitStatus reports whether the child has exited, when, and whether the
// session is ephemeral — the fields Registry.Reap needs to pick a retention.
// It is a plain read of fields under s.mu, which is never held across
// anything that can block.
func (s *Session) exitStatus() (exited bool, at time.Time, ephemeral bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.info.State == "exited", s.exitedAt, s.info.Ephemeral
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

// setWinsize is pty.Setsize, indirected for the same reason as killGroup and
// with the same discipline — Spawn copies it into each Session, so no goroutine
// reads the variable itself.
//
// It exists so a test can hold the ioctl open and observe what the session lock
// is doing while it runs. That is the only way to see it: the hazard Resize
// guards against is a few instructions wide, and measured directly it shows up
// in roughly three runs in forty even with the scheduler stacked in its favour.
var setWinsize func(f *os.File, ws *pty.Winsize) error = pty.Setsize
