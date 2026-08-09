package relay

// channel.go is the layer above the socket: one browser's Noise session per
// channel id, multiplexed over the single connection relay.go keeps up.
//
// Everything here answers one question — is this browser a device the user
// paired? The relay cannot answer it and is not asked to: it forwards opaque
// bytes, and the proof arrives as the initiator's static key coming out of a
// Noise IK handshake this process runs itself, checked against the device
// registry on this machine. A key the registry does not hold is closed, not
// served, however well-formed its handshake was.

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"runtime/debug"
	"sync"
	"time"

	"github.com/karnstack/flue/internal/crypto"
	"github.com/karnstack/flue/internal/daemon"
	"github.com/karnstack/flue/internal/relaywire"
)

const (
	// inboxDepth is how many frames may be queued for one channel before it is
	// closed. It is the daemon's own per-connection outbox depth, for the same
	// reason: a client that has not drained this many frames is not a slow
	// client, it is a gone one — and here the alternative is worse than a
	// dropped client, because the reader that would block is the one read loop
	// every other browser on this machine shares.
	inboxDepth = 256

	// handshakeDeadline bounds a channel that is announced and then says
	// nothing. The Durable Object closes such a channel at its own end
	// (relay/src/hub.ts), so this is the daemon refusing to hold a goroutine
	// and an inbox on the relay's word alone.
	handshakeDeadline = 30 * time.Second

	// maxChannels bounds the browsers one socket may carry at once.
	//
	// Every open costs a goroutine and an inbox before anything has proved
	// anything, and they arrive on a socket whose other end this daemon does not
	// run. A relay that announced them without limit would be handing this
	// process unbounded memory to allocate — the fault readLimit exists to
	// prevent, one layer up. The Durable Object caps its own client leg at 64
	// (relay/src/hub.ts, MAX_CLIENTS), so this is four times what an honest
	// relay can present and nothing an honest one ever reaches.
	maxChannels = 256

	// maxPairings bounds the pairing ceremonies this adapter will run at once.
	//
	// Each one is a goroutine that reads and rewrites the device registry, and
	// they arrive on a control channel a hostile relay could fill with them.
	// It matches the Worker's own bound on parked pairing requests
	// (relay/src/hub.ts, MAX_PENDING_PAIRS): an honest relay cannot forward
	// more than this at once, so the daemon refusing at the same number never
	// costs a real ceremony an answer.
	maxPairings = 8

	// relayPeer is what the audit log calls a pairing that arrived over the
	// relay. There is no socket address to name — the request reached this
	// daemon as a message on a socket it opened itself.
	relayPeer = "relay"
)

var (
	// errChannelGone is what a channel's reader gets when its inbox closes:
	// the browser went away, or the socket did.
	errChannelGone = errors.New("relay: the channel is gone")

	// errHandshakeStalled is a channel that was announced and never spoke.
	errHandshakeStalled = errors.New("relay: the browser did not complete its handshake")

	// errTooManyChannels is a relay announcing more browsers at once than this
	// daemon will hold. See maxChannels.
	errTooManyChannels = errors.New("relay: too many channels open at once")
)

// channel is one browser's Noise session: the bounded queue the read loop feeds
// and the goroutine that drains it.
//
// The queue is what keeps one browser's stall to itself. Frames arrive on the
// single read loop shared by every channel on this socket, so a channel that
// blocked its producer would block all of them; instead the producer never
// waits, and a channel that falls inboxDepth behind is closed.
type channel struct {
	id    uint32
	inbox chan []byte

	// credit bounds this channel's share of the socket's shared outbox — the
	// outbound mirror of the inbox above. It starts holding channelCredit
	// tokens; queueing a frame takes one (socket.enqueueData) and the socket's
	// writer returns it once the frame is written, so the channel can never
	// hold more than its allowance of the queue every other browser shares.
	credit chan struct{}

	// done is closed with the inbox. The inbox's own close is what wakes this
	// channel's readers; done is what wakes a writer parked on credit, which a
	// closed chan of tokens could not do without racing the pending returns.
	done chan struct{}

	// mu guards closed, and with it the one thing a channel of channels needs
	// guarding: close and send must not race, since sending on a closed channel
	// is a panic. Everything else about the inbox is the channel's own
	// synchronisation.
	mu     sync.Mutex
	closed bool
}

func newChannel(id uint32) *channel {
	ch := &channel{
		id:     id,
		inbox:  make(chan []byte, inboxDepth),
		credit: make(chan struct{}, channelCredit),
		done:   make(chan struct{}),
	}
	for range channelCredit {
		ch.credit <- struct{}{}
	}
	return ch
}

