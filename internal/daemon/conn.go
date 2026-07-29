package daemon

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"syscall"
	"time"

	"github.com/coder/websocket"
	"github.com/karnstack/flue/internal/session"
	"github.com/karnstack/flue/internal/wire"
)

const (
	// readLimit caps a single client frame. Keystrokes and control messages
	// are tiny; a paste is the only thing that gets near this.
	readLimit = 1 << 20

	// writeTimeout bounds one frame write, on the writer goroutine. Ten
	// seconds is far longer than a healthy loopback write and short enough
	// that a wedged peer is disconnected rather than tolerated. It bounds only
	// the writer: nothing else ever waits on a write, because everything else
	// hands frames to the outbox.
	writeTimeout = 10 * time.Second

	// outboxDepth is how many frames may be queued for one client before it is
	// dropped. It matches session.subChanDepth deliberately: a client that has
	// fallen this far behind was already going to be dropped by the session's
	// own subscriber bound, so the two limits agree on when a peer has stopped
	// keeping up rather than disagreeing by an order of magnitude.
	outboxDepth = 256

	// exitDrain is how long stream waits for silence before reporting an exit
	// it found already recorded at attach time. The exit is recorded when the
	// child is reaped, which can precede the pump's last read of the master,
	// so reporting the exit the instant it is observed would truncate the
	// final chunk of a short-lived command. The window restarts on every
	// chunk, so it bounds idleness rather than total output.
	exitDrain = 250 * time.Millisecond

	// exitReportWait bounds the wait for a state that is published a moment
	// after the event that caused it: Session.Close drops every subscriber
	// while State is still "running", and only the supervisor's next poll —
	// milliseconds later — records the exit.
	exitReportWait = 2 * time.Second

	// exitPoll is how often that wait re-reads the state. Session exposes no
	// exit channel, so this is a poll by necessity, over a bounded window.
	exitPoll = 10 * time.Millisecond
)

var (
	errConnClosed     = errors.New("daemon: connection closed")
	errConnBacklogged = errors.New("daemon: client is not draining its socket")
)

// signals is the set of signals a client may deliver, by both their canonical
// and bare names.
//
// Unknown names are refused rather than defaulted. A default turns a client
// typo into a signal the user did not ask for — "SIGSTOP" silently becoming
// SIGINT kills a job the client meant to suspend — and the daemon has no way
// to tell a typo from a capability it does not implement.
var signals = map[string]syscall.Signal{
	"SIGINT":  syscall.SIGINT,
	"INT":     syscall.SIGINT,
	"SIGTERM": syscall.SIGTERM,
	"TERM":    syscall.SIGTERM,
	"SIGHUP":  syscall.SIGHUP,
	"HUP":     syscall.SIGHUP,
	"SIGQUIT": syscall.SIGQUIT,
	"QUIT":    syscall.SIGQUIT,
	"SIGKILL": syscall.SIGKILL,
	"KILL":    syscall.SIGKILL,
}

// attachment is one client's hold on one session.
type attachment struct {
	ref uint32
	s   *session.Session
	sub *session.Sub

	// done is closed by detach. It is what tells this attachment's stream
	// goroutine that the subscriber channel closed because the client let go,
	// rather than because the session ended — the two are indistinguishable
	// from the channel alone.
	done     chan struct{}
	doneOnce sync.Once
}

func (a *attachment) release() { a.doneOnce.Do(func() { close(a.done) }) }

func (a *attachment) released() bool {
	select {
	case <-a.done:
		return true
	default:
		return false
	}
}

// frame is one queued WebSocket message.
type frame struct {
	typ websocket.MessageType
	b   []byte
}

