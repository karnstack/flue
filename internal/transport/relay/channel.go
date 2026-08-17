package relay

// channel.go is the layer above the socket: one browser's Noise session per
// channel id, multiplexed over the single connection relay.go keeps up.
//
// Everything here answers one question — is this browser a device the user
// paired? The relay cannot answer it and is not asked to: it forwards opaque
// bytes, and the proof arrives out of a Noise IK handshake this process runs
// itself. Two proofs are accepted, in order (spec/fleet-trust.md): the
// initiator's static key is in this machine's own device registry and not on
// its revocation list, or the handshake's first message carried a device
// certificate for exactly that key, signed by the fleet key and not revoked —
// a device paired on a sibling machine, which this one then records as its
// own. A key with neither is closed, not served, however well-formed its
// handshake was.

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
	"github.com/karnstack/flue/internal/fleet"
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
		// daemon agreed to serve. There is one benign way here — `flue relay
		// address` moved this daemon to a new origin and a browser paired on
		// the old one reconnected into this refusal — and it gets the same
		// answer on purpose: the pin cannot tell yesterday's origin from a
		// hostile one, and must not try. docs/RELAY.md's custom-domain section
		// and the relay address commands now say so; the log line names the
		// way out.
		t.log.Warn("relay announced a channel on an origin this daemon did not dial; a browser paired on a former relay address must pair again on the current one",
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
	t.serving.Add(1)
	go func() {
		defer t.serving.Done()
		t.serveChannel(s, ch, m.Origin)
	}()
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

	nch, peerStatic, payload, err := t.handshake(s, ch)
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

	// Rule 1, and both halves of it: FindByKey answers "paired here, and not
	// revoked here" in one critical section (crypto.DeviceStore.FindByKey).
	// The revocation half is not belt and braces — revoking writes the
	// revocation before it removes the registry entry, so an entry that
	// outlived a half-completed revoke is exactly the case a registry-only
	// lookup would wave through.
	dev, paired, err := t.devices.FindByKey(peerStatic)
	if err != nil {
		// The registry, or the revocation list it is read against, could not
		// be read. Refusing is the only safe direction: this daemon cannot
		// tell a paired device from an unpaired or a revoked one right now,
		// and it is not going to guess.
		t.log.Error("could not read the device registry for a relayed browser",
			"channel", ch.id, "err", err)
		t.tell(s, relaywire.Close{Channel: ch.id})
		return
	}
	if !paired {
		// Rule 2 of the acceptance order: a key this machine never paired,
		// carrying a fleet device cert in its handshake payload. Rule 1 above
		// deliberately never looked at the payload — a device in the registry
		// is served cert or no cert, so pairing on this machine keeps working
		// if the fleet key ever rotates away. A revoked key reaches here too,
		// and meets the same refusal on the way through: AddFromFleetCert
		// checks the revocation list inside its own write.
		dev, paired = t.admitByFleetCert(ch, peerStatic, payload)
	} else {
		// Known, and possibly known under a name that has since changed. The
		// row's label came out of the certificate this device presented the
		// first time it arrived, and the machine that minted that certificate
		// is the only one that can correct it — so a rename there reaches here
		// only by riding the handshake, and only if somebody looks.
		//
		// Which is a *decision* to look at the payload on a path that
		// deliberately does not, so it is confined to what it is for. Admission
		// is already settled above; nothing below consults this, and the worst
		// a failure costs is a stale display name. What the payload may change
		// is one string on one row it has a fleet signature for.
		t.refreshLabel(ch, dev, peerStatic, payload)
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
		Peer:   relayPeer + ":" + dev.ID,
		Origin: origin,
		// Both identities: the id for the log lines and the connection
		// buckets, and the key the handshake actually proved for anything
		// that has to look a device up. `peerStatic` rather than
		// `dev.PublicKey` — they are equal, both lookups compared them — and
		// this says which of the two the far end demonstrated it holds.
		DeviceID:  dev.ID,
		DeviceKey: peerStatic,
	})
	t.log.Debug("relay channel ended", "channel", ch.id, "device", dev.ID)
}

