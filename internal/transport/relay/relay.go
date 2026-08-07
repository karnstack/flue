// Package relay is the daemon's leg of the Cloudflare relay: one outbound
// WebSocket to a Worker, and every browser that reaches this machine
// multiplexed over it.
//
// The direction is the point. The daemon binds 127.0.0.1 and nothing else, so
// remote reach cannot come from a port on this machine — it comes from a socket
// this machine opened. Everything the relay carries is defined by
// spec/relay-protocol.md and framed by internal/relaywire: binary messages are
// [4-byte channel][payload], the only text messages are the keepalives, and
// channel 0 carries the JSON control messages the relay and the daemon say to
// each other in the clear. Channels 1 and up are one browser's Noise session
// each, opaque here and served by channel.go.
//
// The adapter owns exactly one thing: keeping that socket up. It dials, reads,
// dispatches, pings, and — when the socket dies, as a socket held open across
// the internet by a hibernating Durable Object regularly does — backs off and
// dials again, forever, until its context ends.
package relay

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/flynn/noise"
	"github.com/karnstack/flue/internal/crypto"
	"github.com/karnstack/flue/internal/daemon"
	"github.com/karnstack/flue/internal/relaywire"
)

const (
	// readLimit caps one relay frame. It is twice the daemon's own per-client
	// limit: a channel payload is a Noise ciphertext wrapping a client frame
	// that was already bounded at 1 MiB, and the doubling leaves room for the
	// channel header, the kind byte and the AEAD tag without letting a hostile
	// relay hand us an unbounded allocation.
	//
	// The relay enforces that 1 MiB itself — MAX_CLIENT_MESSAGE in
	// relay/src/hub.ts, mirroring conn.go's readLimit — and the ordering is
	// load-bearing rather than tidy. coder/websocket answers an over-limit read
	// by closing the connection, and this connection is shared by every browser
	// on this machine, so a frame that trips it costs all of them at once and
	// again on the next dial. Keeping the relay's cap strictly under this one is
	// what makes an honest relay unable to do that; do not invert them.
	readLimit = 1 << 21

	// writeTimeout bounds one frame write, on the writer goroutine — the same
	// bound, for the same reason, that the daemon's own connections use. It is
	// the only place anything ever waits on this socket.
	writeTimeout = 10 * time.Second

	// outboxDepth is how many frames may be queued for the socket before it is
	// torn down. It matches the daemon's per-connection outbox: a relay that has
	// not drained this many frames is not a slow relay, it is a gone one.
	//
	// The two directions are not symmetric, and the asymmetry is the thing to
	// know before touching this number. Inbound is per-channel: every browser
	// has its own inboxDepth queue (channel.go), so one that will not drain
	// loses itself and nothing else. Outbound is *shared* — every channel's
	// writes funnel through this one queue via socket.enqueue — so a single
	// channel that produces faster than the socket drains fills it, and
	// enqueue's answer to a full outbox is s.fail(errSocketBacklogged), which
	// tears down the socket and with it every other browser on this machine.
	// 256 frames is not much cover: one browser attached to a high-rate session
	// can put that many frames in flight in milliseconds, so a TCP write stall
	// of that length is enough. The honest fix is per-channel outbound credit
	// rather than a bigger shared queue; it is a design change, and it is
	// recorded as such in docs/FOLLOW-UPS.md ("relay carry-forwards").
	outboxDepth = 256

	// dialTimeout bounds a handshake, not a connection. Without it a relay that
	// accepts the TCP connection and then says nothing parks the reconnect loop
	// indefinitely — no socket, no retry, no log line after the first.
	dialTimeout = 30 * time.Second

	// defaultKeepalive is how often the daemon sends flue-ping. Cloudflare
	// closes an idle WebSocket at around 100 s, so this has to be comfortably
	// under it; the edge answers from the Durable Object's auto-response, so
	// the cost of being under it is nearly nothing. Tests shorten it.
	defaultKeepalive = 30 * time.Second

	// staleFactor is how many keepalive intervals of total silence mean the
	// socket is dead.
	//
	// Sending pings nothing has to answer buys nothing. The edge answers every
	// flue-ping immediately and without waking the Durable Object, so silence
	// across three intervals is not a busy relay, it is a socket that is open
	// on this end only — a NAT that dropped the mapping, an edge that
	// blackholed it. Nothing else would notice: a read parks forever, the
	// daemon believes it is reachable, and remote access is silently gone until
	// something writes and TCP gives up a quarter of an hour later.
	staleFactor = 3

	// logStringLimit bounds a relay-chosen string on its way into a log line.
	// Everything the relay sends is bytes it chose, up to readLimit of them.
	logStringLimit = 120

	// Backoff between dials: 250 ms doubling to a 30 s cap, with equal jitter.
	// These are the web client's numbers (web/src/client/client.ts) because
	// they answer the same question — how fast may something that lost its
	// socket come back — and one answer is easier to reason about than two.
	backoffBase       = 250 * time.Millisecond
	backoffCap        = 30 * time.Second
	backoffMaxAttempt = 30

	// minStableConn is how long a connection has to last before the backoff
	// forgets it ever failed.
	//
	// "Reset on connect" is not enough on this leg, because connecting is not
	// the same as being kept. The Durable Object gives the daemon leg to the
	// newcomer and closes the incumbent with 4000 "replaced" (relay/src/hub.ts),
	// so two daemons pointed at one relay — the same self-hosted secret copied
	// to a second machine — each kick the other off the instant they land. With
	// the backoff reset on every such connect that is a permanent loop of four
	// to eight upgrades a second against a Worker whose free tier is 100k
	// requests a day. Requiring the socket to have lasted lets the pair escalate
	// to the 30 s cap and sit there, loudly, in the log, instead.
	minStableConn = 5 * time.Second
)