// conn is the per-WebSocket state machine.
//
// Frames destined for this socket are produced by three different goroutines —
// this connection's read loop, its attachments' stream goroutines, and *other*
// connections broadcasting a resize or a promotion — so they are funnelled
// through a single bounded outbox drained by one writer goroutine. Sending is
// therefore a non-blocking channel send: no goroutine ever waits on this
// socket, and in particular no client's read loop can be stalled by a peer
// that has stopped reading its own.
//
// A lock would not do here. Serialising writes on a mutex bounds each
// individual write but not the wait for it: a peer parked in a ten-second
// write holds the mutex for all ten, so a broadcaster queued behind it waits
// that long before its own timeout even begins. The queue removes the wait
// entirely rather than shortening it.
type conn struct {
	ws  *websocket.Conn
	srv *Server

	// ctx bounds this connection's life, and cancel ends it. Writes are always
	// issued under this connection's own context, never under the context of
	// whichever client caused the write, so one client's disconnect cannot
	// cancel a frame owed to another.
	ctx    context.Context
	cancel context.CancelFunc

	out chan frame

	mu      sync.Mutex
	nextRef uint32
	attach  map[uint32]*attachment
}

func newConn(ctx context.Context, cancel context.CancelFunc, ws *websocket.Conn, srv *Server) *conn {
	return &conn{
		ctx:    ctx,
		cancel: cancel,
		ws:     ws,
		srv:    srv,
		out:    make(chan frame, outboxDepth),
		attach: map[uint32]*attachment{},
	}
}

func (c *conn) sendControl(msg any) error {
	b, err := wire.EncodeControl(msg)
	if err != nil {
		return err
	}
	return c.enqueue(frame{websocket.MessageText, b})
}

func (c *conn) sendBinary(typ byte, ref uint32, payload []byte) error {
	return c.enqueue(frame{websocket.MessageBinary, wire.EncodeBinary(typ, ref, payload)})
}

// enqueue hands a frame to the writer without ever blocking.
//
// A full outbox means this client has not drained outboxDepth frames while the
// writer was trying to send them, so it is dropped — the same answer, for the
// same reason, that session gives a subscriber which falls subChanDepth behind.
// The alternative, blocking, is what puts one client's fate in another's hands.
func (c *conn) enqueue(f frame) error {
	select {
	case c.out <- f:
		return nil
	case <-c.ctx.Done():
		return errConnClosed
	default:
		c.fail()
		return errConnBacklogged
	}
}

// fail tears the connection down. Cancelling the context unblocks the read
// loop, which runs the ordinary cleanup path on its way out.
func (c *conn) fail() { c.cancel() }

// runWriter is the only goroutine that writes to the socket, so frames leave
// in the order they were queued and no write can overlap another.
func (c *conn) runWriter(done chan<- struct{}) {
	defer close(done)
	for {
		select {
		case f := <-c.out:
			ctx, cancel := context.WithTimeout(c.ctx, writeTimeout)
			err := c.ws.Write(ctx, f.typ, f.b)
			cancel()
			if err != nil {
				c.fail()
				return
			}
		case <-c.ctx.Done():
			return
		}
	}
}

func (c *conn) sendError(code, msg string) {
	_ = c.sendControl(wire.Error{Code: code, Msg: msg})
}

// serve runs the read loop until the socket closes.
func (c *conn) serve() {
	writerDone := make(chan struct{})
	go c.runWriter(writerDone)
	defer func() {
		// Stop the writer and wait for it before unwinding, so nothing is
		// still writing to the socket once serve has returned and its caller
		// starts closing it.
		c.cancel()
		<-writerDone
		c.closeAll()
	}()

	_ = c.sendControl(wire.Welcome{
		DaemonID: "local",
		Host:     c.srv.hostname,
		Ver:      c.srv.version,
	})

	for {
		typ, data, err := c.ws.Read(c.ctx)
		if err != nil {
			return
		}
		if typ == websocket.MessageBinary {
			c.handleBinary(data)
			continue
		}
		msg, err := wire.DecodeControl(data)
		if err != nil {
			c.sendError("bad_message", err.Error())
			continue
		}
		c.handleControl(msg)
	}
}

func (c *conn) handleBinary(data []byte) {
	typ, ref, payload, err := wire.DecodeBinary(data)
	if err != nil {
		c.sendError("bad_frame", err.Error())
		return
	}
	if typ != wire.FrameInput {
		c.sendError("bad_frame", "clients may only send input frames")
		return
	}

	a := c.attachment(ref)
	if a == nil {
		c.sendError("bad_ref", "no such attachment")
		return
	}
	c.srv.touch(a.s.ID(), c)
	if err := a.s.Write(payload); err != nil {
		c.sendError("write_failed", err.Error())
	}
}