// deliver queues one payload without ever blocking, reporting false when the
// channel is too far behind to take it.
//
// A channel that is already closed swallows the payload and reports success:
// that is a frame for a browser that has gone, which is an ordinary crossing
// during a teardown rather than the backpressure false is reserved for.
func (c *channel) deliver(payload []byte) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return true
	}
	select {
	case c.inbox <- payload:
		return true
	default:
		return false
	}
}

// close ends the inbox, which is how every reader of it — the handshake's recv
// and the served connection's Read — learns the browser is gone. It is
// idempotent, because the browser leaving, the socket dying and the daemon
// closing the connection can all reach it, in any order.
func (c *channel) close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	c.closed = true
	close(c.inbox)
	close(c.done)
}

// --- the channel table, which belongs to one socket ---

// addChannel registers ch, refusing it once this socket has finished — a
// channel created after the teardown closed every inbox would be one nothing
// will ever close — or once it is already carrying maxChannels.
func (s *socket) addChannel(ch *channel) error {
	s.chMu.Lock()
	defer s.chMu.Unlock()
	if s.chGone {
		return errSocketClosed
	}
	if len(s.channels) >= maxChannels {
		return errTooManyChannels
	}
	s.channels[ch.id] = ch
	return nil
}

func (s *socket) channel(id uint32) *channel {
	s.chMu.Lock()
	defer s.chMu.Unlock()
	return s.channels[id]
}

// dropChannel forgets ch, but only if it is still the channel registered under
// its id: a goroutine unwinding after its id was closed and re-announced must
// not remove its successor from the table.
func (s *socket) dropChannel(ch *channel) {
	s.chMu.Lock()
	defer s.chMu.Unlock()
	if s.channels[ch.id] == ch {
		delete(s.channels, ch.id)
	}
}

// closeChannel ends whatever channel holds id, reporting whether there was one.
func (s *socket) closeChannel(id uint32) bool {
	s.chMu.Lock()
	ch := s.channels[id]
	delete(s.channels, id)
	s.chMu.Unlock()
	if ch == nil {
		return false
	}
	ch.close()
	return true
}

// closeChannels ends every channel on this socket and refuses any more.
//
// It is what a lost socket means for the layer above it. The Noise state that
// made each channel readable lives in this process's memory and this socket's
// lifetime, so a daemon that reconnects has no key for a channel opened before
// the break and the relay never re-announces one (spec/relay-protocol.md).
// Every relay client therefore sees a clean disconnect and comes back through
// its own retry path.
func (s *socket) closeChannels() {
	s.chMu.Lock()
	s.chGone = true
	live := make([]*channel, 0, len(s.channels))
	for _, ch := range s.channels {
		live = append(live, ch)
	}
	clear(s.channels)
	s.chMu.Unlock()
	for _, ch := range live {
		ch.close()
	}
}

// enqueueControl queues one control message for the relay.
func (s *socket) enqueueControl(msg any) error {
	b, err := relaywire.EncodeControl(msg)
	if err != nil {
		return err
	}
	return s.enqueue(channelFrame(relaywire.ControlChannel, b))
}

// channelFrame lays one payload out for the socket's writer.
func channelFrame(id uint32, payload []byte) outFrame {
	return outFrame{b: relaywire.Encode(relaywire.Frame{Channel: id, Payload: payload})}
}

// --- what the dispatcher does with each kind of frame ---