// Config is everything the adapter needs to reach a deployed relay.
//
// All four fields are required: where to dial, which machine's slot to dial
// it as, what the dial presents, and the origin the relay serves browsers on.
// The daemon and the Worker share one long-lived DAEMON_SECRET, set at deploy
// time by `flue relay setup`.
type Config struct {
	URL       string // the bare relay address: wss://flue-relay.<sub>.workers.dev
	Secret    string // the DAEMON_SECRET set at deploy time
	Origin    string // https origin the relay serves the UI on
	MachineID string // the machine's slot on the relay: the <id> of /daemon/<id>
}

// ErrIncompleteConfig is what New answers a Config it cannot dial with: a
// field missing it cannot invent, or a machine id the relay would never
// route. Wrapping rather than a sentinel per fault: the caller's decision is
// the same for all of them — this daemon is not configured for a relay — and
// the message names which field it was.
var ErrIncompleteConfig = errors.New("relay: incomplete config")

// machineIDRe is the relay's own id grammar (relay/src/index.ts, MACHINE_ID;
// the browser's records are held to the same expression in
// web/src/relay/machines.ts): one lowercase slug of 1–63 characters. New
// holds MachineID to it because the id is the path this transport dials, and
// the Worker answers anything outside the grammar with the same 404 a missing
// machine gets — minted ids are always inside it (config.MintMachineID), so
// what this catches is a relay.json edited by hand, a `machine_id: "My-Mac"`
// that would otherwise dial into "no such machine" forever while the config
// looked complete.
var machineIDRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)

// Server is the surface the adapter drives — implemented by *daemon.Server.
//
// It is declared here rather than in daemon because it is this package that
// needs it: the daemon does not know a relay exists. Two calls, because the
// relay carries two kinds of thing — a browser's connection, and the one part
// of the ceremony that is an HTTP request rather than a WebSocket message.
type Server interface {
	ServeConn(ctx context.Context, mc daemon.MessageConn, meta daemon.ConnMeta)
	// PairDevice runs the pairing ceremony on a body whose provenance this
	// package has already checked — the announced origin being the relay this
	// daemon dialled. It answers the status and JSON body the Worker writes
	// back to the browser that posted it.
	PairDevice(body []byte, peer string) daemon.PairOutcome
	// SetRelayStatus reports what this transport is doing, in the daemon's own
	// vocabulary: daemon.RelayConnecting while there is no socket, and
	// daemon.RelayConnected with the configured origin while there is one. The
	// daemon builds pairing URLs and answers welcomes out of it, so it tracks
	// the socket rather than the configuration — a relay that is configured and
	// down is one nothing can be reached through.
	SetRelayStatus(status, origin string)
}

// The daemon is the implementation, and the compiler is what keeps the two in
// step: a signature that drifts here fails to build rather than failing to
// serve.
var _ Server = (*daemon.Server)(nil)

