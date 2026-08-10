package relay

// directory.go is the daemon's leg of the relay's fleet directory: the one
// place a machine learns what the rest of its fleet has signed, and the one
// place it says what it has signed itself (spec/fleet-trust.md, "The fleet
// directory"; the routes are in spec/relay-protocol.md).
//
// Three shapes on one URL, and the daemon uses all three:
//
//	PUT  /directory   the blobs this machine holds for the fleet — its machine
//	                  cert and every revocation it knows — under the daemon
//	                  secret. Never a device cert; see `mine`.
//	GET  /directory   the whole set, on every connect, which is how a machine
//	                  that was switched off catches up.
//	WS   /directory   one binary message per new entry, which is how a machine
//	                  that is switched on hears about a revocation seconds
//	                  after the operator pressed the button.
//
// **Nothing the relay says is trusted, and the relay is not asked to check
// anything.** Every blob that arrives here — by GET or by push — is verified
// under the fleet public key before it means anything, and dropped without
// ceremony if it does not verify. That is the whole reason the directory can
// be a store the Worker cannot read: a hostile relay can serve this leg stale,
// truncated or empty, which costs availability, and cannot mint an entry,
// because minting needs the key Cloudflare never holds.
//
// The socket and the snapshot are ordered deliberately: the socket is opened
// *first* and the GET follows it. A write landing in between arrives by one
// path or the other, or both — and both is harmless, because ingest is
// idempotent all the way down (crypto.AddRevocation is by key, and
// daemon.ApplyFleetRevocation records, removes and disconnects at most once).
// The reverse order has a window in which a revocation is published, missed by
// a GET that has already been answered, and missed again by a socket that was
// not yet open.

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/flynn/noise"
	"github.com/karnstack/flue/internal/crypto"
	"github.com/karnstack/flue/internal/fleet"
	"github.com/karnstack/flue/internal/relaywire"
)

const (
	// directoryPath is the one route, for all three shapes. There is no id in
	// it: one relay is one fleet, so the Worker routes it to a single Durable
	// Object by a constant name (relay/src/index.ts, DIRECTORY_NAME).
	directoryPath = "/directory"

	// maxBlobBytes is the largest blob this daemon will look at, mirroring
	// MAX_BLOB_BYTES in relay/src/directory.ts.
	//
	// Mirrored rather than imported-in-spirit: the Worker's cap is what an
	// honest relay enforces on the way in, and this one is what this process
	// enforces on the way out of a socket it does not control. A cert is a
	// couple of hundred bytes, so anything near this is already not a
	// certificate; what the bound actually buys is that a relay cannot make
	// this daemon spend an Ed25519 verification, or an allocation, per
	// megabyte it feels like sending.
	maxBlobBytes = 4096

	// MaxDirectoryEntries is how many entries one GET may carry, mirroring
	// MAX_ENTRIES in relay/src/directory.ts. Entries past it are dropped
	// unread: the Worker refuses to store a 513th (it answers 507 rather than
	// evicting, because evicting could drop a revocation), so a longer answer
	// is not a bigger fleet, it is a relay that has stopped speaking this
	// protocol.
	//
	// Exported because it is also the number the status surfaces measure a
	// fleet against — `flue relay status` warns as the directory approaches it
	// (cmd/flue, directoryLine), and a second copy of 512 in that file would be
	// a number that could drift from the one the reader actually enforces.
	MaxDirectoryEntries = 512

	// DirectoryWarnAt is where a status surface starts saying the directory is
	// filling up: 90% of the cap.
	//
	// It exists because the cap has no gentle failure. At 512 the relay refuses
	// every new blob — and refuses it before storing and before pushing, so a
	// revocation made past that point reaches nobody at all — and nothing frees
	// an entry short of `flue relay reset`. Without a warning the first signal
	// an operator gets is a 507 in a daemon log *after* a revoke they believed
	// had crossed the fleet, which is precisely the moment it is worth least.
	DirectoryWarnAt = MaxDirectoryEntries * 9 / 10

	// maxDirectorySnapshot bounds the GET's body before anything parses it.
	// The worst honest case is MaxDirectoryEntries × maxBlobBytes of base64
	// (four bytes per three) plus the JSON around it — about 2.8 MiB — and
	// this is that with room to spare. Without it, `GET /directory` is an
	// unbounded read from a machine on the internet.
	maxDirectorySnapshot = 4 << 20

	// directoryStepTimeout bounds one PUT or one GET. Generous: the body is
	// small and the far end is a Durable Object that may be waking up.
	directoryStepTimeout = 30 * time.Second

	// publishQueueDepth is how many freshly minted artifacts may be waiting to
	// be published at once. Publishing is best-effort by contract
	// (daemon.FleetPublisher) and everything publishable is also on disk, so a
	// queue this deep overflowing costs a push that the next reconnect's
	// snapshot re-sends. Deep enough that a burst of revokes — the operator
	// clearing out a devices list — never reaches that.
	publishQueueDepth = 64

	// republishEvery is how often a connected daemon re-offers everything it
	// holds. It is the convergence backstop for the one window the reconnect
	// snapshot does not cover: a socket that stays up for days, across which a
	// single publish failed. Every PUT in it is idempotent — the directory
	// answers 200, stores nothing and pushes nothing for bytes it already has
	// — so the cost is a handful of requests an hour for a fleet-sized set.
	republishEvery = 30 * time.Minute
)

