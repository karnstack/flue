package daemon

import (
	"context"

	"github.com/coder/websocket"
	"github.com/karnstack/flue/internal/wire"
)

// MessageConn is one client's ordered message stream, however it reached the
// daemon. text distinguishes control JSON (true) from binary data frames.
//
// The seam exists because a WebSocket is not the only way a client arrives. A
// relayed connection is a Noise-encrypted channel multiplexed with others over
// a single socket, and from the connection state machine's point of view the
// only thing the two have in common is this: ordered messages, each either
// control or data, until one end stops.
type MessageConn interface {
	// Read blocks until the next message arrives. The implementation is
	// responsible for bounding what it will accept: the WebSocket transport
	// sets readLimit on the socket at accept, and a relay's reader has to bound
	// its own frames, because nothing past this seam does.
	Read(ctx context.Context) (text bool, data []byte, err error)
	Write(ctx context.Context, text bool, data []byte) error
	// Close ends the stream. It must be safe to call more than once and
	// safe to call concurrently with Read/Write. It need not interrupt a Read
	// already in flight — cancel the connection's context for that.
	Close() error
}

// ConnMeta identifies the peer a MessageConn speaks for.
//
// It is what the transport resolved before handing the connection over, and
// the connection never re-derives any of it: by the time a client asks to pair,
// the request that carried the origin is long gone, and the handshake that
// proved the device is over.
type ConnMeta struct {
	Peer     string // resolved peer identity, for the audit log
	Origin   string // absolute origin pairing URLs may be built from
	DeviceID string // paired device id; "" on the local transport

	// DeviceKey is the device's static public key — the thing the handshake
	// actually proved, and the identity every registry lookup that decides
	// something should be made against. Nil on the local transport, which
	// authenticates a machine-local session token rather than a device.
	//
	// It rides alongside DeviceID rather than replacing it because the two
	// answer different questions. The id is a 48-bit digest of these bytes and
	// is what the log lines, the Devices screen and the connection buckets
	// speak in; the bytes are what crypto.FindByKey compares, for the reason
	// that function spells out at length — Add deliberately permits two
	// devices with colliding digests, so an id alone can name more than one
	// key.
	DeviceKey []byte
}

// ServeConn serves one established, authenticated connection until it ends.
// It blocks. Authentication is the transport's job and is already done: this
// is the point past which every transport is the same.
//
// The one thing it re-checks is the one thing that can have changed in between:
// a device whose credential was revoked while its handshake was in flight is
// told so and not served. See the comment on the markDeviceSeen call for why
// that check has to come after the connection is registered rather than before.
//
// ctx is the caller's, and it deliberately bounds nothing here. The connection
// is parented to the server's base context instead, because the context that
// accepted it belongs to whoever handed it over — a request net/http stopped
// tracking at the hijack, or a relay's accept loop — and only baseCtx is what
// Shutdown cancels. See Server.baseCtx.
func (s *Server) ServeConn(ctx context.Context, mc MessageConn, meta ConnMeta) {
	connCtx, cancel := context.WithCancel(s.baseCtx)
	defer cancel()
	// Deferred rather than run after serve returns, because the close is what
	// hands the transport's own resources back — for a relay, a multiplexed
	// channel over a socket shared with every other device — and a panic on the
	// serve path must not be the one way out that skips it. Close is
	// contractually idempotent, so a transport that also closes on its own way
	// out is unharmed.
	defer func() { _ = mc.Close() }()

	c := newConn(connCtx, cancel, mc, s, meta.Peer, meta.Origin, meta.DeviceKey)
	// Registered before it is served and forgotten however it ends, so the
	// broadcast set is exactly the set of connections that can be written to.
	// The device it authenticated as is part of that one registration rather
	// than a step after it; see addConn for what lands in between otherwise.
	s.addConn(c, meta.DeviceID)
	defer s.removeConn(c)

	// After addConn, never before, and the ordering is the whole point.
	//
	// Revocation is two steps: remove the device from the registry, then close
	// the connections in its bucket. A connection that authenticated a moment
	// before the revoke has to be caught by exactly one of them. Registering
	// first means a revoke that is still running finds this connection in the
	// bucket and closes it; a revoke that already finished walked an empty
	// bucket, which is only possible if its removal has already landed, so the
	// registry read below cannot find the device. Checking first and registering
	// after would leave the gap where neither half sees it: a revoked credential
	// holding a live, shell-spawning connection that nothing will ever close.
	if !s.markDeviceSeen(meta.DeviceID) {
		s.refuseUnpairedDevice(connCtx, mc, meta)
		return
	}
	c.serve()
}

// refuseUnpairedDevice ends a connection whose device the registry no longer
// holds, telling it why first.
//
// The frame is the same wire.Revoked a live revocation sends, because this is
// the same event seen from the other side of a race — the client's credential
// was revoked, and whether the daemon learned it a moment before or a moment
// after the handshake is not a distinction the client can act on.
//
// Written straight to the transport rather than queued. The outbox is drained
// by the writer that conn.serve starts, and the whole point here is that this
// connection is never served; the deferred Close in ServeConn is what ends it
// once the reason has gone out. Nothing else can be writing: no writer
// goroutine was ever started for this conn.
func (s *Server) refuseUnpairedDevice(ctx context.Context, mc MessageConn, meta ConnMeta) {
	s.logger().Warn("refused a connection whose device is no longer paired",
		"peer", meta.Peer, "device", meta.DeviceID)
	b, err := wire.EncodeControl(wire.Revoked{Reason: "revoked"})
	if err != nil {
		return
	}
	writeCtx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	_ = mc.Write(writeCtx, true, b)
}

// wsMessageConn adapts a coder/websocket connection to MessageConn.
type wsMessageConn struct{ ws *websocket.Conn }

func (w wsMessageConn) Read(ctx context.Context) (bool, []byte, error) {
	typ, data, err := w.ws.Read(ctx)
	return typ == websocket.MessageText, data, err
}

func (w wsMessageConn) Write(ctx context.Context, text bool, data []byte) error {
	typ := websocket.MessageBinary
	if text {
		typ = websocket.MessageText
	}
	return w.ws.Write(ctx, typ, data)
}

// Close performs the close handshake rather than dropping the socket, which is
// what this daemon has always answered a finished connection with: a browser
// that is told the closure was normal can tell "the daemon is done with me"
// from "the connection broke". It satisfies MessageConn's contract either way —
// coder/websocket makes every call after the first a no-op, and control frames
// are serialised with data frames rather than racing them.
//
// handleWS keeps its deferred CloseNow as the backstop for the handshake a dead
// peer will never complete.
func (w wsMessageConn) Close() error { return w.ws.Close(websocket.StatusNormalClosure, "") }