// Transport dials the relay and serves channels until ctx ends. It reconnects
// with jittered exponential backoff and only returns when its context is done.
type Transport struct {
	cfg Config
	srv Server

	// dialURL is what the WebSocket dial actually opens: cfg.URL with
	// /daemon/<machine id> appended. Built once in New so every dial, retry
	// and log line names the same address — the id travels in the path and
	// nowhere else, no header, no query (the Worker routes on it and strips it
	// before the hub sees the request).
	dialURL string

	// identity is the daemon's static Noise key and devices is the paired-device
	// registry. Both belong to the channel layer: the responder handshake runs
	// against the key, and the static key it yields is looked up in the
	// registry, which is what decides whether a browser is a paired device.
	identity noise.DHKey
	devices  *crypto.DeviceStore

	// pairings bounds the pairing ceremonies running at once — a token, not a
	// count, taken by each and returned when it finishes. See maxPairings.
	pairings chan struct{}

	log *slog.Logger

	// keepalive is the interval between flue-ping frames, a field rather than a
	// constant so a test can watch a keepalive happen without waiting 30 s for
	// it.
	keepalive time.Duration
}

// noRedirects is the dialer this adapter uses, and the only thing it changes
// about the default one is that it does not follow redirects.
//
// A 3xx is never a valid WebSocket handshake, so nothing is lost — and
// following one can lose the daemon secret. net/http re-sends Authorization to
// the same host or any subdomain of it (shouldCopyHeaderOnRedirect compares
// hosts, never schemes), so a relay that answered the upgrade with a redirect
// to http:// on its own name would be handed the bearer token in the clear, and
// one that redirected to a subdomain would hand it to whoever owns that
// subdomain. Refusing means the dial fails and the ordinary backoff retries it.
var noRedirects = &http.Client{
	CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	},
}

// New builds a transport, or says why the configuration cannot make one. A nil
// logger discards, so a caller that has not wired one up gets a working adapter
// rather than a panic on the first log line.
//
// All three fields are required, and Origin is required for a reason worth
// stating: it is not decoration, it is the value every announced open and every
// forwarded pair is checked against (channel.go). An empty Origin makes both
// checks vacuous — a relay announcing `origin:""` matches it — and it is also
// what ConnMeta.Origin carries into the daemon, which is what pairing URLs are
// built from. A misconfigured field must fail here, at wiring time, rather than
// quietly disarming the check it exists for.
//
// URL and the secret are required for the ordinary reason: without them there
// is nothing to dial and nothing to authenticate with, so Run would do nothing
// but fail and back off forever. The machine id is the same kind of required:
// it is the path this transport dials, and without one every dial would meet
// the Worker's "no such machine" 404 while the config looked complete. Held
// to the relay's own grammar too, not merely non-empty, because an id the
// Worker will not route earns exactly that 404 with a value in the field.
func New(cfg Config, srv Server, identity noise.DHKey, devices *crypto.DeviceStore, log *slog.Logger) (*Transport, error) {
	switch {
	case cfg.URL == "":
		return nil, fmt.Errorf("%w: no URL", ErrIncompleteConfig)
	case cfg.Secret == "":
		return nil, fmt.Errorf("%w: no daemon secret", ErrIncompleteConfig)
	case cfg.Origin == "":
		return nil, fmt.Errorf("%w: no origin", ErrIncompleteConfig)
	case cfg.MachineID == "":
		return nil, fmt.Errorf("%w: no machine id", ErrIncompleteConfig)
	case !machineIDRe.MatchString(cfg.MachineID):
		// Quoted, unlike the secret nothing here may ever quote: the id is
		// public — it rides every /daemon and /client URL — and the operator
		// staring at a hand-edited relay.json needs to see which value the
		// grammar refused.
		return nil, fmt.Errorf("%w: machine id %q is not a valid slug", ErrIncompleteConfig, cfg.MachineID)
	}
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	return &Transport{
		cfg: cfg,
		srv: srv,
		// TrimRight rather than trusting the caller's spelling: relay.json
		// stores the bare origin-shaped URL, but a trailing slash typed by
		// hand must not become //daemon/<id>.
		dialURL:   strings.TrimRight(cfg.URL, "/") + "/daemon/" + cfg.MachineID,
		identity:  identity,
		devices:   devices,
		pairings:  make(chan struct{}, maxPairings),
		log:       log,
		keepalive: defaultKeepalive,
	}, nil
}

