package relay

// outbound_test.go pins the outbound half of the isolation the inbound path
// has always had. Inbound, every browser owns an inboxDepth queue and a
// channel that will not drain loses itself and nothing else
// (TestRelayChannelBackpressureClosesOneChannelNotTheSocket). Outbound used to
// be shared fate: one 256-deep socket outbox for every channel, and a full
// queue was answered by failing the whole socket — so one browser attached to
// a fast session (`cat bigfile`, a build log) tore down every relayed browser
// on the machine. These tests pin the replacement: per-channel outbound
// credit, a control reserve, a keepalive lane, and the socket-level failure
// demoted to a last resort.

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/karnstack/flue/internal/daemon"
	"github.com/karnstack/flue/internal/relaywire"
)

// TestRelayOutboundCreditBoundsOneChannel is the mechanism in isolation: a
// channel may hold channelCredit frames on the shared outbox, the frame past
// that waits on the caller's own deadline, and running out costs that channel
// alone — the socket is not failed, a sibling still has its own credit, the
// control path still has its reserve, and the keepalive has its own lane.
func TestRelayOutboundCreditBoundsOneChannel(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// No writer runs over this socket, so nothing drains the outbox: every
	// queued frame stays queued, which is a writer mid-stall from the
	// producers' point of view.
	s := newSocket(ctx, cancel, nil)

	ch := newChannel(1)
	for i := range channelCredit {
		if err := s.enqueueData(context.Background(), ch, []byte("frame")); err != nil {
			t.Fatalf("frame %d, inside the channel's own credit, was refused: %v", i, err)
		}
	}

	// The frame past the allowance waits for credit, and the caller's
	// deadline is what answers it — the same deadline a loopback write gets.
	wctx, wcancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer wcancel()
	err := s.enqueueData(wctx, ch, []byte("one over"))
	if !errors.Is(err, errChannelBacklogged) {
		t.Fatalf("the frame past the channel's credit got %v, want errChannelBacklogged", err)
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("the backlog error was %v, want it to carry the deadline that decided it", err)
	}
	if cause := s.failure(); cause != nil {
		t.Fatalf("one channel over its credit failed the whole socket: %v", cause)
	}

	// The bound is the channel's, not the socket's: a sibling still writes...
	sib := newChannel(2)
	if err := s.enqueueData(context.Background(), sib, []byte("sibling")); err != nil {
		t.Fatalf("a sibling channel was refused while another was backlogged: %v", err)
	}
	// ...the control path still has room...
	if err := s.enqueue(channelFrame(relaywire.ControlChannel, []byte("{}"))); err != nil {
		t.Fatalf("a control frame was refused while one channel was backlogged: %v", err)
	}
	// ...and the keepalive cannot be starved or blamed.
	if err := s.enqueueKeepalive(); err != nil {
		t.Fatalf("the keepalive was refused while one channel was backlogged: %v", err)
	}

	// The writer draining a frame is what returns the credit.
	f := <-s.out
	f.release()
	if err := s.enqueueData(context.Background(), ch, []byte("after a drain")); err != nil {
		t.Fatalf("the channel was still refused after its credit came back: %v", err)
	}
}

// TestRelayOutboundSocketFailureIsTheLastResort: the outbox holds every
// channel's full credit plus the control reserve, so filling it completely
// takes every channel the socket will ever carry all spending everything at
// once — and even then the keepalive is unaffected. Only a control frame past
// the reserve fails the socket, which is what "the relay is not draining" is
// actually evidence of.
func TestRelayOutboundSocketFailureIsTheLastResort(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := newSocket(ctx, cancel, nil)

	for id := uint32(1); id <= maxChannels; id++ {
		ch := newChannel(id)
		for range channelCredit {
			if err := s.enqueueData(context.Background(), ch, []byte("x")); err != nil {
				t.Fatalf("channel %d was refused inside its own credit: %v", id, err)
			}
		}
	}
	for i := range controlReserve {
		if err := s.enqueue(channelFrame(relaywire.ControlChannel, []byte("{}"))); err != nil {
			t.Fatalf("control frame %d, inside the reserve, was refused: %v", i, err)
		}
	}

	if err := s.enqueueKeepalive(); err != nil {
		t.Fatalf("a completely full outbox refused the keepalive: %v", err)
	}
	if cause := s.failure(); cause != nil {
		t.Fatalf("the socket failed before the last resort was reached: %v", cause)
	}

	err := s.enqueue(channelFrame(relaywire.ControlChannel, []byte("{}")))
	if !errors.Is(err, errSocketBacklogged) {
		t.Fatalf("the control frame past the reserve got %v, want errSocketBacklogged", err)
	}
	if s.failure() == nil {
		t.Fatal("the control frame past the reserve did not fail the socket — the last resort is unreachable")
	}
}

// stashServer parks every connection it is handed and gives the test the
// MessageConn itself: the outbound mirror of readingServer's block. The
// inbound test starves a connection nobody reads; this one hands the test a
// connection to write through while the relay is not draining.
type stashServer struct {
	mu      sync.Mutex
	conns   []daemon.MessageConn
	release chan struct{}
}

func newStashServer(t *testing.T) *stashServer {
	t.Helper()
	s := &stashServer{release: make(chan struct{})}
	t.Cleanup(func() { close(s.release) })
	return s
}

