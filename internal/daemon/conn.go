package daemon

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"syscall"
	"time"

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

// What a client is told when the device registry fails, in place of the error
// itself.
//
// The store is a file in the config directory, so its errors name that path,
// and the path names $HOME and the local username. Any paired device can
// provoke one by asking for the device list — a phone on a relayed connection
// has no business learning the account name of the machine it dials. The real
// error is not lost: it goes to the log, which is where whoever can do
// something about a broken registry is looking anyway.
//
// The distinction the client keeps is the one it can act on: a read that failed
// leaves the screen as it was, and a write that failed means the revoke it just
// asked for did not happen.
const (
	msgRegistryUnreadable = "the device registry is unavailable"
	msgRegistryUnwritable = "the device registry could not be written"
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

// frame is one queued message.
type frame struct {
	// text says which half of the protocol this frame belongs to: control
	// JSON, or a binary data frame.
	text bool
	b    []byte

	// last marks the final frame this connection will ever send: the writer
	// tears the connection down once it has been written.
	//
	// The teardown rides the queue rather than running beside it because the
	// two orderings are not equivalent. Cancelling the context next to the
	// enqueue races the frame it is meant to follow — runWriter's select would
	// be free to take ctx.Done() instead, and the write it did attempt would
	// carry an already-cancelled context — so "tell the device it was revoked,
	// then close it" would deliver the close and drop the reason. Queued, the
	// order is the order.
	last bool
}

// conn is the per-connection state machine, over whatever transport delivered
// the client: it speaks to a MessageConn and knows nothing else about it.
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
	mc  MessageConn
	srv *Server

	// peer is the resolved identity of the client on the other end of mc —
	// the socket address for the local transport, and the strongest identity
	// a purely local transport has. Remote transports resolve their own
	// identity before ServeConn and pass it in on ConnMeta.
	peer string

	// device is the paired device this connection authenticated as, or "" for
	// a connection that carries no device identity at all — which is every
	// loopback connection, since the session token names a machine's user
	// rather than a paired device.
	//
	// It is written and read only under Server.connMu, by the connection
	// registry: the field exists so a closing connection can find its own
	// bucket, and nothing else consults it.
	device string

	// origin is the absolute origin this connection's upgrade arrived on, and
	// the only thing pairing can honestly build a URL from: the second device
	// has to open an address this daemon is really reachable at. It is carried
	// on the connection rather than recomputed because the request is gone by
	// the time a pairStart arrives.
	origin string

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

func newConn(ctx context.Context, cancel context.CancelFunc, mc MessageConn, srv *Server, peer, origin string) *conn {
	return &conn{
		ctx:    ctx,
		cancel: cancel,
		mc:     mc,
		srv:    srv,
		peer:   peer,
		origin: origin,
		out:    make(chan frame, outboxDepth),
		attach: map[uint32]*attachment{},
	}
}

func (c *conn) sendControl(msg any) error {
	b, err := wire.EncodeControl(msg)
	if err != nil {
		return err
	}
	return c.enqueue(frame{text: true, b: b})
}

// sendFinal queues msg as the last thing this connection will say, and ends
// the connection once it has gone out. It is how a client is told why it is
// being disconnected rather than simply finding itself disconnected.
func (c *conn) sendFinal(msg any) error {
	b, err := wire.EncodeControl(msg)
	if err != nil {
		// The connection is meant to end either way: a frame that cannot be
		// encoded must not leave it open.
		c.fail()
		return err
	}
	return c.enqueue(frame{text: true, b: b, last: true})
}

func (c *conn) sendBinary(typ byte, ref uint32, payload []byte) error {
	return c.enqueue(frame{text: false, b: wire.EncodeBinary(typ, ref, payload)})
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
			err := c.mc.Write(ctx, f.text, f.b)
			cancel()
			if err != nil || f.last {
				// A final frame ends the connection here, on the one goroutine
				// that writes to the socket, so nothing queued behind it can
				// follow the goodbye it was supposed to conclude.
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

// sendErrorFor answers a specific request: the error echoes the client's
// reqId so the reply is matched without leaning on arrival order. A zero
// reqID marshals to nothing (omitempty), so uncorrelated requests are
// answered exactly as before.
func (c *conn) sendErrorFor(reqID uint64, code, msg string) {
	_ = c.sendControl(wire.Error{ReqID: reqID, Code: code, Msg: msg})
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
		text, data, err := c.mc.Read(c.ctx)
		if err != nil {
			return
		}
		if !text {
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
			c.sendErrorFor(m.ReqID, "spawn_failed", err.Error())
			return
		}
		c.attachTo(s, 0, m.ReqID)

	case wire.Attach:
		s, ok := c.srv.reg.Get(m.ID)
		if !ok {
			c.sendErrorFor(m.ReqID, "not_found", "no such session")
			return
		}
		c.attachTo(s, m.LastSeq, m.ReqID)

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

	case wire.Devices:
		list, err := c.srv.deviceList()
		if err != nil {
			c.srv.logger().Warn("device list unavailable", "peer", c.peer, "err", err)
			c.sendError("devices_unavailable", msgRegistryUnreadable)
			return
		}
		_ = c.sendControl(list)

	case wire.Revoke:
		c.revokeDevice(m.DeviceID)

	case wire.PairStart:
		// Reachable only from here, which is the concrete meaning of "pairing
		// is entered from an already-trusted UI": this connection has already
		// presented the session token to get its upgrade, so opening a window
		// is something only a client that was already inside can do.
		if !c.srv.pairingReady() {
			c.sendError("pairing_unavailable", "this daemon has no pairing identity")
			return
		}
		token, expires := c.srv.pairing.start(time.Now())
		c.srv.logger().Info("pairing started", "peer", c.peer, "expiresAt", expires.Unix())
		// Two parameters, and they are not the same kind of thing. `t` is the
		// single-use credential; `k` is the daemon's static public key, and it
		// is here because this URL is what the QR encodes — a screen the user
		// physically controls, read by a camera, which is the only leg of the
		// ceremony no intermediary can sit in. The device pins the key it reads
		// there and then requires the answer to its POST to match it. Learning
		// the key from that answer instead would be trust-on-first-use over
		// precisely the channel the pinned key exists to protect.
		//
		// Both are unpadded URL-safe base64 so they can be spliced in raw with
		// no escaping; see pairingState.start and Server.daemonPubParam.
		//
		// DaemonPub stays on the message as well. It is the same key in the
		// encoding the rest of the wire uses, read by a browser that is already
		// trusted, and the two are pinned to each other by test.
		_ = c.sendControl(wire.Pairing{
			Token:     token,
			URL:       c.origin + PairPagePath + "?t=" + token + "&k=" + c.srv.daemonPubParam(),
			DaemonPub: c.srv.daemonPub(),
			ExpiresAt: expires.Unix(),
		})

	case wire.PairCancel:
		// No reply: the window is closed either way, and a client that never
		// opened one is not owed an error for saying so.
		c.srv.pairing.cancel()
		c.srv.logger().Info("pairing cancelled", "peer", c.peer)

	default:
		c.sendError("bad_message", "unexpected message from client")
	}
}

// revokeDevice unpairs a device and disconnects whatever is still holding its
// credential.
//
// The order is the design. The registry is written first, so the device is
// unpaired before anything is told it was: a daemon that closed the sockets and
// then failed to write would have announced a revocation it did not perform.
// The device's own connections are ended next, because an entry removed from a
// registry nothing consults again is not a revocation — the socket already
// established is the access. Only then is the new list broadcast, so what every
// remaining client is handed is the state that is already true.
//
// Every outcome is logged. "A device was unpaired and its sessions cut" and
// "someone asked to unpair something that was not there" are both events an
// operator reading stderr needs to be able to find.
func (c *conn) revokeDevice(id string) {
	if !validDeviceID(id) {
		// Answered as unknown because it is: no device can hold an identity of
		// that shape. The id itself is deliberately not logged — only its size
		// — since this is the branch a client reaches with a megabyte of its
		// own choosing.
		c.srv.logger().Warn("revoke refused",
			"peer", c.peer, "reason", "malformed device id", "len", len(id))
		c.sendError("unknown_device", "no such device")
		return
	}

	dev, ok, err := c.srv.removeDevice(id)
	switch {
	case errors.Is(err, errNoDeviceRegistry):
		c.srv.logger().Warn("revoke refused",
			"peer", c.peer, "device", id, "reason", "no device registry")
		c.sendError("devices_unavailable", msgRegistryUnreadable)
		return
	case err != nil:
		c.srv.logger().Warn("revoke refused",
			"peer", c.peer, "device", id, "reason", "the registry could not be written", "err", err)
		c.sendError("revoke_failed", msgRegistryUnwritable)
		return
	case !ok:
		// Answered rather than ignored: a devices screen acting on a row that
		// is already gone has to learn that, and every client that can reach
		// this op is already authenticated, so the answer tells an attacker
		// nothing they could not read from the list itself.
		c.srv.logger().Warn("revoke refused",
			"peer", c.peer, "device", id, "reason", "unknown device")
		c.sendError("unknown_device", "no such device")
		return
	}

	closed := c.srv.disconnectDevice(dev.ID, "revoked")
	c.srv.logger().Info("device revoked",
		"peer", c.peer, "device", dev.ID, "label", dev.Label, "connections", closed)
	c.srv.broadcastDeviceList()
}

// attachTo subscribes to s from lastSeq and starts streaming output. reqID
// is echoed on the Attached so the client can match the reply to its request.
func (c *conn) attachTo(s *session.Session, lastSeq uint64, reqID uint64) {
	sub := s.Subscribe(lastSeq)
	// head is where the replayed backlog ends. The scrollback carries the
	// shell's own DA/DECRQM/OSC-11 probe replies, and the emulator answers
	// them again on write; the client mutes its input until it has consumed
	// head bytes so those answers never reach the shell's stdin.
	head := sub.StartSeq + uint64(len(sub.Backlog))

	c.mu.Lock()
	c.nextRef++
	ref := c.nextRef
	a := &attachment{ref: ref, s: s, sub: sub, done: make(chan struct{})}
	c.attach[ref] = a
	c.mu.Unlock()

	c.srv.logger().Info("attach", "peer", c.peer, "session", s.ID(), "ref", ref)

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
		Head:      head,
		Primary:   primary,
		ReqID:     reqID,
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
	c.srv.logger().Info("detach", "peer", c.peer, "session", a.s.ID(), "ref", ref)
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