// Run dials the relay and keeps it dialled until ctx is done.
//
// It returns nil on cancellation: being asked to stop, and stopping, is not an
// error the caller has to recognise and filter out — the same contract
// daemon.ListenAndServe keeps. Every other outcome is a reason to try again, so
// nothing else ever returns from here. A relay that is down, misconfigured, or
// answering 401 while its operator rotates a secret is a temporary state, and a
// daemon that gave up on it would never come back without a restart.
func (t *Transport) Run(ctx context.Context) error {
	// Whatever ends this loop, the relay is off. Run only returns when its
	// context is done, and a status left reading "connecting" would have every
	// welcome after it announce a relay nothing is trying to reach.
	defer t.srv.SetRelayStatus(daemon.RelayOff, "")

	attempt := 0
	for {
		connectedAt, err := t.runOnce(ctx)
		if ctx.Err() != nil {
			return nil
		}

		if connectedAt.IsZero() {
			t.log.Warn("relay dial failed", "url", t.dialURL, "err", err)
		} else {
			lasted := time.Since(connectedAt)
			t.log.Info("relay connection lost",
				"url", t.dialURL, "lasted", lasted.Round(time.Millisecond), "err", err)
			if lasted >= minStableConn {
				// The socket was kept, so whatever ended it says nothing about
				// how long to wait before the next one: start from the base
				// again. A socket that was taken away immediately says the
				// opposite, and keeps its place in the escalation.
				attempt = 0
			}
		}

		delay := backoffDelay(attempt)
		if attempt < backoffMaxAttempt {
			attempt++
		}
		timer := time.NewTimer(delay)
		select {
		case <-timer.C:
		case <-ctx.Done():
			timer.Stop()
			return nil
		}
	}
}

// runOnce dials, serves the socket, and returns when it ends. connectedAt is
// when the handshake succeeded, and zero if it never did: that tells a dial
// that failed from a connection that dropped — they are logged differently —
// and how long the connection lasted, which is what the backoff resets on.
func (t *Transport) runOnce(ctx context.Context) (connectedAt time.Time, err error) {
	// The status belongs to the socket, so it starts and ends with this
	// function: dialling is "connecting", and anything that ends the connection
	// returns to it. The deferred half is what makes that immediate rather than
	// waiting out the backoff — a pairing URL handed out during a thirty-second
	// wait must not name a relay that is carrying nothing.
	t.srv.SetRelayStatus(daemon.RelayConnecting, "")
	defer t.srv.SetRelayStatus(daemon.RelayConnecting, "")

	// The dial's deadline is the dial's alone. coder/websocket applies an
	// HTTPClient timeout exactly this way — a derived context it cancels the
	// moment the handshake returns — so cancelling it here does not touch the
	// connection it produced.
	dialCtx, cancelDial := context.WithTimeout(ctx, dialTimeout)
	// Inside the dial's deadline, and inside runOnce rather than New: on the
	// hosted path this is a request to the control plane, and the credential it
	// returns is short-lived. Reading it here is what makes every dial present a
	// live one — a transport that captured a token at construction would come
	// back from its first long outage with an expired credential and back off on
	// the 401 it earned.
	bearer, err := t.bearer(dialCtx)
	if err != nil {
		cancelDial()
		return time.Time{}, err
	}
	ws, _, err := websocket.Dial(dialCtx, t.dialURL, &websocket.DialOptions{
		// The credential travels in a header, never in the URL: a URL is written
		// to logs, proxies and error messages by everything it passes through.
		HTTPHeader: http.Header{"Authorization": {"Bearer " + bearer}},
		HTTPClient: noRedirects,
	})
	cancelDial()
	if err != nil {
		return time.Time{}, err
	}
	connectedAt = time.Now()
	// Nothing past this point trusts the relay's framing, so bound what it can
	// make this process allocate before anything looks at it.
	ws.SetReadLimit(readLimit)
	// The backstop, not the close: the paths below close with a status where
	// there is one to send, and this catches the handshake a dead peer will
	// never complete.
	defer ws.CloseNow()

	// The origin is the configured one rather than anything the relay said:
	// this is the address the daemon dialled and the address it checks every
	// announced open against, so it is the only one it can honestly hand a
	// browser.
	t.srv.SetRelayStatus(daemon.RelayConnected, t.cfg.Origin)
	t.log.Info("relay connected", "url", t.dialURL)

	connCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	s := newSocket(connCtx, cancel, ws)

	writerDone := make(chan struct{})
	go t.runWriter(s, writerDone)
	keepaliveDone := make(chan struct{})
	go t.runKeepalive(s, keepaliveDone)

	readErr := t.readLoop(s)

	// The socket is finished, so every channel on it is: their Noise state was
	// this socket's, and the relay never re-announces a channel across a
	// reconnect. Closed here rather than after the writer is stopped so the
	// connections unwind while the teardown below is happening; they are not
	// waited for, because a browser's own unwinding must not delay the dial
	// that brings every other browser back.
	s.closeChannels()

	var perr protocolError
	broke := errors.As(readErr, &perr)
	if broke {
		// The relay is not speaking this protocol. Say which rule it broke in
		// the close frame — 1002 is what the Durable Object closes either leg
		// with for the same fault — and then reconnect: a Worker that was
		// mid-deploy is a different thing from a Worker that is hostile, and
		// neither is this adapter's to adjudicate.
		//
		// Written before the writer is stopped, not after. coder/websocket
		// serialises control frames with data frames on one mutex, so this
		// queues behind whatever was in flight; cancelling first would race
		// that write, and a cancelled write context closes the socket outright
		// (Conn.setupWriteTimeout), taking the close frame with it.
		t.log.Warn("relay protocol error", "url", t.dialURL, "err", readErr)
		_ = ws.Close(websocket.StatusProtocolError, "protocol error")
	}

	cancel()
	<-writerDone
	<-keepaliveDone

	// Shutdown gets no close frame, and cannot: the read this loop is parked in
	// is cancelled by the same context, and a cancelled read context closes the
	// socket (Conn.setupReadTimeout) before anything could write a goodbye onto
	// it. Nothing is owed to one either — the Durable Object tears the hub down
	// identically for a close and an error (relay/src/hub.ts, webSocketClose
	// and webSocketError), so every browser on it goes down 1012 "daemon gone"
	// either way.

	if cause := s.failure(); cause != nil && !broke {
		// The read reports whatever cancellation reached it first, which for
		// every teardown this adapter started itself is "context canceled" —
		// true, and useless to whoever is reading the log to find out why the
		// relay keeps dropping.
		readErr = cause
	}
	return connectedAt, readErr
}