// openChannel answers a control open: a browser connected and was given this
// channel.
func (t *Transport) openChannel(s *socket, m *relaywire.Open) {
	if m.Channel == relaywire.ControlChannel {
		// Channel 0 is the control channel, not a browser's to be assigned.
		// There is nothing to close in reply — a close naming channel 0 would
		// be asking the relay to take the control channel away — so this is a
		// log line and a drop.
		t.log.Warn("relay announced a browser on the control channel")
		return
	}
	if m.Origin != t.cfg.Origin {
		// The origin is announced rather than assumed precisely so it can be
		// checked: a relay naming an origin this daemon did not dial is
		// misconfigured or lying, and either way no browser on it is one this
		// daemon agreed to serve.
		t.log.Warn("relay announced a channel on an origin this daemon did not dial",
			"channel", m.Channel, "origin", clip(m.Origin), "dialled", t.cfg.Origin)
		t.tell(s, relaywire.Close{Channel: m.Channel})
		return
	}
	if !t.canServeChannels() {
		// No static key to answer the handshake with, or no registry to
		// authorise against. A daemon in that state cannot serve anyone and
		// says so rather than half-running a ceremony.
		t.log.Warn("relay opened a channel on a daemon with no pairing identity", "channel", m.Channel)
		t.tell(s, relaywire.Close{Channel: m.Channel})
		return
	}
	if s.closeChannel(m.Channel) {
		// The Durable Object assigns ids from a counter it never reuses within
		// its own lifetime, so this is the two ends disagreeing about what is
		// live. They converge on "gone": the channel here is torn down and the
		// relay is asked to close the socket that id names, because serving two
		// sessions on one id is the one thing that cannot be done.
		t.log.Warn("relay re-announced a channel this daemon still holds", "channel", m.Channel)
		t.tell(s, relaywire.Close{Channel: m.Channel})
		return
	}

	ch := newChannel(m.Channel)
	switch err := s.addChannel(ch); {
	case errors.Is(err, errTooManyChannels):
		t.log.Warn("relay opened more channels at once than this daemon will carry",
			"channel", m.Channel, "holding", maxChannels)
		t.tell(s, relaywire.Close{Channel: m.Channel})
		return
	case err != nil:
		// The socket finished under this open. Its teardown has already closed
		// everything, and there is nobody left to answer.
		return
	}
	go t.serveChannel(s, ch, m.Origin)
}

// canServeChannels reports whether this daemon has what a channel needs: a
// static keypair to answer the handshake with, and a registry to look the
// initiator's key up in.
func (t *Transport) canServeChannels() bool {
	return t.devices != nil && len(t.identity.Public) == 32 && len(t.identity.Private) == 32
}

// serveChannel runs one channel's whole life: handshake, device lookup, and
// then the daemon's own connection state machine until it ends.
func (t *Transport) serveChannel(s *socket, ch *channel, origin string) {
	defer func() {
		s.dropChannel(ch)
		// Whatever ended this channel, nothing is going to read its inbox
		// again; closing it releases the dispatcher from queueing for it.
		ch.close()

		// ServeConn propagates a panic to its caller by design — the deferred
		// close is what it guarantees, not the recovery — and on the loopback
		// transport the caller is net/http, which recovers per connection. Here
		// the caller is this goroutine, and letting it through would end a
		// process that is holding every local terminal session on this machine
		// as well. So it is caught, with a stack, and costs one browser its
		// channel instead of the user their work.
		if r := recover(); r != nil {
			t.log.Error("panic while serving a relay channel",
				"channel", ch.id, "panic", r, "stack", string(debug.Stack()))
			t.tell(s, relaywire.Close{Channel: ch.id})
		}
	}()

	nch, peerStatic, err := t.handshake(s, ch)
	if err != nil {
		if errors.Is(err, errChannelGone) || errors.Is(err, errSocketClosed) {
			// The browser left, or the socket did, mid-handshake. Ordinary, and
			// there is nobody left to send a close to.
			t.log.Debug("relay channel ended during its handshake", "channel", ch.id, "err", err)
			return
		}
		t.log.Warn("relay channel handshake failed", "channel", ch.id, "err", err)
		t.tell(s, relaywire.Close{Channel: ch.id})
		return
	}

	dev, paired, err := t.devices.FindByKey(peerStatic)
	if err != nil {
		// The registry could not be read. Refusing is the only safe direction:
		// this daemon cannot tell a paired device from an unpaired one right
		// now, and it is not going to guess.
		t.log.Error("could not read the device registry for a relayed browser",
			"channel", ch.id, "err", err)
		t.tell(s, relaywire.Close{Channel: ch.id})
		return
	}
	if !paired {
		// Not an error, a state: an unpaired browser cannot attach, and pairing
		// is what makes it known. The id logged is the digest of the key it
		// presented, which is the same identity the devices screen shows — so a
		// user looking at the log can tell "a device I revoked came back" from
		// "something is knocking".
		t.log.Warn("relay channel presented an unpaired device key",
			"channel", ch.id, "device", crypto.DeviceID(peerStatic))
		t.tell(s, relaywire.Close{Channel: ch.id})
		return
	}

	t.log.Info("relay channel attached", "channel", ch.id, "device", dev.ID)
	cc := &channelConn{t: t, s: s, ch: ch, noise: nch}
	// Blocks until the connection ends. ServeConn closes cc on its way out —
	// including out of a panic — and that close is what tells the relay to drop
	// the browser's socket.
	t.srv.ServeConn(s.ctx, cc, daemon.ConnMeta{
		Peer:     relayPeer + ":" + dev.ID,
		Origin:   origin,
		DeviceID: dev.ID,
	})
	t.log.Debug("relay channel ended", "channel", ch.id, "device", dev.ID)
}