// FleetSink is what a *verified* directory artifact does to this machine.
//
// One method, because one of the three kinds of blob has a local consequence.
// A revocation is the fleet-wide kill switch and has to reach the device store
// and the live channels; a machine cert is for browsers, which read the
// directory themselves; and a device cert deliberately does nothing here — see
// ingest, which explains at length why a daemon that pre-populated its registry
// from this channel would be widening rule 1 of the acceptance order to keys
// nobody has proved they hold.
type FleetSink interface {
	// ApplyFleetRevocation records a revocation whose signature the caller has
	// already checked under the fleet public key, drops any local registry row
	// for the key, and closes that device's live channels. It must be
	// idempotent: the same revocation arrives on every reconnect.
	ApplyFleetRevocation(deviceKey, blob []byte) error
}

// DirectoryCounts is what the last read of the directory found — for the
// status surfaces, and for nothing else. Verified is the only number with any
// authority in it; Entries is what the relay claimed to be holding.
type DirectoryCounts struct {
	// Connected is whether this daemon is holding the directory socket right
	// now. The counts below are the last snapshot read *on that socket*, so
	// they are meaningless without it and are cleared with it.
	Connected   bool
	Entries     int
	Verified    int
	Machines    int
	Devices     int
	Revocations int
}

// Directory keeps this machine's view of the fleet directory up to date, and
// the directory's view of this machine.
//
// It is a sibling of Transport rather than a part of it, and the split is the
// honest one: they dial different objects for different reasons and neither
// needs the other to work. A daemon whose directory leg is down still serves
// every device paired to it; a daemon whose hub leg is down still hears
// revocations. What they share is the credential, the reconnect discipline and
// the fleet public key, which is why they share a Config.
type Directory struct {
	cfg     Config
	sink    FleetSink
	devices *crypto.DeviceStore
	log     *slog.Logger

	// noisePub is this daemon's static public key — not for the wire, but to
	// check the stored machine cert still describes this machine before
	// publishing it. See publishAll.
	noisePub []byte

	// wsURL and httpURL are the same route on the same host, reached the two
	// ways it is reachable. Both are built once, from cfg.URL alone: the
	// socket and the writes must go to the object the daemon leg dials, and
	// deriving the second from any other field would let a half-edited
	// relay.json publish this fleet's certificates somewhere else.
	wsURL   string
	httpURL string

	// pub carries freshly minted artifacts from the daemon's own goroutines
	// (a pairing ceremony, a revoke) to the publisher. Buffered and never
	// waited on: PublishFleetBlob is called from paths that are answering a
	// user.
	pub chan []byte

	// client is the HTTP client for PUT and GET. Its redirect policy is
	// noRedirects' for the same reason the socket's is: a 3xx off this host
	// would carry the daemon secret with it (net/http re-sends Authorization
	// to the same host and its subdomains).
	client *http.Client

	// keepalive is the interval between flue-pings on the push socket, a field
	// so a test need not wait 30 s to watch one.
	keepalive time.Duration

	// heard is when the last message arrived on the push socket, in Unix
	// nanoseconds — the same field, with the same job, that socket.read is on
	// the hub leg: it is what tells a quiet relay from an absent one.
	heard atomic.Int64

	mu sync.Mutex
	// seenKind is the digests this process has already ingested and what each
	// one was, so a reconnect's snapshot does not re-verify and re-apply the
	// whole fleet's history. It is an optimisation and never a correctness
	// argument — every path behind it is idempotent — which is why it may
	// simply stop growing at the directory's own ceiling rather than needing
	// an eviction policy.
	seenKind map[[32]byte]string
	counts   DirectoryCounts

	// etag is the `ETag` of the last snapshot this process read *and fully
	// applied*, and lastCounts is what that snapshot counted. Together they are
	// the conditional read: the next GET presents the tag, and a 304 means the
	// set has not changed since — so there is nothing to parse, nothing to
	// verify, and the counts still stand.
	//
	// It is worth having because this is the largest document the relay serves
	// (512 × 4 KiB of base64, about 2.8 MiB) and a daemon re-reads all of it on
	// every reconnect, where the usual answer is "nothing new".
	//
	// "Fully applied" is the load-bearing half. A snapshot in which a
	// revocation could not be handed to the sink — a registry that was
	// unreadable for a moment — leaves the tag *unset*, so the next read is
	// unconditional and tries again. Caching a tag over a failed apply would
	// turn "retry on the next connect" into "retry when somebody else next
	// publishes", and the artifact it dropped is the kill switch.
	//
	// Neither field is cleared by markUnreachable: losing the socket does not
	// make the last read untrue, and a reconnect that answers 304 needs the
	// counts that went with the tag it presented.
	etag       string
	lastCounts DirectoryCounts
}