func (c *conn) attachment(ref uint32) *attachment {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.attach[ref]
}

// refsFor lists this connection's attachments to one session. A client may
// legitimately hold more than one, so this returns all of them rather than
// the first found.
func (c *conn) refsFor(id string) []uint32 {
	c.mu.Lock()
	defer c.mu.Unlock()
	var refs []uint32
	for ref, a := range c.attach {
		if a.s.ID() == id {
			refs = append(refs, ref)
		}
	}
	return refs
}

func (c *conn) handleControl(msg any) {
	switch m := msg.(type) {
	case wire.Hello:
		// Welcome was already sent on connect; hello is a no-op that lets
		// the client announce capabilities.

	case wire.List:
		infos := []session.Info{}
		for _, s := range c.srv.reg.List() {
			infos = append(infos, s.Info())
		}
		_ = c.sendControl(wire.Sessions{Sessions: infos})

	case wire.Spawn:
		s, err := c.srv.reg.Spawn(session.SpawnOpts{
			Cwd: m.Cwd, Cmd: m.Cmd, Cols: m.Cols, Rows: m.Rows,
		})
		if err != nil {
			c.sendError("spawn_failed", err.Error())
			return
		}
		c.attachTo(s, 0)

	case wire.Attach:
		s, ok := c.srv.reg.Get(m.ID)
		if !ok {
			c.sendError("not_found", "no such session")
			return
		}
		c.attachTo(s, m.LastSeq)

	case wire.Detach:
		c.detach(m.Ref)

	case wire.Resize:
		a := c.attachment(m.Ref)
		if a == nil {
			c.sendError("bad_ref", "no such attachment")
			return
		}
		c.srv.touch(a.s.ID(), c)
		// Only the primary owns PTY dimensions. A non-primary resize is
		// ignored unless the client is explicitly seizing primary, which
		// is what stops a phone from shrinking a laptop's view.
		if m.Primary {
			c.srv.setPrimary(a.s.ID(), c)
		}
		if !c.srv.isPrimary(a.s.ID(), c) {
			return
		}
		if err := a.s.Resize(m.Cols, m.Rows); err != nil {
			c.sendError("resize_failed", err.Error())
			return
		}
		c.srv.broadcastSize(a.s.ID(), m.Cols, m.Rows)

	case wire.Signal:
		a := c.attachment(m.Ref)
		if a == nil {
			c.sendError("bad_ref", "no such attachment")
			return
		}
		sig, ok := signals[m.Sig]
		if !ok {
			c.sendError("bad_signal", fmt.Sprintf("unsupported signal %q", m.Sig))
			return
		}
		c.srv.touch(a.s.ID(), c)
		if err := a.s.Signal(sig); err != nil {
			c.sendError("signal_failed", err.Error())
		}

	case wire.CloseSession:
		a := c.attachment(m.Ref)
		if a == nil {
			c.sendError("bad_ref", "no such attachment")
			return
		}
		_ = a.s.Close()

	default:
		c.sendError("bad_message", "unexpected message from client")
	}
}

// attachTo subscribes to s from lastSeq and starts streaming output.
func (c *conn) attachTo(s *session.Session, lastSeq uint64) {
	sub := s.Subscribe(lastSeq)

	c.mu.Lock()
	c.nextRef++
	ref := c.nextRef
	a := &attachment{ref: ref, s: s, sub: sub, done: make(chan struct{})}
	c.attach[ref] = a
	c.mu.Unlock()

	primary := c.srv.claimPrimaryIfUnset(s.ID(), c)
	info := s.Info()

	_ = c.sendControl(wire.Attached{
		Ref:       ref,
		ID:        s.ID(),
		Cols:      info.Cols,
		Rows:      info.Rows,
		Title:     info.Title,
		Seq:       sub.StartSeq,
		Truncated: sub.Truncated,
		Primary:   primary,
	})

	if len(sub.Backlog) > 0 {
		_ = c.sendBinary(wire.FrameOutput, ref, sub.Backlog)
	}

	go c.stream(a)
}

