package session

import (
	"bytes"
	"errors"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
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

// TestCloseTerminatesBackgroundChildren guards against Close killing only
// the shell and leaving a background job (which inherits the shell's
// stdout/stderr on the pty slave) running: that job would keep the slave
// open, so the pump's master Read would never see a hangup, State would
// never become "exited", and the child itself would be leaked.
//
// The child sets its SIGHUP disposition to ignore (an empty shell trap
// body, inherited across its fork+exec the same way nohup works) so it does
// not incidentally die from the kernel's own hangup-on-session-leader-death
// or hangup-on-master-close delivery — both of those are SIGHUP-based and
// would otherwise mask whether Close's own kill is leader-only or
// whole-group.
func TestCloseTerminatesBackgroundChildren(t *testing.T) {
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
	if err := syscall.Kill(childPID, 0); err != nil {
		t.Fatalf("background child pid %d not running before Close: %v", childPID, err)
	}

	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	deadline := time.After(5 * time.Second)
	for s.Info().State != "exited" {
		select {
		case <-deadline:
			t.Fatal(`session never reached "exited"; a lingering background child likely kept the pty slave open`)
		case <-time.After(10 * time.Millisecond):
		}
	}

	waitGone(t, childPID, 2*time.Second)
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

// TestSignalOnReapedSessionIssuesNoSyscall guards against the pid-reuse
// hazard of signalling a session after cmd.Wait() has already reaped it:
// once reaped, the kernel is free to recycle that pid for an unrelated
// process (plausibly another session's leader, since Setsid makes every
// leader its own process-group leader too), so signalGroup's negated-pid
// kill must never be issued again. Signal must also not surface this as an
// error the caller has to special-case — there is simply nothing left to
// signal.
func TestSignalOnReapedSessionIssuesNoSyscall(t *testing.T) {
	spy := installKillSpy(t)

	r := NewRegistry(time.Now)
	s, err := r.Spawn(SpawnOpts{Cmd: []string{"sh", "-c", "exit 0"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	waitExited(t, s, 5*time.Second)
	spy.reset() // natural exit alone must not have signalled anything either

	if err := s.Signal(syscall.SIGTERM); err != nil {
		t.Fatalf("Signal on an already-exited session returned an error the caller must handle: %v", err)
	}
	if n := spy.count(); n != 0 {
		t.Fatalf("Signal on an already-exited (reaped) session issued %d group-kill syscall(s), want 0 — this would risk signalling a recycled pid", n)
	}
}

// TestCloseOnReapedSessionIssuesNoSyscallButStillTearsDown guards against
// the same pid-reuse hazard on the Close path — Registry.Reap calls Close
// on every naturally-exited session it collects, which is exactly this
// case — while confirming Close still does its other job: releasing the
// pty and closing out any subscriber that's still attached.
func TestCloseOnReapedSessionIssuesNoSyscallButStillTearsDown(t *testing.T) {
	spy := installKillSpy(t)

	r := NewRegistry(time.Now)
	s, err := r.Spawn(SpawnOpts{Cmd: []string{"sh", "-c", "exit 0"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}

	waitExited(t, s, 5*time.Second)
	spy.reset()

	sub := s.Subscribe(0)
	mustNotBlock(t, "Close on an already-reaped session", 5*time.Second, func() {
		if err := s.Close(); err != nil {
			t.Errorf("Close: %v", err)
		}
	})

	if n := spy.count(); n != 0 {
		t.Fatalf("Close on an already-exited (reaped) session issued %d group-kill syscall(s), want 0 — this would risk signalling a recycled pid", n)
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
// the registry is being read.
//
// Sequential "let it exit, then call Close" tests pass under any lock
// discipline and prove nothing about that interleaving. This one is checked by
// the race detector for torn state and by mustNotBlock for the deadlock, and
// it asserts the outcome that has to hold either way: every session ends up
// reaped exactly once, with a coherent exited state, and every subscriber's
// channel is closed.
func TestConcurrentCloseSignalAndRegistryOps(t *testing.T) {
	for i := 0; i < 25; i++ {
		r := NewRegistry(time.Now)
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
			defer wg.Done()
			<-start
			for j := 0; j < 100; j++ {
				_ = s.Info()
				_ = r.List()
				_, _ = r.Get(s.ID())
				r.Reap()
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
// ordering inside the supervisor that a reader would not otherwise think
// twice about: it publishes the reap on done *before* it takes s.mu to record
// the exit.
//
// The supervisor is the only thing that may signal the process group, so
// every caller has to wait for it. If it announced the reap only after
// recording the exit, a caller holding s.mu while it waited would deadlock
// outright — the request channel has no reader until markExited returns, and
// markExited cannot return until the caller lets go. That is a narrow window
// to hit by luck, so this test does not try: it takes s.mu itself, holds it
// across the child's exit, and only then asks for a signal.
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
			"the supervisor is publishing the reap only after it takes the lock, " +
			"so any caller holding the lock deadlocks it")
	}
	s.mu.Unlock()

	waitExited(t, s, 5*time.Second)
}