// handshake runs the Noise IK responder over this channel and returns the
// initiator's static key with it — the device identity the caller authorises.
func (t *Transport) handshake(s *socket, ch *channel) (*crypto.Channel, []byte, error) {
	deadline := time.NewTimer(handshakeDeadline)
	defer deadline.Stop()

	recv := func() ([]byte, error) {
		select {
		case payload, ok := <-ch.inbox:
			if !ok {
				return nil, errChannelGone
			}
			return payload, nil
		case <-deadline.C:
			return nil, errHandshakeStalled
		}
	}
	// The responder's message takes the channel's own credit like any data
	// frame, so the outbox accounting holds from the first byte. It can never
	// actually wait — a channel mid-handshake has written nothing, so its
	// credit is untouched — which is why the background context is honest:
	// the waits that remain are the socket's end and the channel's, both of
	// which enqueueData watches itself.
	send := func(msg []byte) error { return s.enqueueData(context.Background(), ch, msg) }
	// A nil socket context is not selected on here: a socket that ends closes
	// every inbox on its way out, which is what wakes this recv.
	return crypto.ResponderHandshake(t.identity, rand.Reader, recv, send)
}

// deliverToChannel hands one channel frame to the channel that owns it.
func (t *Transport) deliverToChannel(s *socket, f relaywire.Frame) {
	ch := s.channel(f.Channel)
	if ch == nil {
		// A frame that crossed a close in flight, or one for a channel this
		// daemon refused. Nothing is owed to either.
		t.log.Debug("relay sent a frame for a channel this daemon does not hold",
			"channel", f.Channel, "bytes", len(f.Payload))
		return
	}
	// Cloned because a decoded payload aliases the buffer the frame was read
	// into (relaywire.Decode) and this one is about to outlive that read on
	// another goroutine.
	if ch.deliver(bytes.Clone(f.Payload)) {
		return
	}
	// inboxDepth frames behind. This is the rule that makes multiplexing safe:
	// one browser is dropped rather than allowed to stall the read loop every
	// other browser on this machine is sharing.
	t.log.Warn("relay channel closed: the client is not reading its frames", "channel", f.Channel)
	s.closeChannel(f.Channel)
	t.tell(s, relaywire.Close{Channel: f.Channel})
}

// pair answers a pairing request the relay forwarded.
//
// The ceremony runs on its own goroutine because it reads and rewrites the
// device registry on disk, and the caller here is the one read loop this socket
// has: pairing inline would stall every channel on it for the length of a file
// write.
func (t *Transport) pair(s *socket, m *relaywire.Pair) {
	if m.Origin != t.cfg.Origin {
		// Answered rather than dropped — a Worker is holding a parked HTTP
		// request that would otherwise wait out its own deadline — and refused
		// without running the ceremony. A wrong token spends nothing now
		// (daemon.pairingState.redeem), but a relay lying about its origin is
		// one that can read the live token off the cleartext control channel,
		// and presenting that would spend the user's window on a device the
		// relay chose.
		t.log.Warn("relay forwarded a pairing request on an origin this daemon did not dial",
			"id", m.ID, "origin", clip(m.Origin), "dialled", t.cfg.Origin)
		t.answerPair(s, m.ID, daemon.PairRefusal())
		return
	}
	select {
	case t.pairings <- struct{}{}:
	default:
		// More ceremonies in flight than a user can be performing. The refusal
		// is the ordinary one, and it costs nothing: no window is spent, so the
		// token the real device is holding still works.
		t.log.Warn("refused a relayed pairing request: too many already in flight", "id", m.ID)
		t.answerPair(s, m.ID, daemon.PairRefusal())
		return
	}
	// The body is the browser's JSON verbatim, which the daemon's own pairing
	// path parses; decoding the control message already copied it out of the
	// read buffer.
	body := m.Body
	go func() {
		defer func() { <-t.pairings }()
		t.answerPair(s, m.ID, t.srv.PairDevice(body, relayPeer))
	}()
}

func (t *Transport) answerPair(s *socket, id uint64, out daemon.PairOutcome) {
	t.tell(s, relaywire.PairResult{ID: id, Status: out.Status, Body: out.Body})
}