// stream forwards output until the session ends or the client lets go.
//
// Channel closure is deliberately not the only end-of-stream signal, because
// it is not a reliable one. Session.Subscribe on a session that has already
// exited — but has not yet been Closed, which Registry.Reap defers for
// ExitedRetention, ten minutes — returns an open channel that nothing will
// ever close: markExited drops the subscribers that existed when the child was
// reaped and nothing revisits the set afterwards. A loop that waited on the
// channel alone would park for those ten minutes with the client none the
// wiser. So the session's exit state is read once, up front, and drives the
// exit report from there.
//
// The two orderings are both covered because Subscribe and markExited are
// serialised on the session's own lock: either this subscription was
// registered first, in which case markExited will close its channel, or the
// exit was recorded first, in which case Info below observes it.
func (c *conn) stream(a *attachment) {
	var (
		timer *time.Timer
		drain <-chan time.Time
	)
	if a.s.Info().State == "exited" {
		timer = time.NewTimer(exitDrain)
		defer timer.Stop()
		drain = timer.C
	}

	for {
		select {
		case chunk, ok := <-a.sub.C:
			if !ok {
				c.endStream(a)
				return
			}
			if err := c.sendBinary(wire.FrameOutput, a.ref, chunk); err != nil {
				return
			}
			if timer != nil {
				// The drain measures silence, not elapsed time: as long as the
				// pump is still handing over what the master buffered before
				// the child was reaped, there is more to forward.
				timer.Reset(exitDrain)
			}
		case <-drain:
			c.endStream(a)
			return
		case <-a.done:
			return
		case <-c.ctx.Done():
			return
		}
	}
}

// endStream tells the client why the output stopped and retires the ref.
func (c *conn) endStream(a *attachment) {
	if a.released() {
		return // the client detached; it is not waiting to be told.
	}
	if info, ok := c.awaitExit(a.s); ok {
		_ = c.sendControl(wire.Exit{Ref: a.ref, Code: info.ExitCode})
	} else {
		// The session is still running, so the subscriber was dropped for
		// falling too far behind (see session.subChanDepth). Nothing is lost:
		// everything this client missed is still addressable by seq in the
		// ring. But it has to be told, or it sits in front of a terminal that
		// silently stopped updating.
		c.sendError("lagged", fmt.Sprintf(
			"attachment %d on session %s fell behind; reattach with lastSeq", a.ref, a.s.ID()))
	}
	c.detach(a.ref)
}

// awaitExit waits, briefly, for the session to publish an exit.
//
// The wait exists because the two events do not coincide: Session.Close drops
// every subscriber immediately and only then asks the supervisor to kill the
// group, so at the instant this connection's channel closes the state still
// reads "running" and will not read "exited" until the supervisor's next poll.
// Reading the state once would report no exit at all for every client-issued
// close.
func (c *conn) awaitExit(s *session.Session) (session.Info, bool) {
	deadline := time.NewTimer(exitReportWait)
	defer deadline.Stop()
	tick := time.NewTicker(exitPoll)
	defer tick.Stop()

	for {
		if info := s.Info(); info.State == "exited" {
			return info, true
		}
		select {
		case <-tick.C:
		case <-deadline.C:
			return s.Info(), false
		case <-c.ctx.Done():
			return s.Info(), false
		}
	}
}

func (c *conn) detach(ref uint32) {
	c.mu.Lock()
	a := c.attach[ref]
	delete(c.attach, ref)
	c.mu.Unlock()
	if a == nil {
		return
	}
	// Release before unsubscribing, so the stream goroutine sees a detach it
	// asked for rather than an end of stream it must report.
	a.release()
	a.s.Unsubscribe(a.sub)

	promoted := c.srv.releasePrimary(a.s.ID(), c)
	if promoted == nil {
		return
	}
	// The promoted client now owns the dimensions and has to know it, or
	// nobody resizes the PTY again.
	info := a.s.Info()
	for _, r := range promoted.refsFor(a.s.ID()) {
		_ = promoted.sendControl(wire.SizeChanged{
			Ref: r, Cols: info.Cols, Rows: info.Rows, Primary: true,
		})
	}
}

func (c *conn) closeAll() {
	c.mu.Lock()
	refs := make([]uint32, 0, len(c.attach))
	for ref := range c.attach {
		refs = append(refs, ref)
	}
	c.mu.Unlock()
	for _, ref := range refs {
		c.detach(ref)
	}
}