// NewDirectory builds the directory leg for a config relay.New has already
// accepted. It takes the same three things the transport does — the config,
// the daemon's identity and the device registry — plus the sink a verified
// revocation acts on.
//
// The config's checks are relay.New's, not repeated here: this leg dials the
// same host with the same secret, and a daemon that has no relay transport has
// no directory either (cmd/flue starts them together).
func NewDirectory(cfg Config, sink FleetSink, identity noise.DHKey, devices *crypto.DeviceStore, log *slog.Logger) (*Directory, error) {
	switch {
	case cfg.URL == "":
		return nil, fmt.Errorf("%w: no URL", ErrIncompleteConfig)
	case cfg.Secret == "":
		return nil, fmt.Errorf("%w: no daemon secret", ErrIncompleteConfig)
	case len(cfg.FleetPub) != ed25519.PublicKeySize:
		// The directory is *only* signed artifacts. Without the fleet public
		// key there is nothing this leg could honestly do with a single byte
		// of what it reads, and running it anyway would be a daemon happily
		// holding a socket to a store it cannot read.
		return nil, fmt.Errorf("%w: no fleet key; re-run the join line printed by `flue relay setup` on this machine", ErrIncompleteConfig)
	case sink == nil:
		return nil, fmt.Errorf("%w: no fleet sink", ErrIncompleteConfig)
	}
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	base := strings.TrimRight(cfg.URL, "/")
	return &Directory{
		cfg:       cfg,
		sink:      sink,
		devices:   devices,
		log:       log,
		noisePub:  identity.Public,
		wsURL:     base + directoryPath,
		httpURL:   httpScheme(base) + directoryPath,
		pub:       make(chan []byte, publishQueueDepth),
		client:    noRedirects,
		keepalive: defaultKeepalive,
		seenKind:  map[[32]byte]string{},
	}, nil
}

// httpScheme rewrites a WebSocket URL as the HTTP one it is the upgrade of.
// wss and https are the same origin to every part of the stack that matters —
// the Worker serves all three shapes of /directory on one URL — and ws/http is
// the pair a test's httptest.Server speaks.
func httpScheme(url string) string {
	switch {
	case strings.HasPrefix(url, "wss://"):
		return "https://" + strings.TrimPrefix(url, "wss://")
	case strings.HasPrefix(url, "ws://"):
		return "http://" + strings.TrimPrefix(url, "ws://")
	}
	return url
}

// PublishFleetBlob queues one artifact this daemon just minted. It never
// blocks and never fails, which is daemon.FleetPublisher's contract: the
// caller is a revoke, with a client waiting and nowhere to put a network
// error.
//
// **A device certificate is dropped here, whoever offers one.** It is the only
// blob kind this leg refuses, and the refusal is a guard rather than a policy
// the callers rely on: `mine` does not publish them and the pairing ceremony
// does not either, so nothing should ever reach this line — but the cost of
// one that did is permanent (nothing in the directory is deleted one entry at
// a time) and public (`GET /directory` needs no credential, and a device cert
// names a device key and the label its owner typed). A future call site that
// forgets meets a log line here instead of a roster of the operator's devices
// on the open internet. Why they are not in the directory at all is on `mine`.
//
// The parse is a decode of bytes this daemon just signed, on the caller's
// goroutine: microseconds, and the queue send below is what must not block.
// Unparseable blobs are passed through rather than dropped — this is not a
// validator, and the directory's own readers verify everything they ingest.
//
// A full queue drops the blob with a log line rather than waiting. That is
// safe for exactly one reason, and it is worth naming: everything publishable
// is written to disk first — the revocation into revocations.json, the machine
// cert into relay.json — and publishAll re-offers all of it on every connect
// and every republishEvery. A dropped push costs latency, never the artifact.
func (d *Directory) PublishFleetBlob(blob []byte) {
	if len(blob) == 0 {
		return
	}
	if cert, err := fleet.Verify(d.cfg.FleetPub, blob); err == nil {
		if _, isDevice := cert.(fleet.DeviceCert); isDevice {
			d.log.Warn("refused to publish a device certificate to the fleet directory; device certificates go to the device that owns them, in the pairing answer and in every welcome")
			return
		}
	}
	select {
	case d.pub <- bytes.Clone(blob):
	default:
		d.log.Warn("dropped a fleet artifact from the publish queue; it will be re-offered on the next directory connect",
			"bytes", len(blob))
	}
}

// Counts is the last read of the directory, for the status surfaces.
func (d *Directory) Counts() DirectoryCounts {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.counts
}