// bearer is what this dial presents on the daemon leg.
//
// bearer is what a dial presents: the shared secret in relay.json. New has
// already refused a config without one, so this never returns empty — a relay
// that accepted an empty bearer would be a relay with no authentication at all.
func (t *Transport) bearer(ctx context.Context) (string, error) {
	return t.cfg.Secret, nil
}

// readLoop reads until the socket ends or the relay breaks the protocol.
func (t *Transport) readLoop(s *socket) error {
	for {
		typ, data, err := s.ws.Read(s.ctx)
		if err != nil {
			return err
		}
		// Any message at all is proof the socket is still two-ended, which is
		// what the keepalive checks against.
		s.markRead()

		if typ == websocket.MessageText {
			if string(data) == relaywire.Pong || string(data) == relaywire.Ping {
				// The keepalives, and nothing is owed to either. A pong is the
				// edge answering our ping. A ping is a leg exercising a right
				// the spec gives both of them — the daemon should never see one,
				// because the Durable Object's auto-response answers it at the
				// edge, but "should never" is not a rule to close a connection
				// over when the spec calls both strings keepalives.
				continue
			}
			// The contents are not logged: this is the branch a hostile relay
			// reaches with a megabyte of its own choosing.
			return protocolError{fmt.Errorf("relay sent a text frame that is not a keepalive (%d bytes)", len(data))}
		}
		f, err := relaywire.Decode(data)
		if err != nil {
			return protocolError{err}
		}
		t.dispatch(s, f)
	}
}