func (s *stashServer) ServeConn(ctx context.Context, mc daemon.MessageConn, _ daemon.ConnMeta) {
	s.mu.Lock()
	s.conns = append(s.conns, mc)
	s.mu.Unlock()
	select {
	case <-s.release:
	case <-ctx.Done():
	}
	_ = mc.Close()
}

func (s *stashServer) PairDevice([]byte, string) daemon.PairOutcome { return daemon.PairRefusal() }

func (s *stashServer) SetRelayStatus(string, string) {}

// conn waits for the i-th connection to have been served and returns it.
func (s *stashServer) conn(t *testing.T, i int) daemon.MessageConn {
	t.Helper()
	deadline := time.Now().Add(waitFor)
	for {
		s.mu.Lock()
		var mc daemon.MessageConn
		if len(s.conns) > i {
			mc = s.conns[i]
		}
		s.mu.Unlock()
		if mc != nil {
			return mc
		}
		if time.Now().After(deadline) {
			t.Fatalf("connection %d was not served within %s", i, waitFor)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// TestRelayOutboundBackpressureFlowControlsOneChannelNotTheSocket is the
// outbound mirror of TestRelayChannelBackpressureClosesOneChannelNotTheSocket,
// and the regression test for the whole-socket teardown: one channel producing
// output flat out against a relay that is draining slower than it produces.
//
// The old design answered this a few hundred frames in with
// s.fail(errSocketBacklogged) — the socket died, and with it every relayed
// browser on the machine, cyclically. The fixed design parks the busy
// channel's writes on its own credit: the flood stalls while the relay is not
// draining, the socket stays up, and once the relay drains again every frame
// arrives, in order, with no close for a channel that was merely busy — and a
// sibling still attaches on the same socket afterwards.
func TestRelayOutboundBackpressureFlowControlsOneChannelNotTheSocket(t *testing.T) {
	t.Parallel()
	r := newFakeRelay(t, "s")
	// Reliable, so the pump blocks on a msgs queue the test is not reading —
	// which, once the TCP buffers behind it fill, is what stalls the daemon's
	// writer: the deterministic version of an uplink slower than a session.
	r.reliable = true
	id := newIdentity(t)
	srv := newStashServer(t)
	tr := newChannelTransport(t, r, srv, id, nil)
	runTransport(t, tr)

	c := r.accept(t)
	attach(t, c, 1, id.deviceKey, id.key.Public)
	mc := srv.conn(t, 0)

	// The flood: far more than the outbox, the credit, the pump's queue and
	// the TCP buffers can hold between them, so it cannot finish while
	// nothing drains — and big, incompressible frames (they are Noise
	// ciphertext), so the TCP buffers fill within a few dozen of them.
	const floodFrames = 1200
	payload := make([]byte, 256<<10)
	var wrote atomic.Int64
	floodErr := make(chan error, 1)
	go func() {
		for range floodFrames {
			// Each write under its own deadline, the way the daemon's writer
			// issues them under writeTimeout.
			wctx, wcancel := context.WithTimeout(context.Background(), waitFor)
			err := mc.Write(wctx, false, payload)
			wcancel()
			if err != nil {
				floodErr <- err
				return
			}
			wrote.Add(1)
		}
		floodErr <- nil
	}()

	// Phase 1: nothing drains. The fix is the flood parking on its channel's
	// credit with the socket still up; the bug was the socket failing instead.
	var last int64 = -1
	lastMove := time.Now()
	deadline := time.Now().Add(2 * waitFor)
	for {
		select {
		case err := <-floodErr:
			// Finishing while nothing drains is impossible, so this is the
			// old teardown surfacing: the socket was failed under the flood
			// and the write came back with the error that killed it.
			t.Fatalf("the flood ended while the relay was not draining: %v", err)
		default:
		}
		if !c.stillOpen() {
			t.Fatal("one busy channel tore down the whole socket")
		}
		if n := wrote.Load(); n != last {
			last, lastMove = n, time.Now()
		} else if n > 0 && time.Since(lastMove) > 500*time.Millisecond {
			break // parked on credit, socket alive: the isolation held
		}
		if time.Now().After(deadline) {
			t.Fatalf("the flood neither parked nor finished within %s (wrote %d)", 2*waitFor, wrote.Load())
		}
		time.Sleep(10 * time.Millisecond)
	}

	// Phase 2: the relay drains. Every frame arrives on channel 1, in order,
	// and none of the control traffic that would mean the channel was torn
	// down rather than flow-controlled.
	for seen := 0; seen < floodFrames; seen++ {
		f := c.expectFrame(t)
		if f.Channel == relaywire.ControlChannel {
			msg, _ := relaywire.DecodeControl(f.Payload)
			t.Fatalf("the daemon sent %T mid-flood, want no control traffic for a channel that is merely busy", msg)
		}
		if f.Channel != 1 {
			t.Fatalf("frame %d arrived on channel %d, want 1", seen, f.Channel)
		}
	}
	if err := <-floodErr; err != nil {
		t.Fatalf("the flood did not survive being flow-controlled: %v", err)
	}
	if !c.stillOpen() {
		t.Fatal("the socket did not survive one busy channel")
	}
	// And the socket still serves: a sibling attaches beside the busy channel.
	attach(t, c, 2, id.deviceKey, id.key.Public)
}