// tell queues one control message for the relay, logging whatever cannot be
// sent rather than returning it: every caller here is answering a frame the
// relay sent, and there is nobody above them to hand a failure to.
func (t *Transport) tell(s *socket, msg any) {
	err := s.enqueueControl(msg)
	switch {
	case err == nil:
	case errors.Is(err, errSocketClosed), errors.Is(err, errSocketBacklogged):
		// The socket is gone or going, and everything queued for it is stale.
		t.log.Debug("dropped a control message: the relay socket is gone",
			"msg", fmt.Sprintf("%T", msg), "err", err)
	default:
		// The message could not be encoded, which is this daemon's bug rather
		// than the relay's — a pairResult whose body is not JSON above all,
		// since that leaves a browser waiting for an answer that never comes.
		t.log.Error("could not encode a control message for the relay",
			"msg", fmt.Sprintf("%T", msg), "err", err)
	}
}

// --- the connection the daemon sees ---

// channelConn is one browser's connection as the daemon's connection state
// machine sees it: an ordered stream of (text, data) messages, which on this
// transport are Noise frames on one channel of a shared socket.
//
// It is the seam daemon.MessageConn exists for. Nothing above it knows that its
// messages are multiplexed, encrypted, or that the socket carrying them was
// opened by this machine rather than by the client.
type channelConn struct {
	t     *Transport
	s     *socket
	ch    *channel
	noise *crypto.Channel

	// wmu serialises Write, because on this transport the order frames are
	// queued in has to be the order they were sealed in. Each Seal takes the
	// next nonce from the cipher state, and the receiver's Open accepts them
	// only in that order — so two writers that interleaved a seal and an
	// enqueue would deliver nonce n+1 before nonce n and end the session. The
	// daemon happens to write from one goroutine today; this makes the
	// requirement the transport's own rather than a promise it depends on.
	wmu sync.Mutex

	once sync.Once
}

var _ daemon.MessageConn = (*channelConn)(nil)

// Read returns the next message the browser sent.
func (c *channelConn) Read(ctx context.Context) (bool, []byte, error) {
	var payload []byte
	select {
	case p, ok := <-c.ch.inbox:
		if !ok {
			// The browser went away, the relay said so, or the socket died.
			// All three are a clean end of stream to the layer above.
			return false, nil, io.EOF
		}
		payload = p
	case <-ctx.Done():
		return false, nil, ctx.Err()
	}
	plain, err := c.noise.Open(payload)
	if err != nil {
		// Fatal by design. The transport underneath is ordered and reliable, so
		// a frame that does not open is tampering or replay, and there is no
		// recovery path (internal/crypto/channel.go).
		return false, nil, fmt.Errorf("relay: channel %d: %w", c.ch.id, err)
	}
	return relaywire.DecodePlain(plain)
}

// Write seals one message and queues it for the socket's writer, held to this
// channel's outbound credit.
//
// ctx is what bounds the wait for that credit. The caller is the daemon
// connection's own writer goroutine, which writes under its writeTimeout — the
// same deadline a loopback write gets — so a channel out of credit waits the
// way a loopback socket's send buffer makes a slow client wait, and the wait
// costs exactly one browser. A deadline that expires first means this channel
// has not drained its allowance in all that time: the error ends this
// connection through the daemon's ordinary teardown, the relay is told to
// close this one channel, and every sibling on the socket carries on.
func (c *channelConn) Write(ctx context.Context, text bool, data []byte) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	sealed, err := c.noise.Seal(relaywire.EncodePlain(text, data))
	if err != nil {
		return fmt.Errorf("relay: channel %d: %w", c.ch.id, err)
	}
	err = c.s.enqueueData(ctx, c.ch, sealed)
	if errors.Is(err, errChannelBacklogged) && errors.Is(err, context.DeadlineExceeded) {
		// The deadline case is the one worth a log line: this is the outbound
		// mirror of "the client is not reading its frames", and the close that
		// follows would otherwise look like an ordinary disconnect.
		c.t.log.Warn("relay channel closed: its outbound frames are not draining", "channel", c.ch.id)
	}
	return err
}

// Close ends this browser's channel: the relay is asked to close its socket,
// and the inbox is closed so anything still reading this connection stops.
//
// Idempotent and safe beside a Read or a Write, as MessageConn requires — the
// daemon closes every connection it finishes with, and a channel the relay
// already took away reaches this too.
func (c *channelConn) Close() error {
	c.once.Do(func() {
		// The relay first: the outbox is ordered, so the close leaves behind
		// everything this connection had already queued — the revoked frame a
		// disconnecting device is owed, most of all — rather than ahead of it.
		c.t.tell(c.s, relaywire.Close{Channel: c.ch.id})
		c.ch.close()
	})
	return nil
}