// dispatch routes one decoded frame, and never blocks.
//
// That is the whole discipline of this function. It runs on the single read
// loop every channel on this socket shares, so anything it waited on — a
// channel's inbox, a pairing ceremony's file write — would be a wait it
// imposed on every other browser on this machine. Frames go to bounded queues
// and pairings go to their own goroutine; nothing here does work.
func (t *Transport) dispatch(s *socket, f relaywire.Frame) {
	if f.Channel != relaywire.ControlChannel {
		t.deliverToChannel(s, f)
		return
	}

	msg, err := relaywire.DecodeControl(f.Payload)
	if err != nil {
		// Dropped rather than fatal. An unknown discriminator is a relay newer
		// than this daemon, which is an ordinary state during a deploy, and the
		// frames it is talking about are ones this daemon has no channel for
		// anyway.
		//
		// Clipped because the error quotes the discriminator the relay sent,
		// and that is a string of the relay's choosing up to the read limit.
		t.log.Warn("relay sent a control message this daemon does not understand",
			"err", clip(err.Error()), "bytes", len(f.Payload))
		return
	}

	switch m := msg.(type) {
	case *relaywire.Open:
		t.log.Debug("relay opened a channel", "channel", m.Channel, "origin", clip(m.Origin))
		t.openChannel(s, m)
	case *relaywire.Closed:
		// That browser went away. Its inbox is closed, which ends the
		// connection reading it; no close is sent back, because the socket this
		// would name is already gone.
		t.log.Debug("relay closed a channel", "channel", m.Channel)
		s.closeChannel(m.Channel)
	case *relaywire.Pair:
		// The body carries a live single-use pairing token, so its size is
		// logged and its contents are not.
		t.log.Debug("relay forwarded a pairing request",
			"id", m.ID, "origin", clip(m.Origin), "bytes", len(m.Body))
		t.pair(s, m)
	default:
		// close and pairResult are the daemon's own messages coming back at it.
		t.log.Warn("relay sent a message only a daemon sends", "type", fmt.Sprintf("%T", msg))
	}
}

// runWriter is the only goroutine that writes to the socket, so frames leave in
// the order they were queued and no write can overlap another.
//
// A lock would not do here, for the reason the daemon's own writer documents:
// serialising on a mutex bounds each write but not the wait for it, so a peer
// parked in a ten-second write holds up everything queued behind it for all
// ten. The queue removes the wait rather than shortening it.
func (t *Transport) runWriter(s *socket, done chan<- struct{}) {
	defer close(done)
	for {
		select {
		case f := <-s.out:
			ctx, cancel := context.WithTimeout(s.ctx, writeTimeout)
			err := s.ws.Write(ctx, f.messageType(), f.b)
			cancel()
			if err != nil {
				// The socket is gone or wedged. Ending the connection here is
				// what gets the read loop out and the reconnect started, and
				// the error is carried with it because the read loop's own
				// error will only say that something cancelled it.
				s.fail(fmt.Errorf("relay: writing to the relay: %w", err))
				return
			}
		case <-s.ctx.Done():
			return
		}
	}
}

// runKeepalive queues a flue-ping every interval.
//
// It is a producer into the outbox rather than a second writer: one goroutine
// owns the socket. The interval is well under the ~100 s at which Cloudflare
// closes an idle WebSocket, and the edge answers from the Durable Object's
// auto-response, so an idle terminal costs a matched string at the edge rather
// than a woken — and billed — Durable Object.
func (t *Transport) runKeepalive(s *socket, done chan<- struct{}) {
	defer close(done)
	tick := time.NewTicker(t.keepalive)
	defer tick.Stop()
	stale := staleFactor * t.keepalive
	for {
		select {
		case <-tick.C:
			if silence := time.Since(s.lastRead()); silence > stale {
				// Half-open: this end still has a socket and the other end
				// stopped existing. Nothing else would ever notice — a read
				// parks indefinitely — so the keepalive that goes unanswered is
				// what has to say so.
				s.fail(fmt.Errorf("%w for %s", errRelaySilent, silence.Round(time.Millisecond)))
				return
			}
			if err := s.enqueue(outFrame{text: true, b: []byte(relaywire.Ping)}); err != nil {
				return
			}
		case <-s.ctx.Done():
			return
		}
	}
}

// backoffDelay is how long to wait before attempt+1: the base doubled per
// attempt to a cap, then equal jitter — half the delay fixed, half random.
//
// The jitter is not decoration. Every browser holding a session on this daemon
// lost its socket at the same instant the daemon did, and they all come back
// through their own retry paths; a fixed delay would aim all of it at the same
// millisecond. The fixed half keeps a floor under the retry rate so a relay
// that is merely restarting is not hammered either.
func backoffDelay(attempt int) time.Duration {
	if attempt < 0 {
		attempt = 0
	}
	if attempt > backoffMaxAttempt {
		attempt = backoffMaxAttempt
	}
	// Capped before the shift, so a long outage cannot overflow the exponent
	// into a delay of nothing.
	ceiling := min(backoffBase<<attempt, backoffCap)
	return ceiling/2 + rand.N(ceiling/2)
}