// Run holds the directory socket and keeps this machine converged with the
// fleet until ctx is done.
//
// The shape is Transport.Run's, deliberately and not by accident: the same
// jittered backoff, the same stable-connection rule that stops two daemons
// fighting over one leg from hammering a Worker with a 100k-request day, and
// the same "cancellation is not an error" contract. Two legs to one relay that
// reconnected on two different disciplines would be two things to reason about
// during the same outage.
func (d *Directory) Run(ctx context.Context) error {
	attempt := 0
	for {
		connectedAt, err := d.runOnce(ctx)
		if ctx.Err() != nil {
			return nil
		}
		if connectedAt.IsZero() {
			d.log.Warn("fleet directory dial failed", "url", d.wsURL, "err", err)
			d.markUnreachable()
		} else {
			lasted := time.Since(connectedAt)
			d.log.Info("fleet directory connection lost",
				"url", d.wsURL, "lasted", lasted.Round(time.Millisecond), "err", err)
			d.markUnreachable()
			if lasted >= minStableConn {
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

// runOnce holds one directory connection: the socket, the catch-up read, the
// publish of everything this machine holds, and then the pushes until it ends.
func (d *Directory) runOnce(ctx context.Context) (connectedAt time.Time, err error) {
	dialCtx, cancelDial := context.WithTimeout(ctx, dialTimeout)
	ws, _, err := websocket.Dial(dialCtx, d.wsURL, &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": {"Bearer " + d.cfg.Secret}},
		HTTPClient: noRedirects,
	})
	cancelDial()
	if err != nil {
		return time.Time{}, err
	}
	connectedAt = time.Now()
	// The silence clock starts at the handshake, not at the epoch: an idle
	// directory must not look dead the first time the keepalive checks.
	d.markHeard()
	d.markConnected()
	// One push is one blob and nothing else — no envelope, no key (see
	// relay/src/directory.ts, push) — so the blob cap is the frame cap. A
	// relay that sends more than a certificate can be is not one this daemon
	// keeps reading from.
	ws.SetReadLimit(maxBlobBytes)
	defer ws.CloseNow()
	d.log.Info("fleet directory connected", "url", d.wsURL)

	connCtx, cancel := context.WithCancel(ctx)

	// Reading before the snapshot, so a write that lands between the two is
	// caught by the socket. The reader owns the connection's lifetime: when it
	// returns, this connection is over.
	readErr := make(chan error, 1)
	go func() { readErr <- d.readLoop(connCtx, ws) }()

	// The HTTP half runs on its own goroutine, and that is not tidiness. A PUT
	// or a GET to a Durable Object that has to wake up takes as long as it
	// takes, and this loop is also the only thing sending keepalives: a
	// publish on the same goroutine would put the socket's liveness behind an
	// unrelated request, which is how an honest slow relay ends up being
	// declared silent. Only this goroutine writes to the socket, so the two
	// cannot race either.
	pubDone := make(chan struct{})
	go func() {
		defer close(pubDone)
		d.ingestSnapshot(connCtx)
		d.publishAll(connCtx)
		republish := time.NewTicker(republishEvery)
		defer republish.Stop()
		for {
			select {
			case blob := <-d.pub:
				d.publish(connCtx, blob)
			case <-republish.C:
				d.publishAll(connCtx)
			case <-connCtx.Done():
				return
			}
		}
	}()
	// Cancel first, then wait: the publisher's requests are bounded by
	// connCtx, so cancelling is what ends one in flight.
	defer func() {
		cancel()
		<-pubDone
	}()

	ping := time.NewTicker(d.keepalive)
	defer ping.Stop()
	stale := staleFactor * d.keepalive

	for {
		select {
		case err := <-readErr:
			return connectedAt, err
		case <-ping.C:
			if silence := time.Since(d.lastHeard()); silence > stale {
				// Half-open: this end still has a socket and the other end
				// stopped existing. The edge answers every flue-ping from the
				// Durable Object's auto-response without waking it, so silence
				// across three intervals is not a busy relay — it is a socket
				// nothing is on the other end of, which nothing else would
				// ever notice.
				return connectedAt, fmt.Errorf("%w for %s", errRelaySilent, silence.Round(time.Millisecond))
			}
			wctx, cancelWrite := context.WithTimeout(connCtx, writeTimeout)
			err := ws.Write(wctx, websocket.MessageText, []byte(relaywire.Ping))
			cancelWrite()
			if err != nil {
				return connectedAt, fmt.Errorf("relay: writing to the fleet directory: %w", err)
			}
		case <-ctx.Done():
			return connectedAt, ctx.Err()
		}
	}
}

// readLoop ingests pushes until the socket ends.
//
// Every message is one blob, exactly as it was PUT, and every one of them goes
// through the same verification the snapshot's entries do. Text frames are the
// keepalives and nothing else: the leg is push-only in the other direction
// too, and a relay saying anything else on it is a relay this daemon stops
// reading and re-dials.
func (d *Directory) readLoop(ctx context.Context, ws *websocket.Conn) error {
	for {
		typ, data, err := ws.Read(ctx)
		if err != nil {
			return err
		}
		// Any message at all is proof the socket is still two-ended.
		d.markHeard()
		if typ == websocket.MessageText {
			if string(data) == relaywire.Pong || string(data) == relaywire.Ping {
				continue
			}
			// Not logged verbatim: this is the branch a hostile relay reaches
			// with a message of its own choosing.
			_ = ws.Close(websocket.StatusProtocolError, "protocol error")
			return protocolError{fmt.Errorf("the fleet directory sent a text frame that is not a keepalive (%d bytes)", len(data))}
		}
		d.ingest(data, "push")
	}
}

// ingestSnapshot reads the whole directory and ingests what verifies.
//
// A failure here is logged and nothing else. This leg's entire job is
// convergence, and the ways it can fail — a 5xx, a truncated body, a document
// that is not the shape the spec fixes — are all "this daemon has not caught
// up yet", which the next connect or the next push corrects. None of them is a
// reason to drop a socket that may be about to deliver a revocation.
func (d *Directory) ingestSnapshot(ctx context.Context) {
	ctx, cancel := context.WithTimeout(ctx, directoryStepTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, d.httpURL, nil)
	if err != nil {
		d.log.Warn("could not build the fleet directory read", "err", err)
		return
	}
	// The secret on a credential-less route, on purpose. `GET /directory` needs
	// no credential — the browser reads it without one — but the Worker meters
	// exactly the callers that present none (relay/src/index.ts, allowRate),
	// and a fleet of daemons re-reading the directory on every reconnect has no
	// business spending the per-IP budget that exists to keep browsers working.
	req.Header.Set("Authorization", "Bearer "+d.cfg.Secret)
	// The conditional read. The tag is the relay's version counter, so a match
	// means the set has not changed since this daemon last applied all of it —
	// nothing to download, nothing to verify. Absent on the first read of a
	// process and after any snapshot that did not fully apply.
	if tag := d.snapshotETag(); tag != "" {
		req.Header.Set("If-None-Match", tag)
	}
	resp, err := d.client.Do(req)
	if err != nil {
		d.log.Warn("could not read the fleet directory", "url", d.httpURL, "err", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotModified {
		// Unchanged since the tag was issued, and this process applied every
		// entry of that version — so it is converged, and the counts it
		// recorded then are still what the directory holds. Anything published
		// since would have moved the tag and been answered 200; anything
		// published from here on arrives on the push socket, which was opened
		// before this read.
		d.restoreCounts()
		d.log.Debug("the fleet directory is unchanged since the last read", "etag", d.snapshotETag())
		return
	}
	if resp.StatusCode != http.StatusOK {
		d.log.Warn("the fleet directory refused a read", "url", d.httpURL, "status", resp.StatusCode)
		return
	}
	var doc struct {
		V       int `json:"v"`
		Entries []struct {
			Key string `json:"key"`
			// Standard base64 with padding on the wire, which is the alphabet
			// encoding/json reads a []byte in — so the Worker's answer decodes
			// here with no help (relay/src/directory.ts, base64).
			Blob []byte `json:"blob"`
		} `json:"entries"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxDirectorySnapshot)).Decode(&doc); err != nil {
		d.log.Warn("the fleet directory answered something that is not a directory", "err", err)
		return
	}

	counts := DirectoryCounts{Connected: true, Entries: len(doc.Entries)}
	// applied stays true only while every entry either meant something or was
	// refused for a reason that will not change — a blob that does not verify
	// is not coming back different next time. A revocation the sink could not
	// take is the one retryable failure, and it is why the tag below is not
	// always remembered.
	applied := true
	// Bounded before the loop and not merely reported: a relay that claims
	// 100 000 entries gets 512 signature checks out of this daemon, which is
	// what its own ceiling would have allowed. A *shorter* answer than the
	// truth costs nothing but freshness, which is the availability a relay has
	// always been able to take away.
	for i, e := range doc.Entries {
		if i >= MaxDirectoryEntries {
			d.log.Warn("the fleet directory served more entries than it can hold; the rest are ignored",
				"entries", len(doc.Entries), "ceiling", MaxDirectoryEntries)
			// A truncated read is not a fully applied one: the entries past the
			// ceiling were never looked at, so this answer must not be cached
			// under a tag that would skip them for good.
			applied = false
			break
		}
		kind, ok, retry := d.ingest(e.Blob, "snapshot")
		if retry {
			applied = false
		}
		if ok {
			counts.Verified++
			switch kind {
			case fleet.KindMachine:
				counts.Machines++
			case fleet.KindDevice:
				counts.Devices++
			case fleet.KindRevoke:
				counts.Revocations++
			}
		}
	}
	d.mu.Lock()
	d.counts = counts
	if applied {
		// Remembered together, and only now: the tag is a claim that this
		// process holds everything that version carried, and lastCounts is what
		// a 304 against it will report.
		d.etag, d.lastCounts = resp.Header.Get("ETag"), counts
	} else {
		// Something is owed. Drop the tag so the next read is unconditional and
		// the relay sends the whole set again.
		d.etag = ""
	}
	d.mu.Unlock()
	d.log.Debug("read the fleet directory",
		"entries", counts.Entries, "verified", counts.Verified,
		"machines", counts.Machines, "devices", counts.Devices, "revocations", counts.Revocations)
}

// Snapshot reads the directory and returns the relay's answer body unchanged,
// for a caller that has to hand those bytes to somebody else.
//
// The one caller is the daemon's own loopback UI (daemon.FleetDirectoryPath).
// A browser on http://127.0.0.1:7717 cannot make this read for itself: the
// relay is another origin and the Worker sends no `Access-Control-Allow-Origin`
// on any route, so the fetch is discarded by the browser before a byte of it is
// readable. This daemon already holds the leg, so it makes the read and passes
// the body through.
//
// **Verbatim, and nothing here interprets it.** This is deliberately not
// ingestSnapshot: it does not verify, does not count, does not touch the sink,
// does not remember an ETag, and returns bytes rather than facts. The reader at
// the far end verifies every blob under the fleet public key it pinned, exactly
// as it would against the relay directly — so this function must stay incapable
// of changing what that reader concludes. Parsing here would create a second
// opinion about the same document, and the whole design turns on there being
// only one: the signature.
//
// No conditional read either. The caller needs a body every time, and the ETag
// this leg caches is a claim about what *this process* has applied, which is a
// different question from what the browser has seen.
//
// The secret rides along for the reason ingestSnapshot's does: the route takes
// no credential, but the Worker meters exactly the callers that present none,
// and a daemon's read has no business spending the per-IP budget that exists to
// keep browsers working.
func (d *Directory) Snapshot(ctx context.Context) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, directoryStepTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, d.httpURL, nil)
	if err != nil {
		return nil, fmt.Errorf("relay: building the fleet directory read: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+d.cfg.Secret)
	resp, err := d.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("relay: reading the fleet directory: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		// Drained so the connection can be reused, and not read: a refusal's
		// body is the relay's prose and nothing downstream has a use for it.
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<10))
		return nil, fmt.Errorf("relay: the fleet directory answered %d", resp.StatusCode)
	}
	// The same ceiling ingestSnapshot reads under: without it this is an
	// unbounded read from a machine on the internet, into a buffer this daemon
	// then hands to a browser.
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxDirectorySnapshot))
	if err != nil {
		return nil, fmt.Errorf("relay: reading the fleet directory: %w", err)
	}
	return body, nil
}

// snapshotETag is the tag of the last fully applied snapshot, or "" when the
// next read must be unconditional.
func (d *Directory) snapshotETag() string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.etag
}

// restoreCounts republishes the last snapshot's numbers as current, which is
// what a 304 means: the set is what it was, and this daemon still holds all of
// it. Connected is set here rather than carried, because the socket this read
// runs under is up by definition.
func (d *Directory) restoreCounts() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.counts = d.lastCounts
	d.counts.Connected = true
}

// ingest verifies one blob and does whatever it means, reporting its kind,
// whether it verified, and whether it is worth trying again.
//
// retry is the narrow one and it exists for the conditional read: it is true
// only when a *verified* artifact could not be applied for a reason that may
// not hold next time — a revocation the sink refused because the registry was
// unreadable for a moment. A blob that fails verification is not retryable, it
// is simply not a certificate, and it will fail identically forever. The
// caller uses it to decide whether this snapshot may be remembered under its
// ETag, because caching a tag over an unapplied revocation would postpone the
// retry until somebody else happens to publish.
//
// The verification is the boundary. Everything above this line is bytes a
// relay chose; everything below is a statement the fleet key signed. A blob
// that is too big, too small, not a certificate, signed by another key, or
// signed by this key and then edited by one byte, all leave by the same door:
// dropped, counted as nothing, logged once.
//
// What a verified blob does, by kind:
//
//   - Revocation → the sink, which records it, drops the local registry row
//     and closes that device's live channels. This is the fleet-wide kill
//     switch, and it is the only kind with a local consequence.
//
//   - Device cert → **nothing**, deliberately, and this is the load-bearing
//     decision of this file. This daemon no longer publishes them either (see
//     mine), so one reaching here at all means an older machine in the fleet is
//     still doing so, or a relay is offering something nobody asked for; either
//     way the answer is the same, and it is the answer it always was. A cert
//     here is a public blob off a credential-less GET; the *handshake* is where
//     a device proves it holds the key, and rule 2 of the acceptance order
//     already admits a fleet-signed device that presents its cert in message A
//     (channel.go, admitByFleetCert) — writing the row at that moment, when
//     possession has just been proved. Pre-populating the registry from the
//     directory instead would put rows in devices.json for keys nobody has
//     demonstrated they hold, and those rows are honoured by rule 1
//     (crypto.FindByKey), which deliberately never looks at a certificate at
//     all. Rule 1 exists so that pairing on this machine keeps working if the
//     fleet key ever rotates away — so a registry filled from the directory
//     would quietly convert "the fleet vouches for this key today" into "this
//     machine pairs with this key forever", surviving the very rotation that
//     was meant to withdraw it. The Devices screen would also stop being this
//     machine's record and become a fleet-wide roster it cannot vouch for.
//     None of that buys anything: a device roaming to this machine brings its
//     cert with it.
//
//   - Machine cert → nothing here either, and for a plainer reason: daemons do
//     not dial each other. A sibling machine's cert is addressed to browsers,
//     which read this directory themselves (part C) and pin the `noise` key it
//     carries. Verifying it is still worth the cycles — it is what makes the
//     machine count on `flue relay status` a count of machines rather than of
//     blobs.
func (d *Directory) ingest(blob []byte, via string) (kind string, ok bool, retry bool) {
	if len(blob) == 0 || len(blob) > maxBlobBytes {
		d.log.Warn("dropped a fleet directory entry of an impossible size", "via", via, "bytes", len(blob))
		return "", false, false
	}
	digest := sha256.Sum256(blob)
	if k, done := d.alreadySeen(digest); done {
		return k, true, false
	}
	cert, err := fleet.Verify(d.cfg.FleetPub, blob)
	if err != nil {
		// The one line that matters when a relay is lying, and the one that
		// would matter if a fleet key had rotated under this machine's feet.
		// The blob is not logged: it is bytes of the relay's choosing.
		d.log.Warn("dropped a fleet directory entry that does not verify under the fleet key",
			"via", via, "bytes", len(blob), "err", err)
		return "", false, false
	}
	switch c := cert.(type) {
	case fleet.Revocation:
		if err := d.sink.ApplyFleetRevocation(c.Device, blob); err != nil {
			// Not remembered as seen, so the next snapshot tries again — the
			// registry may simply have been unreadable for a moment, and a
			// revocation that was dropped on the floor is a device that stays
			// admitted.
			d.log.Error("could not apply a fleet revocation",
				"via", via, "device", crypto.DeviceID(c.Device), "err", err)
			return c.Kind(), false, true
		}
		d.log.Info("applied a fleet revocation", "via", via, "device", crypto.DeviceID(c.Device))
	case fleet.DeviceCert:
		// Verified, and deliberately not written to the registry — see above.
		d.log.Debug("read a fleet device certificate",
			"via", via, "device", crypto.DeviceID(c.Device), "pairedOn", clip(c.PairedOn))
	case fleet.MachineCert:
		d.log.Debug("read a fleet machine certificate", "via", via, "machine", clip(c.ID))
	}
	d.remember(digest, cert.Kind())
	return cert.Kind(), true, false
}

func (d *Directory) markHeard() { d.heard.Store(time.Now().UnixNano()) }

func (d *Directory) lastHeard() time.Time { return time.Unix(0, d.heard.Load()) }

// alreadySeen reports whether this exact blob has been ingested by this
// process, and what it was.
func (d *Directory) alreadySeen(digest [32]byte) (string, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	k, ok := d.seenKind[digest]
	return k, ok
}

func (d *Directory) remember(digest [32]byte, kind string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if len(d.seenKind) >= MaxDirectoryEntries {
		// The directory cannot hold more than this, so a process that has seen
		// this many distinct blobs is either very long-lived across a fleet's
		// whole history or is being fed by a relay that is not obeying its own
		// ceiling. Either way the map stops growing rather than being pruned
		// on a policy: forgetting costs one re-verification, and every path
		// behind this cache is idempotent.
		return
	}
	d.seenKind[digest] = kind
}

// publishAll offers the directory everything this machine holds for it: its
// own machine certificate and every revocation it knows about. Not the device
// certificates its ceremonies minted — those go to the devices themselves; see
// `mine`, which is where the absence is argued.
//
// It runs on every connect, which is what makes the whole leg self-healing —
// a PUT that failed, a push that was dropped, an artifact minted while the
// relay was down, a directory that was emptied by a re-deploy — and it is
// cheap to run: the store is content-addressed, so re-offering a blob it
// already has is a 200 with no write and no push (relay/src/directory.ts).
func (d *Directory) publishAll(ctx context.Context) {
	for _, blob := range d.mine() {
		if ctx.Err() != nil {
			return
		}
		d.publish(ctx, blob)
	}
}

// mine is every blob this machine is the source of: its own machine
// certificate, and every revocation it knows.
//
// **Device certificates are deliberately not here**, and their absence is the
// load-bearing half of this function. A device gets its own certificate from
// the machine that minted it — in the pairing answer, and again in the welcome
// on every connection it opens anywhere in the fleet (internal/daemon) — both
// of which are channels the device is already authenticated on. Publishing the
// same blob to `GET /directory` bought exactly one thing, a browser being able
// to find its own certificate, and cost two:
//
//   - **Privacy.** That route is credential-less by design, because what it
//     carries is signed rather than secret. A device certificate names a device
//     public key and the human label its owner typed — "Karn's phone" — so
//     publishing every one of them made the directory a roster of the operator's
//     devices, readable by anybody who knew the relay's address.
//   - **The cap.** Nothing in the directory is ever deleted, one entry at a
//     time, and it holds 512. Device certificates were the term that grew: one
//     permanent entry per pairing ceremony ever performed, against machines and
//     revocations that grow with the fleet rather than with its use. A full
//     directory refuses new writes, and the write it refuses might be a
//     revocation.
//
// Nothing needs them here. No daemon ever ingested one (see ingest, at length);
// a machine admits a roaming device on the certificate the device *presents* in
// its handshake, which is rule 2 and never consults this store.
func (d *Directory) mine() [][]byte {
	var out [][]byte
	if cert := d.machineCert(); cert != nil {
		out = append(out, cert)
	}
	if d.devices == nil {
		return out
	}
	revs, err := d.devices.Revocations()
	if err != nil {
		d.log.Error("could not read the revocation list to publish it", "err", err)
	}
	for _, r := range revs {
		if len(r.Cert) > 0 {
			out = append(out, r.Cert)
		}
	}
	return out
}

// machineCert is this machine's own certificate, if the one relay.json holds
// still describes this machine.
//
// Checked rather than trusted, and against this daemon's own facts rather than
// the relay's: the cert is minted by `flue relay setup`/`join` and stored, so
// the ways it can go stale are local ones — a keys/static.key deleted and
// regenerated, a relay.json copied from another machine, a machine id rotated
// by a re-setup that did not re-mint. Publishing a stale one is worse than
// publishing none: browsers pin the `noise` key it names, so a cert naming a
// key this daemon no longer holds is a machine every device in the fleet
// dials and none of them can handshake with.
func (d *Directory) machineCert() []byte {
	if len(d.cfg.MachineCert) == 0 {
		return nil
	}
	cert, err := fleet.Verify(d.cfg.FleetPub, d.cfg.MachineCert)
	if err != nil {
		d.log.Error("not publishing this machine's fleet certificate: it does not verify under this relay's fleet key; re-run the join line for this relay",
			"err", err)
		return nil
	}
	mc, ok := cert.(fleet.MachineCert)
	if !ok {
		d.log.Error("not publishing this machine's fleet certificate: relay.json holds a " + cert.Kind() + " certificate where a machine certificate belongs")
		return nil
	}
	if mc.ID != d.cfg.MachineID {
		d.log.Error("not publishing this machine's fleet certificate: it names another machine; re-run the join line on this machine",
			"cert", clip(mc.ID), "machine", d.cfg.MachineID)
		return nil
	}
	if !bytes.Equal(mc.Noise, d.noisePub) {
		d.log.Error("not publishing this machine's fleet certificate: it names a static key this daemon no longer holds; re-run the join line on this machine")
		return nil
	}
	return d.cfg.MachineCert
}

// publish PUTs one blob. Every answer the directory can give is handled here
// and none of them ends the connection, because none of them is about the
// connection.
func (d *Directory) publish(ctx context.Context, blob []byte) {
	ctx, cancel := context.WithTimeout(ctx, directoryStepTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, d.httpURL, bytes.NewReader(blob))
	if err != nil {
		d.log.Error("could not build a fleet directory write", "err", err)
		return
	}
	req.Header.Set("Authorization", "Bearer "+d.cfg.Secret)
	// Raw bytes, and the Worker never parses them: what the far end stores is
	// exactly what was signed here (relay/src/directory.ts, put).
	req.Header.Set("Content-Type", "application/octet-stream")
	req.ContentLength = int64(len(blob))
	resp, err := d.client.Do(req)
	if err != nil {
		d.log.Warn("could not publish to the fleet directory", "url", d.httpURL, "err", err)
		return
	}
	defer resp.Body.Close()
	// The body is a key this daemon has no use for — it is the digest of what
	// it just sent — so it is drained to let the connection be reused and not
	// read.
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<10))

	switch resp.StatusCode {
	case http.StatusCreated, http.StatusOK:
		// 201 stored, 200 already there. A daemon re-offering its set on every
		// reconnect sees 200 for everything, which is the point.
	case http.StatusInsufficientStorage:
		// 507: the directory is full and refuses to evict, because every
		// eviction policy can drop a revocation and a forgotten revocation
		// re-admits the device it revoked. Loud and dropped, not retried: it
		// will not fit until an operator empties the whole set with `flue relay
		// reset`, and no redeploy does that for them — the object is named by a
		// constant and its storage outlives the script. A daemon that retried
		// would spend the fleet's request budget saying so. Nothing else is
		// wedged — the socket stays up, and everything already stored keeps
		// arriving.
		//
		// The line is exact about what did not happen, because the difference
		// matters when the artifact is a revocation. The refusal comes before
		// the store *and* before the fan-out (relay/src/directory.ts, put), and
		// the push socket carries new entries and nothing else — so this blob
		// reached nobody at all, not "everybody who happened to be connected".
		// A revoke that lands here has therefore taken effect on this machine
		// and on no other, and re-offering it changes nothing: every reconnect
		// and every republish is answered 507 until the directory is emptied.
		d.log.Error("the fleet directory is full; this artifact was not stored and was not pushed to anyone, so no machine will learn of it from here — run `flue relay reset` to empty the directory",
			"bytes", len(blob))
	case http.StatusRequestEntityTooLarge:
		// 413: this daemon minted something larger than the directory will
		// take. That is a bug on this side, not a relay fault, and retrying it
		// forever would hide it.
		d.log.Error("the fleet directory refused an artifact as too large", "bytes", len(blob), "ceiling", maxBlobBytes)
	case http.StatusUnauthorized:
		d.log.Error("the fleet directory refused this daemon's credential; the relay secret in relay.json is not the one this Worker holds")
	default:
		d.log.Warn("the fleet directory refused a write", "status", resp.StatusCode, "bytes", len(blob))
	}
}

// markConnected and markUnreachable are what a held or lost socket mean to the
// status surfaces. The counts themselves come from the snapshot; this is the
// flag that says whether they are a live answer or the last thing that was
// true. Losing the socket clears both, because a stale count presented as
// current is worse than no count: it is the difference between "this machine
// is hearing the fleet" and "this machine heard the fleet once".
func (d *Directory) markConnected() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.counts.Connected = true
}

func (d *Directory) markUnreachable() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.counts = DirectoryCounts{}
}