// admitByFleetCert decides whether an unregistered key gets in on its
// handshake payload: a fleet device certificate that verifies under the
// fleet public key, names exactly the handshake's static key, and is not
// revoked. A yes also writes the device into this machine's registry under
// the cert's name — so the Devices screen shows it, LastSeen works, and the
// daemon keeps serving it even if the fleet key later rotates away.
//
// The refusals are all the same silent false — the caller's "unpaired
// device" close is the one answer a stranger gets, exactly as before — but
// each is its own log line first, because "a cert that does not verify" and
// "a revoked device presenting the cert it was paired with" are different
// events to whoever reads stderr.
//
// The cert names the device's key, not its holder: what proves the browser
// holds the key is the IK handshake itself, whose first message cannot be
// built without the static's private half. The cert is public by design (a
// later stage publishes it in the relay's directory), so this check must
// never treat possession of the blob as the credential — the key equality
// against the handshake's own static is the line that keeps a stolen blob
// worthless.
func (t *Transport) admitByFleetCert(ch *channel, peerStatic, payload []byte) (crypto.Device, bool) {
	if len(payload) == 0 {
		// A pre-fleet browser, or one pinned to this machine directly. Not
		// even a log line of its own: this is the ordinary unpaired refusal.
		return crypto.Device{}, false
	}
	cert, err := fleet.VerifyDevice(t.cfg.FleetPub, payload)
	if err != nil {
		t.log.Warn("relay channel presented a handshake payload that is not a verifying fleet device cert",
			"channel", ch.id, "device", crypto.DeviceID(peerStatic), "err", err)
		return crypto.Device{}, false
	}
	if !bytes.Equal(cert.Device, peerStatic) {
		// A verifying cert for some other key. The handshake proved the
		// browser holds peerStatic; the fleet vouched for a different device
		// entirely, and honouring the pair would let any holder of any
		// published cert attach as themselves.
		t.log.Warn("relay channel presented a fleet cert for a different key",
			"channel", ch.id, "device", crypto.DeviceID(peerStatic), "certDevice", crypto.DeviceID(cert.Device))
		return crypto.Device{}, false
	}

	// Signed is not the same as tame. The cert's name is authentic — the
	// fleet vouched for it — and still arbitrary: the encoding bounds it at
	// 512 bytes and permits newlines and control characters, while its
	// destination is devices.json and a row on the Devices screen. So it goes
	// through the normaliser the local pairing ceremony puts its own labels
	// through (trimmed, 64 runes, never empty), rather than a second and
	// laxer rule for names that happen to arrive over the fleet. An empty
	// name — which the minting ceremony never records but the encoding
	// allows — comes back as "unnamed device" from the same place.
	name := daemon.DeviceLabel(cert.Name)
	dev, err := t.devices.AddFromFleetCert(name, peerStatic, payload, time.Unix(cert.IAT, 0))
	switch {
	case errors.Is(err, crypto.ErrDeviceRevoked):
		// The one rule with its own sentence in the spec: a revocation
		// permanently outranks a device cert for the same key, whatever
		// either one's iat says. The check lives inside the registry write —
		// one critical section with the add — so a concurrent revoke cannot
		// land between a check here and the write.
		t.log.Warn("relay channel presented a fleet cert for a revoked key",
			"channel", ch.id, "device", crypto.DeviceID(peerStatic))
		return crypto.Device{}, false
	case err != nil:
		// The registry could not be read or written — the same refusal
		// direction FindByKey's error takes, for the same reason.
		t.log.Error("could not register a fleet-certified device",
			"channel", ch.id, "device", crypto.DeviceID(peerStatic), "err", err)
		return crypto.Device{}, false
	}
	t.log.Info("relay channel admitted a fleet-certified device",
		"channel", ch.id, "device", dev.ID, "pairedOn", cert.PairedOn)
	return dev, true
}

// refreshLabel updates a known device's row when the certificate it just
// presented names it something else.
//
// The case is a machine renaming its own browser — which it does by re-minting
// the certificate, because the name lives in the signed blob and nowhere else
// (daemon.relabelEnrolled). Every *other* machine in the fleet took its copy of
// that name from the blob the browser first showed up with, and has no way of
// its own to learn better: device certificates are never published to the
// directory, so the handshake is the only place a new one is ever seen.
//
// Everything about it is deliberately narrow, because this runs on the
// accepted-device path:
//
//   - Admission is already decided. This cannot grant, refuse or revoke; it
//     can change one string on a row the caller has already accepted.
//   - The certificate must verify under this fleet's key and must name the key
//     the handshake just proved, exactly as admission requires. A device may
//     rename itself; it may not rename somebody else.
//   - The name goes through the same normaliser admission uses, for the same
//     reason: a fleet signature makes a name authentic, not tame.
//   - Every failure is silence. A device whose name could not be updated is a
//     device with a stale label, which is what it had a moment ago.
//
// Relabel writes nothing when the label already matches, so the ordinary
// reconnect — every attach of every device, forever — costs one verify and one
// registry read and stops there.
func (t *Transport) refreshLabel(ch *channel, dev crypto.Device, peerStatic, payload []byte) {
	if len(payload) == 0 {
		return
	}
	cert, err := fleet.VerifyDevice(t.cfg.FleetPub, payload)
	if err != nil || !bytes.Equal(cert.Device, peerStatic) {
		// Not a complaint. A browser pinned straight to this machine presents
		// no cert, one from another fleet presents one that does not verify,
		// and neither is a thing to log on every reconnect — admission already
		// said this device may be here.
		return
	}
	name := daemon.DeviceLabel(cert.Name)
	if name == dev.Label {
		return
	}
	changed, err := t.devices.Relabel(peerStatic, name, payload)
	if err != nil {
		t.log.Warn("could not update a relayed device's name from its certificate",
			"channel", ch.id, "device", dev.ID, "err", err)
		return
	}
	if changed {
		t.log.Info("renamed a device from the certificate it presented",
			"channel", ch.id, "device", dev.ID, "was", dev.Label, "now", name)
	}
}

// handshake runs the Noise IK responder over this channel and returns the
// initiator's static key with it — the device identity the caller authorises
// — and message A's decrypted payload, where a fleet device cert rides when
// the initiator has one.
func (t *Transport) handshake(s *socket, ch *channel) (*crypto.Channel, []byte, []byte, error) {
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
	t.serving.Add(1)
	go func() {
		defer t.serving.Done()
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