// outFrame is one queued message. text says which half of the protocol it
// belongs to: the keepalives are text, and everything channel-framed is binary.
type outFrame struct {
	text bool
	b    []byte
}

func (f outFrame) messageType() websocket.MessageType {
	if f.text {
		return websocket.MessageText
	}
	return websocket.MessageBinary
}

// socket is one live relay connection: the WebSocket, the outbox every producer
// hands frames to, the channels multiplexed over it, and the context that ends
// all of it at once.
//
// It exists as a value distinct from Transport because a Transport outlives any
// number of sockets. Each reconnect gets a fresh one, and the channel table
// dies with the socket it belonged to — which is what spec/relay-protocol.md
// requires: a daemon reconnect invalidates every live channel, because the
// Noise state that made them readable was in this process's memory and this
// socket's lifetime.
type socket struct {
	ws     *websocket.Conn
	out    chan outFrame
	ctx    context.Context
	cancel context.CancelFunc

	// chMu guards the channel table. channels is every browser this socket is
	// carrying, by the id the relay assigned; chGone is set by the teardown, so
	// a channel is never registered after the sweep that would have closed it.
	chMu     sync.Mutex
	channels map[uint32]*channel
	chGone   bool

	// read is when the last message arrived, in Unix nanoseconds, which the
	// keepalive reads to tell a quiet relay from an absent one.
	read atomic.Int64

	mu sync.Mutex
	// cause is why this socket was torn down, when it was torn down from this
	// side. The read loop's own error cannot say: cancelling it is how a
	// teardown reaches it, so all it ever reports is that it was cancelled.
	cause error
}

func newSocket(ctx context.Context, cancel context.CancelFunc, ws *websocket.Conn) *socket {
	s := &socket{
		ws:       ws,
		out:      make(chan outFrame, outboxDepth),
		ctx:      ctx,
		cancel:   cancel,
		channels: map[uint32]*channel{},
	}
	// The clock starts at the handshake, not at the epoch: an idle relay must
	// not look dead the first time the keepalive checks.
	s.markRead()
	return s
}

var (
	errSocketClosed = errors.New("relay: socket closed")

	// errSocketBacklogged is what a producer gets when the relay has stopped
	// draining. The socket is torn down with it: a relay that is this far
	// behind is not slow, it is gone, and every frame queued for it is stale.
	errSocketBacklogged = errors.New("relay: the relay is not draining its socket")

	// errRelaySilent is a socket that is open on this end only.
	errRelaySilent = errors.New("relay: nothing from the relay")
)

func (s *socket) markRead() { s.read.Store(time.Now().UnixNano()) }

func (s *socket) lastRead() time.Time { return time.Unix(0, s.read.Load()) }

// enqueue hands a frame to the writer without ever blocking, so no producer
// ever waits on this socket.
func (s *socket) enqueue(f outFrame) error {
	select {
	case s.out <- f:
		return nil
	case <-s.ctx.Done():
		return errSocketClosed
	default:
		s.fail(errSocketBacklogged)
		return errSocketBacklogged
	}
}

// fail ends this connection, recording why. Cancelling the context unblocks the
// read loop, which runs the ordinary teardown on its way out.
//
// The first cause wins: what went wrong first explains everything that broke
// after it, and the teardown it starts will break several things.
func (s *socket) fail(cause error) {
	s.mu.Lock()
	if s.cause == nil {
		s.cause = cause
	}
	s.mu.Unlock()
	s.cancel()
}

// failure is why this socket was torn down from this side, or nil if it was
// not.
func (s *socket) failure() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cause
}

// clip bounds a string the relay chose on its way into a log line.
func clip(s string) string {
	if len(s) <= logStringLimit {
		return s
	}
	return s[:logStringLimit] + "…"
}

// protocolError marks the faults that are the relay's, not the network's: they
// close the socket with 1002 rather than simply dropping it, so the other end
// learns it broke the protocol instead of guessing at a connection reset.
type protocolError struct{ err error }

func (e protocolError) Error() string { return e.err.Error() }
func (e protocolError) Unwrap() error { return e.err }
