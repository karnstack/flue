package session

import (
	"bytes"
	"errors"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/creack/pty"
)

func waitFor(t *testing.T, sub *Sub, want string, timeout time.Duration) []byte {
	t.Helper()
	var acc []byte
	acc = append(acc, sub.Backlog...)
	deadline := time.After(timeout)
	for !bytes.Contains(acc, []byte(want)) {
		select {
		case b, ok := <-sub.C:
			if !ok {
				t.Fatalf("subscriber closed while waiting for %q; got %q", want, acc)
			}
			acc = append(acc, b...)
		case <-deadline:
			t.Fatalf("timed out waiting for %q; got %q", want, acc)
		}
	}
	return acc
}

func TestSpawnProducesOutput(t *testing.T) {
	r := NewRegistry(time.Now)
	s, err := r.Spawn(SpawnOpts{Cmd: []string{"sh", "-c", "echo hello-flue"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	sub := s.Subscribe(0)
	defer s.Unsubscribe(sub)
	waitFor(t, sub, "hello-flue", 5*time.Second)
}

func TestResizePropagatesToPTY(t *testing.T) {
	r := NewRegistry(time.Now)
	s, err := r.Spawn(SpawnOpts{
		Cmd:  []string{"sh", "-c", "sleep 0.3; stty size"},
		Cols: 80, Rows: 24,
	})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	sub := s.Subscribe(0)
	defer s.Unsubscribe(sub)

	if err := s.Resize(100, 40); err != nil {
		t.Fatalf("Resize: %v", err)
	}
	got := waitFor(t, sub, "40 100", 5*time.Second)
	if !strings.Contains(string(got), "40 100") {
		t.Fatalf("stty size output = %q, want it to contain %q", got, "40 100")
	}
}

func TestWriteReachesPTY(t *testing.T) {
	r := NewRegistry(time.Now)
	s, err := r.Spawn(SpawnOpts{Cmd: []string{"cat"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	sub := s.Subscribe(0)
	defer s.Unsubscribe(sub)

	if err := s.Write([]byte("ping\n")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	waitFor(t, sub, "ping", 5*time.Second)
}

func TestTwoSubscribersBothReceive(t *testing.T) {
	r := NewRegistry(time.Now)
	s, err := r.Spawn(SpawnOpts{Cmd: []string{"cat"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	a := s.Subscribe(0)
	defer s.Unsubscribe(a)
	b := s.Subscribe(0)
	defer s.Unsubscribe(b)

	if err := s.Write([]byte("both\n")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	waitFor(t, a, "both", 5*time.Second)
	waitFor(t, b, "both", 5*time.Second)
}

func TestSubscribeTruncatedWhenSeqEvicted(t *testing.T) {
	r := NewRegistry(time.Now)
	s, err := r.Spawn(SpawnOpts{
		Cmd:      []string{"sh", "-c", "printf 'a%.0s' $(seq 1 4096)"},
		Cols:     80,
		Rows:     24,
		RingSize: 64,
	})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	sub := s.Subscribe(0)
	waitFor(t, sub, "aaaa", 5*time.Second)
	s.Unsubscribe(sub)

	// Wait for the process to finish so the ring has definitely wrapped.
	deadline := time.After(5 * time.Second)
	for s.Info().State != "exited" {
		select {
		case <-deadline:
			t.Fatal("process did not exit")
		case <-time.After(10 * time.Millisecond):
		}
	}

	late := s.Subscribe(0)
	defer s.Unsubscribe(late)
	if !late.Truncated {
		t.Fatal("Truncated = false, want true after eviction")
	}
	if late.StartSeq == 0 {
		t.Fatal("StartSeq = 0, want the ring's advanced base")
	}
}

func TestExitedSessionsReapedAfterRetention(t *testing.T) {
	now := time.Now()
	clock := func() time.Time { return now }
	r := NewRegistry(clock)

	s, err := r.Spawn(SpawnOpts{Cmd: []string{"sh", "-c", "exit 3"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}

	deadline := time.After(5 * time.Second)
	for s.Info().State != "exited" {
		select {
		case <-deadline:
			t.Fatal("process did not exit")
		case <-time.After(10 * time.Millisecond):
		}
	}
	if got := s.Info().ExitCode; got != 3 {
		t.Fatalf("ExitCode = %d, want 3", got)
	}

	r.Reap()
	if _, ok := r.Get(s.ID()); !ok {
		t.Fatal("session reaped before the retention window elapsed")
	}

	now = now.Add(ExitedRetention + time.Second)
	r.Reap()
	if _, ok := r.Get(s.ID()); ok {
		t.Fatal("session still present after the retention window")
	}
}

func TestTitleFromOSC(t *testing.T) {
	r := NewRegistry(time.Now)
	s, err := r.Spawn(SpawnOpts{
		Cmd:  []string{"sh", "-c", "printf '\\033]0;flue-title\\007'; sleep 0.2"},
		Cols: 80, Rows: 24,
	})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	deadline := time.After(5 * time.Second)
	for s.Info().Title != "flue-title" {
		select {
		case <-deadline:
			t.Fatalf("Title = %q, want %q", s.Info().Title, "flue-title")
		case <-time.After(10 * time.Millisecond):
		}
	}
}

// parseChildPID extracts the number following "child-pid=" in out, as
// printed by a shell's `echo child-pid=$!` right after backgrounding a job.
func parseChildPID(t *testing.T, out []byte) int {
	t.Helper()
	i := bytes.Index(out, []byte("child-pid="))
	if i < 0 {
		t.Fatalf("output %q does not contain %q", out, "child-pid=")
	}
	rest := out[i+len("child-pid="):]
	end := 0
	for end < len(rest) && rest[end] >= '0' && rest[end] <= '9' {
		end++
	}
	pid, err := strconv.Atoi(string(rest[:end]))
	if err != nil {
		t.Fatalf("parse child pid from %q: %v", rest[:end], err)
	}
	return pid
}

// waitGone polls (rather than sleeping a fixed interval) until pid no longer
// exists, or fails the test once timeout elapses.
func waitGone(t *testing.T, pid int, timeout time.Duration) {
	t.Helper()
	deadline := time.After(timeout)
	for {
		err := syscall.Kill(pid, 0)
		if errors.Is(err, syscall.ESRCH) {
			return
		}
		select {
		case <-deadline:
			t.Fatalf("pid %d still alive after %s", pid, timeout)
		case <-time.After(10 * time.Millisecond):
		}
	}
}

// TestSubscribeAfterCloseReturnsClosedChannel guards against a subscriber
// registered on an already-closed session sitting on an open channel
// forever: Close only runs its drop loop once, at the open-to-closed
// transition, so a Sub created afterward would never be told to stop and a
// consumer (e.g. a WebSocket handler) reading <-sub.C would block forever.
func TestSubscribeAfterCloseReturnsClosedChannel(t *testing.T) {
	r := NewRegistry(time.Now)
	s, err := r.Spawn(SpawnOpts{Cmd: []string{"cat"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	// Wait for the pump goroutine to actually finish and run markExited's
	// one-time drop sweep before subscribing. markExited sets State and
	// runs its drop loop inside the same locked section, so once State is
	// observably "exited" that sweep is over and gone for good — this is
	// the state the described bug depends on: a subscriber registered well
	// after teardown has finished, with nothing left that will ever visit
	// it again. Subscribing immediately after Close (without this wait)
	// races with that sweep and can pass for the wrong reason.
	deadline := time.After(5 * time.Second)
	for s.Info().State != "exited" {
		select {
		case <-deadline:
			t.Fatal(`session never reached "exited" after Close`)
		case <-time.After(10 * time.Millisecond):
		}
	}

	sub := s.Subscribe(0)
	defer s.Unsubscribe(sub)
	select {
	case _, ok := <-sub.C:
		if ok {
			t.Fatal("C delivered a value for a subscriber created after Close")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("C never closed for a subscriber created after Close; a reader would block forever")
	}
}

// TestCloseTerminatesBackgroundChildren guards against Close killing only the
// shell and leaving a background job running.
//
// This shell exits the instant it has echoed, so by the time anyone calls
// Close its leader has been reaped and only the background job survives —
// which is the ordinary case, not a corner one: `sleep 1000 &` in a script
// that then returns is a shape people write on purpose. Close therefore has to
// signal a group whose leader is already gone, and it can, because the group
// pins its own id until its last member goes.
//
// The test waits for the reap on purpose rather than racing it. An earlier
// version called Close immediately and passed on an idle machine by arriving
// before the reaper; under CPU contention it failed roughly one run in eight,
// leaking an orphan each time. Waiting first makes the post-reap path the only
// path this exercises.
//
// The child sets its SIGHUP disposition to ignore (an empty shell trap body,
// inherited across its fork+exec the same way nohup works) so it does not
// incidentally die from the kernel's own hangup-on-session-leader-death or
// hangup-on-master-close delivery — both of those are SIGHUP-based and would
// otherwise mask whether Close's own kill is leader-only or whole-group.
func TestCloseTerminatesBackgroundChildren(t *testing.T) {
	spy := installKillSpy(t)

	r := NewRegistry(time.Now)
	s, err := r.Spawn(SpawnOpts{
		Cmd:  []string{"sh", "-c", "trap '' HUP; sleep 1000 & echo child-pid=$!"},
		Cols: 80, Rows: 24,
	})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}

	sub := s.Subscribe(0)
	out := waitFor(t, sub, "child-pid=", 5*time.Second)
	s.Unsubscribe(sub)
	childPID := parseChildPID(t, out)

	// Barrier: the leader has been reaped and its status recorded.
	waitExited(t, s, 5*time.Second)

	if err := syscall.Kill(childPID, 0); err != nil {
		t.Fatalf("background child pid %d already gone before Close, so this run tests nothing: %v", childPID, err)
	}
	select {
	case <-s.gone:
		t.Fatal("supervisor gave up the process group while a member of it was still alive")
	default:
	}

	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	spy.waitForKill(t, -s.pid, syscall.SIGKILL, 5*time.Second)
	waitGone(t, childPID, 5*time.Second)
	waitSupervisorGone(t, s, 5*time.Second)
}

// TestSignalReachesChildProcess guards against Signal only reaching the
// session's leader process: a background child shares the leader's process
// group (pty.StartWithSize sets Setsid, so pgid == the leader's pid), and
// Signal must deliver to the whole group, the way closing a real terminal
// takes its job tree down with it.
//
// As in TestCloseTerminatesBackgroundChildren, the child ignores SIGHUP so
// the kernel's own hangup-on-session-leader-death delivery (triggered the
// instant SIGKILL reaches the shell) can't incidentally kill it too and
// mask a leader-only Signal implementation.
func TestSignalReachesChildProcess(t *testing.T) {
	r := NewRegistry(time.Now)
	s, err := r.Spawn(SpawnOpts{
		Cmd:  []string{"sh", "-c", "trap '' HUP; sleep 1000 & echo child-pid=$!; wait"},
		Cols: 80, Rows: 24,
	})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	sub := s.Subscribe(0)
	out := waitFor(t, sub, "child-pid=", 5*time.Second)
	s.Unsubscribe(sub)

	childPID := parseChildPID(t, out)
	if err := syscall.Kill(childPID, 0); err != nil {
		t.Fatalf("background child pid %d not running before Signal: %v", childPID, err)
	}

	if err := s.Signal(syscall.SIGKILL); err != nil {
		t.Fatalf("Signal: %v", err)
	}

	waitGone(t, childPID, 2*time.Second)
}

// TestResizeHoldsTheSessionLockAcrossTheIoctl pins the one thing that keeps a
// window-size change off an unrelated file descriptor.
//
// creack/pty reaches the descriptor through os.File.Fd(), which yields the raw
// number with nothing holding a reference on it — the refcounted alternative in
// that package is marked "Unused". So if Resize released s.mu before the ioctl,
// a Close landing in between (a client's `close`, or Registry.Reap on a session
// a tab is still watching) would close that descriptor and the kernel would
// hand the number straight back: measured on darwin, the next session's pty
// master is given the very fd the closed one had. TIOCSWINSZ would then arrive
// at another session's terminal.
//
// The window is a few instructions wide, and racing it directly is not a test:
// hammering Resize from 64 goroutines against a concurrent Close reproduced it
// in 3 runs out of 40 at GOMAXPROCS=1 and 0 out of 40 at GOMAXPROCS=4, so an
// assertion built on it would be green nine times in ten with the bug present.
// This holds the ioctl open instead, through the same package-variable seam
// killGroup uses, and asks what the lock is doing while it runs — stated as the
// behaviour that matters, which is that Close cannot get past it.
func TestResizeHoldsTheSessionLockAcrossTheIoctl(t *testing.T) {
	entered := make(chan struct{}, 1)
	release := make(chan struct{})
	letGo := sync.OnceFunc(func() { close(release) })
	defer letGo()

	orig := setWinsize
	setWinsize = func(f *os.File, ws *pty.Winsize) error {
		select {
		case entered <- struct{}{}:
		default:
		}
		<-release
		return orig(f, ws)
	}
	t.Cleanup(func() { setWinsize = orig })

	r := NewRegistry(time.Now)
	s, err := r.Spawn(SpawnOpts{Cmd: []string{"sh", "-c", "sleep 5"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })

	resized := make(chan error, 1)
	go func() { resized <- s.Resize(100, 40) }()

	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("Resize never reached the ioctl")
	}

	// The ioctl is now in flight, holding a descriptor by number. Close must
	// not be able to release that descriptor underneath it.
	closed := make(chan error, 1)
	go func() { closed <- s.Close() }()
	select {
	case err := <-closed:
		t.Fatalf("Close ran to completion while the pty ioctl was still in flight (returned %v); "+
			"the descriptor it released is the one that ioctl is holding by number, and the kernel "+
			"hands that number to the next session's master", err)
	case <-time.After(200 * time.Millisecond):
	}

	letGo()
	select {
	case err := <-resized:
		if err != nil {
			t.Errorf("Resize: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Resize never returned")
	}
	// And the lock is a pause, not a wedge: Close gets through the moment the
	// ioctl is done.
	select {
	case err := <-closed:
		if err != nil {
			t.Errorf("Close: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Close never returned once the ioctl had finished")
	}
}

// killCall is one group signal as seen by the spy. pid is the raw argument,
// so a process-group delivery shows up negated.
type killCall struct {
	pid int
	sig syscall.Signal
}

// killSpy records every group signal a session's supervisor issues, so tests
// can assert on whether one was issued at all — a property that can't be
// observed reliably from wall-clock timing or from watching a process
// disappear, especially when the point of the test is that nothing should be
// signalled.
//
// It is mutex-guarded because the signal is delivered by the session's
// supervisor goroutine, not by whichever goroutine called Close or Signal.
type killSpy struct {
	mu    sync.Mutex
	calls []killCall
}

// installKillSpy points killGroup at a recording spy that still delegates to
// the real syscall, and restores it via t.Cleanup regardless of how the test
// ends. Sessions copy killGroup at Spawn, so this must be called before the
// session under test is spawned.
func installKillSpy(t *testing.T) *killSpy {
	t.Helper()
	spy := &killSpy{}
	orig := killGroup
	killGroup = func(pid int, sig syscall.Signal) error {
		spy.mu.Lock()
		spy.calls = append(spy.calls, killCall{pid: pid, sig: sig})
		spy.mu.Unlock()
		return orig(pid, sig)
	}
	t.Cleanup(func() { killGroup = orig })
	return spy
}

func (k *killSpy) snapshot() []killCall {
	k.mu.Lock()
	defer k.mu.Unlock()
	return append([]killCall(nil), k.calls...)
}

func (k *killSpy) count() int {
	k.mu.Lock()
	defer k.mu.Unlock()
	return len(k.calls)
}

func (k *killSpy) reset() {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.calls = nil
}

// waitForKill waits for a group signal matching pid and sig to be recorded.
func (k *killSpy) waitForKill(t *testing.T, pid int, sig syscall.Signal, timeout time.Duration) {
	t.Helper()
	deadline := time.After(timeout)
	for {
		for _, c := range k.snapshot() {
			if c.pid == pid && c.sig == sig {
				return
			}
		}
		select {
		case <-deadline:
			t.Fatalf("no kill(%d, %v) within %s; recorded %v", pid, sig, timeout, k.snapshot())
		case <-time.After(5 * time.Millisecond):
		}
	}
}

// mustNotBlock runs f on another goroutine and fails the test if it has not
// returned within timeout. Every use of it here is guarding against a
// lifecycle deadlock, where the symptom is a call that never comes back
// rather than a call that returns the wrong answer.
func mustNotBlock(t *testing.T, what string, timeout time.Duration, f func()) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		defer close(done)
		f()
	}()
	select {
	case <-done:
	case <-time.After(timeout):
		t.Fatalf("%s did not return within %s", what, timeout)
	}
}

// waitExited polls (rather than sleeping a fixed interval) until s reaches
// the "exited" state. Once observed, the supervisor has already reaped the
// child: only reapIfExited returning true reaches markExited, which sets
// State, ExitCode and exitedAt in one locked section.
func waitExited(t *testing.T, s *Session, timeout time.Duration) {
	t.Helper()
	deadline := time.After(timeout)
	for s.Info().State != "exited" {
		select {
		case <-deadline:
			t.Fatalf("session did not reach \"exited\" within %s", timeout)
		case <-time.After(10 * time.Millisecond):
		}
	}
}

// waitSupervisorGone blocks until the session's supervisor has finished: the
// child reaped and its process group then observed empty. This is a strictly
// later moment than "exited", and it is the one that matters for signalling —
// a group outlives its leader, and stays signallable for as long as it does.
func waitSupervisorGone(t *testing.T, s *Session, timeout time.Duration) {
	t.Helper()
	select {
	case <-s.gone:
	case <-time.After(timeout):
		t.Fatalf("supervisor did not release the process group within %s", timeout)
	}
}

// TestSignalAfterGroupIsGoneIssuesNoSyscall guards against the pid-reuse
// hazard at the far end of a session's life. A process group pins its own id
// for as long as it has members, so signalling it after its leader is reaped
// is still safe; but once the last member goes, the kernel is free to hand
// that number to an unrelated new group — plausibly another flue session's,
// since Setsid makes every leader a group leader too. From that moment
// signalGroup's negated-pid kill must never be issued again, and Signal must
// not surface the refusal as an error the caller has to special-case, because
// there is simply nothing left to signal.
//
// Note the barrier: this waits for the group to be gone, not merely for the
// session to be "exited". Those are different moments, and only the later one
// disables signalling.
func TestSignalAfterGroupIsGoneIssuesNoSyscall(t *testing.T) {
	spy := installKillSpy(t)

	r := NewRegistry(time.Now)
	s, err := r.Spawn(SpawnOpts{Cmd: []string{"sh", "-c", "exit 0"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	waitSupervisorGone(t, s, 5*time.Second)
	if got := s.Info().State; got != "exited" {
		t.Fatalf(`State = %q after the group is gone, want "exited"`, got)
	}
	spy.reset() // natural exit alone must not have signalled anything either

	if err := s.Signal(syscall.SIGTERM); err != nil {
		t.Fatalf("Signal on a session whose group is gone returned an error the caller must handle: %v", err)
	}
	if n := spy.count(); n != 0 {
		t.Fatalf("Signal after the process group emptied issued %d group-kill syscall(s), want 0 — this would risk signalling a recycled pgid", n)
	}
}

// TestCloseAfterGroupIsGoneIssuesNoSyscallButStillTearsDown guards against the
// same pid-reuse hazard on the Close path, which is the one that matters most:
// Registry.Reap calls Close on every collected session ExitedRetention after
// it exited, and a ten-minute-stale pgid is exactly the kind that gets
// recycled. It also confirms Close still does its other jobs — releasing the
// pty and closing out any subscriber still attached — when it has nothing left
// to signal.
func TestCloseAfterGroupIsGoneIssuesNoSyscallButStillTearsDown(t *testing.T) {
	spy := installKillSpy(t)

	r := NewRegistry(time.Now)
	s, err := r.Spawn(SpawnOpts{Cmd: []string{"sh", "-c", "exit 0"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}

	waitSupervisorGone(t, s, 5*time.Second)
	spy.reset()

	sub := s.Subscribe(0)
	mustNotBlock(t, "Close on a session whose group is gone", 5*time.Second, func() {
		if err := s.Close(); err != nil {
			t.Errorf("Close: %v", err)
		}
	})

	if n := spy.count(); n != 0 {
		t.Fatalf("Close after the process group emptied issued %d group-kill syscall(s), want 0 — this would risk signalling a recycled pgid", n)
	}

	select {
	case _, ok := <-sub.C:
		if ok {
			t.Fatal("C delivered a value after Close")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Close did not close an already-attached subscriber's channel")
	}

	if _, err := s.pty.Write([]byte("x")); err == nil {
		t.Fatal("pty.Write succeeded after Close; want Close to have released the pty even when it skipped signalling")
	}
}

// TestNoGroupSignalIsIssuedBeforeTheGroupHasBeenProbed covers the one state the
// other two pid-reuse tests cannot reach: reaped, group already empty, exit not
// yet published.
//
// The supervisor publishes an exit under s.mu, which it takes with TryLock so a
// caller waiting on it can never deadlock the pair. Losing that TryLock is
// ordinary rather than exotic — the pump holds s.mu for every chunk of output —
// and the loop then comes back on the next 5 ms turn. Gating the group-empty
// probe on "the exit has been published" instead of "the child has been reaped"
// meant that in exactly those turns a signal request was served with no probe
// having run at all, against a pid the kernel had already handed back. That is
// the catastrophe the whole supervisor design exists to make unreachable, and a
// 5 ms window is still a window.
//
// The lock is held by the test to hold the supervisor in that state
// deterministically, which is the only way it can be observed: from outside,
// "reaped but unpublished" is a few microseconds long.
func TestNoGroupSignalIsIssuedBeforeTheGroupHasBeenProbed(t *testing.T) {
	spy := installKillSpy(t)

	r := NewRegistry(time.Now)
	// The sleep is not decoration: it guarantees the child is still running
	// when the lock below is taken, so the supervisor cannot have published
	// the exit already and leave this measuring nothing.
	s, err := r.Spawn(SpawnOpts{Cmd: []string{"sh", "-c", "sleep 0.1; exit 0"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}

	locked := true
	unlock := func() {
		if locked {
			locked = false
			s.mu.Unlock()
		}
	}
	defer s.Close()
	defer unlock()

	s.mu.Lock()
	if st := s.info.State; st != "running" {
		t.Fatalf("State = %q before the lock was taken, want %q; the supervisor got ahead of this test", st, "running")
	}

	// Wait for the pgid to be genuinely free. kill(-pid, 0) answers ESRCH only
	// once the leader has been reaped — a zombie is still a member of its own
	// group — and nothing else is left in the group. Only the supervisor
	// reaps, and reaping needs no lock, so this is also how the test knows the
	// supervisor is now sitting on an unpublished exit.
	deadline := time.After(5 * time.Second)
	for !s.groupGone() {
		select {
		case <-deadline:
			t.Fatal("the child's process group did not empty within 5s")
		case <-time.After(time.Millisecond):
		}
	}
	spy.reset()

	// requestGroupSignal rather than Signal, because Signal reads s.closed
	// under s.mu first and would simply block on this test's own lock. The
	// point being measured is what the supervisor does with the request, not
	// how it gets there.
	answered := make(chan error, 1)
	go func() { answered <- s.requestGroupSignal(syscall.SIGTERM) }()

	// Comfortably many supervisor turns: it is looping at reapPollMin here,
	// since every branch that fires resets the delay to it.
	time.Sleep(40 * reapPollMin)
	if n := spy.count(); n != 0 {
		t.Fatalf("the supervisor issued %d group-kill syscall(s) while the child was reaped and its group empty, want 0 — the pid is free and may already name a stranger's group: %v", n, spy.snapshot())
	}

	// Not delivered, but still answered, and answered from under the held lock.
	// Deferring the reply until the exit could be published would swap one
	// hazard for another: publishing needs s.mu, this test is holding it, and a
	// caller that waited on the reply while holding it is the deadlock the
	// TryLock exists to rule out. See the test below, which pins that on its own.
	select {
	case err := <-answered:
		if err != nil {
			t.Fatalf("requestGroupSignal returned an error the caller must handle: %v", err)
		}
	default:
		t.Fatal("the request was neither delivered nor answered while s.mu was held; a caller waiting on a reply that needs the session lock deadlocks the pair")
	}

	// Releasing the lock lets the exit be published, which retires the group
	// for good. Nothing may have been signalled along the way.
	unlock()
	waitSupervisorGone(t, s, 5*time.Second)
	if n := spy.count(); n != 0 {
		t.Fatalf("a group-kill syscall was issued after the group emptied: %v", spy.snapshot())
	}
}

// TestMasterEndedWithLiveChildKeepsSessionUsable is the regression test for
// the deadlock this package's lifecycle was redesigned to remove, and for the
// false premise that caused it.
//
// A read error on the pty master does not mean the child has exited. On Linux
// the master returns EIO the moment the last descriptor on the slave is
// released, so the wrapper-script idiom below — background the work with its
// own redirections, then `exec >/dev/null 2>&1 </dev/null` and wait — ends the
// master's stream at once while the whole process group runs on. Code that
// treats that as an exit, and reaps under the session lock, wedges the session
// (and, through Registry.Reap, every other session) for as long as the child
// lives.
//
// So the session must, in that state: keep reporting "running"; keep answering
// Info, List, Get and Reap; deliver a signal on request; and still be able to
// kill the whole group on Close.
//
// PORTABILITY: on Linux the shell below produces the early EOF for real and
// pump reports it. Darwin cannot produce it — BSD keeps the master readable
// while the session leader lives — so the test also delivers the same
// notification pump would have delivered, through the same method, which is
// what makes it meaningful on darwin. What darwin cannot cover is the pty
// behaviour itself, only the lifecycle's response to it.
func TestMasterEndedWithLiveChildKeepsSessionUsable(t *testing.T) {
	spy := installKillSpy(t)

	r := NewRegistry(time.Now)
	s, err := r.Spawn(SpawnOpts{
		Cmd: []string{"sh", "-c",
			"trap '' HUP TERM INT; sleep 30 >/dev/null 2>&1 </dev/null & " +
				"echo child-pid=$!; sleep 0.2; exec >/dev/null 2>&1 </dev/null; wait"},
		Cols: 80, Rows: 24,
	})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	sub := s.Subscribe(0)
	out := waitFor(t, sub, "child-pid=", 5*time.Second)
	s.Unsubscribe(sub)
	childPID := parseChildPID(t, out)
	leaderPID := s.pid

	// Stand in for the Linux early-EOF on platforms that cannot produce it.
	// This is the same call pump makes, so it exercises the production path
	// rather than a test-only branch.
	s.noteMasterEnded()

	// The child is alive, so the session is running, however quiet the master
	// has gone — and it has to keep answering while that is true. Every
	// sample is bounded rather than called directly, because the two failures
	// being guarded against here show up differently: reporting the exit too
	// early gives a wrong answer, while reaping under the session lock gives
	// no answer at all. Sampling for a whole second rather than once leaves
	// no room for the supervisor to lose the scheduler race and be probed
	// before it has looked at the hint; on Linux the real EOF also lands
	// partway through this window.
	stopAt := time.Now().Add(time.Second)
	for time.Now().Before(stopAt) {
		var state string
		mustNotBlock(t, "Info", 5*time.Second, func() { state = s.Info().State })
		if state != "running" {
			t.Fatalf(`State = %q while the child is still alive, want "running"`, state)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err := syscall.Kill(childPID, 0); err != nil {
		t.Fatalf("background child %d died on its own; the test proves nothing: %v", childPID, err)
	}

	// Nor may the registry be wedged: Reap takes r.mu and touches every
	// session, so one session stalled behind a wait for its child would
	// otherwise take Get, List and Spawn down with it.
	mustNotBlock(t, "Registry.List", 5*time.Second, func() { _ = r.List() })
	mustNotBlock(t, "Registry.Get", 5*time.Second, func() { _, _ = r.Get(s.ID()) })
	mustNotBlock(t, "Registry.Reap", 5*time.Second, func() { r.Reap() })

	// A signal must still reach the group. The group ignores SIGTERM, so the
	// evidence that it was delivered is the syscall itself, not a corpse.
	mustNotBlock(t, "Signal", 5*time.Second, func() {
		if err := s.Signal(syscall.SIGTERM); err != nil {
			t.Errorf("Signal: %v", err)
		}
	})
	spy.waitForKill(t, -leaderPID, syscall.SIGTERM, 5*time.Second)

	// And Close must still be able to kill the group — this is the case the
	// old code could not reach at all, because the only goroutine that could
	// have issued the kill was parked in Wait holding the session lock.
	mustNotBlock(t, "Close", 5*time.Second, func() {
		if err := s.Close(); err != nil {
			t.Errorf("Close: %v", err)
		}
	})
	spy.waitForKill(t, -leaderPID, syscall.SIGKILL, 5*time.Second)
	waitGone(t, childPID, 5*time.Second)
	waitExited(t, s, 5*time.Second)
}

// TestConcurrentCloseSignalAndRegistryOps hammers the interleaving the two
// previous rounds each got wrong in a different way: a session exiting on its
// own at the same moment something else is trying to signal or close it, while
// the registry collects and closes it underneath.
//
// Sequential "let it exit, then call Close" tests pass under any lock
// discipline and prove nothing about that interleaving. This one is checked by
// the race detector for torn state and by mustNotBlock for the deadlock, and
// it asserts the outcome that has to hold either way: the session ends up
// reaped exactly once with a coherent exited state, its subscriber's channel
// is closed exactly once, and the registry actually collects it.
//
// The clock matters. With time.Now and a ten-minute ExitedRetention, Reap
// finds nothing to collect however often it is called, so the collect-then-
// close path — the one that concurrently calls Close on a session another
// goroutine is already closing — is never entered at all. The clock below
// jumps a full retention window on every reading, which makes any Reap after
// the exit collect.
func TestConcurrentCloseSignalAndRegistryOps(t *testing.T) {
	epoch := time.Now()
	var ticks atomic.Int64
	clock := func() time.Time {
		return epoch.Add(time.Duration(ticks.Add(1)) * (ExitedRetention + time.Second))
	}

	for i := 0; i < 25; i++ {
		r := NewRegistry(clock)
		s, err := r.Spawn(SpawnOpts{Cmd: []string{"sh", "-c", "echo tick"}, Cols: 80, Rows: 24})
		if err != nil {
			t.Fatalf("Spawn: %v", err)
		}
		sub := s.Subscribe(0)

		var wg sync.WaitGroup
		start := make(chan struct{})
		wg.Add(4)
		go func() { defer wg.Done(); <-start; _ = s.Close() }()
		go func() { defer wg.Done(); <-start; _ = s.Signal(syscall.SIGTERM) }()
		go func() {
			// Keeps reaping until it has actually collected the session, so
			// the collect-then-close path is exercised inside the concurrent
			// window rather than merely being reachable in principle.
			defer wg.Done()
			<-start
			deadline := time.Now().Add(20 * time.Second)
			for {
				_ = s.Info()
				_ = r.List()
				r.Reap()
				if _, ok := r.Get(s.ID()); !ok {
					return
				}
				if time.Now().After(deadline) {
					t.Errorf("Reap never collected the exited session")
					return
				}
			}
		}()
		go func() {
			// Returns only once the subscriber's channel is closed, which
			// is itself part of what is being asserted: exactly one close,
			// no send afterwards.
			defer wg.Done()
			<-start
			for range sub.C {
			}
		}()
		close(start)

		mustNotBlock(t, "concurrent Close/Signal/registry ops", 30*time.Second, wg.Wait)
		waitExited(t, s, 5*time.Second)
	}
}

// TestGroupSignalRequestIsAnsweredWhileTheSessionLockIsHeld pins down the one
// thing inside the supervisor that a reader would not otherwise think twice
// about: it records the child's exit with a TryLock, not a Lock.
//
// The supervisor is the only thing that may signal the process group, so every
// caller has to wait for it. If it blocked on s.mu to record the exit, a
// caller holding s.mu while it waited would deadlock outright — the request
// channel has no reader until that record completes, and it cannot complete
// until the caller lets go. That is a narrow window to hit by luck, so this
// test does not try: it takes s.mu itself, holds it across the child's exit,
// and only then asks for a signal.
func TestGroupSignalRequestIsAnsweredWhileTheSessionLockIsHeld(t *testing.T) {
	r := NewRegistry(time.Now)
	s, err := r.Spawn(SpawnOpts{Cmd: []string{"sh", "-c", "exit 0"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	s.mu.Lock()
	// Long enough for the child to exit and be reaped several times over —
	// the poll starts at 5ms — while the lock the supervisor needs to record
	// that is held out of its reach.
	time.Sleep(500 * time.Millisecond)

	answered := make(chan error, 1)
	go func() { answered <- s.requestGroupSignal(syscall.SIGTERM) }()
	select {
	case err := <-answered:
		if err != nil {
			t.Errorf("requestGroupSignal: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Error("a group-signal request went unanswered while s.mu was held: " +
			"the supervisor is blocking on the session lock to record the exit, " +
			"so any caller that holds it while waiting deadlocks the pair")
	}
	s.mu.Unlock()

	waitExited(t, s, 5*time.Second)
}

// TestExitDeliversTheTailBeforeClosingSubscribers pins the ordering the CI
// flake (docs/FOLLOW-UPS.md §6) violated: a child that writes and exits in
// the same breath must have that write delivered to every subscriber before
// the exit closes their channels. Before the drain-then-drop rule the
// supervisor could reap the leader and drop every subscriber while the tail
// still sat unread in the pty buffer — subscriber closed over an empty ring
// in the test's first millisecond. The race needs the reaper to outrun the
// pump, so a single spawn rarely catches it; the loop widens the net, and
// under the fix the ordering holds by construction rather than by schedule.
func TestExitDeliversTheTailBeforeClosingSubscribers(t *testing.T) {
	for i := 0; i < 40; i++ {
		r := NewRegistry(time.Now)
		s, err := r.Spawn(SpawnOpts{
			Cmd:  []string{"sh", "-c", "echo the-whole-tail"},
			Cols: 80, Rows: 24,
		})
		if err != nil {
			t.Fatalf("Spawn: %v", err)
		}
		sub := s.Subscribe(0)
		waitFor(t, sub, "the-whole-tail", 5*time.Second)
		s.Unsubscribe(sub)
		if err := s.Close(); err != nil {
			t.Fatalf("Close: %v", err)
		}
	}
}

// TestMasterReadable exercises the poll the drain rule rests on: bytes a
// child wrote before exiting are visible on the master without being
// consumed, and a drained master reads as quiet.
func TestMasterReadable(t *testing.T) {
	master, slave, err := pty.Open()
	if err != nil {
		t.Fatalf("pty.Open: %v", err)
	}
	defer master.Close()
	defer slave.Close()

	if masterReadable(master) {
		t.Fatal("a fresh master reads as readable; the poll is measuring nothing")
	}
	if _, err := slave.Write([]byte("tail")); err != nil {
		t.Fatalf("slave write: %v", err)
	}
	if !masterReadable(master) {
		t.Fatal("bytes written on the slave are invisible to the master's poll")
	}
	buf := make([]byte, 16)
	if _, err := master.Read(buf); err != nil {
		t.Fatalf("master read: %v", err)
	}
	if masterReadable(master) {
		t.Fatal("a drained master still reads as readable")
	}
}

// TestExitWithOutOfGroupSlaveHolderClosesSubscribers pins that a leader
// exiting with a setsid'd grandchild still holding the slave — a session and
// process group of its own, so the leader's group empties at the very reap
// that arms the exit drain — closes the subscribers promptly rather than
// leaving them to the registry's ten-minute reap.
//
// Measured rather than assumed: Linux hangs the tty up when the session
// leader exits, whatever still holds a slave descriptor, so the pump drains
// and ends and is the closer here — this cannot exercise the supervisor's
// two-look fallback or the drainSettled gate on its exit, both of which are
// written for tty semantics this shape turned out not to have. They stay
// because they are cheap and the semantics are the platforms' to change;
// this test holds the observable invariant either way.
//
// Linux-only: macOS ships no setsid binary, and Darwin's leader-exit
// semantics make the shape unassemblable regardless.
func TestExitWithOutOfGroupSlaveHolderClosesSubscribers(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("needs the leader-exit tty hangup shape and the setsid binary, both Linux")
	}
	r := NewRegistry(time.Now)
	// The leader lingers a beat after echoing so Subscribe below provably
	// registers before the exit's drop visits the set — a subscriber that
	// arrives after the drop sits on an open channel by design (see
	// conn.stream's contract) and would fail this test's closure wait for
	// the wrong reason. The holder sleeps just long enough to outlive the
	// test: it is outside the group, so Close's kill cannot reach it and a
	// long sleep would linger after the run.
	s, err := r.Spawn(SpawnOpts{
		Cmd:  []string{"sh", "-c", "setsid sh -c 'exec sleep 3' & echo held-open; sleep 0.2"},
		Cols: 80, Rows: 24,
	})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	sub := s.Subscribe(0)
	waitFor(t, sub, "held-open", 5*time.Second)
	waitExited(t, s, 5*time.Second)

	// The exit is on record and nothing more is coming; the subscriber's
	// channel must close on the supervisor's cadence, not the registry's.
	deadline := time.After(3 * time.Second)
	for {
		select {
		case _, ok := <-sub.C:
			if !ok {
				return
			}
		case <-deadline:
			t.Fatal("subscriber never closed after the exit: the drain found no closer")
		}
	}
}
