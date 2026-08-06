package daemon

import (
	"bytes"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"
)

// PairPath is the second of the two routes that may be reached by a method
// other than GET or HEAD, and the only endpoint on this daemon that is not
// authenticated by the session token.
//
// That is the ceremony, not an oversight. The device being paired is by
// definition a device that holds no credential of this daemon's yet — if it
// had one it would not need pairing — so the thing it presents instead is the
// pairing token, which the user carried across from an already-trusted UI by
// scanning a code or following a link. Four rules keep that narrow:
//
//   - There has to be an open window. Outside one, this endpoint is inert.
//   - The window closes on the first presentation, right or wrong (see
//     pairingState.redeem), so there are no retries to grind through the
//     256-bit token with.
//   - The window closes on its own after PairingTTL.
//   - The request must be same-origin, checked before the token is compared,
//     so a page that is not the /pair page this daemon served cannot even
//     reach the comparison.
const PairPath = "/api/pair"

// PairPagePath is the client-side route that makes that POST: the app shell,
// served to a device that has nothing to authenticate with, carrying the token
// in ?t=. It is the path the QR code names — see conn.go, which builds that URL
// from this constant so the page the daemon serves without a session token and
// the page it sends the second device to cannot drift apart.
//
// Serving it needs no token for the same reason the POST does not: the device
// holds none. It is still refused unless the request's provenance is this
// daemon's own, and it answers with the app shell and nothing else. See
// Server.withProvenance.
const PairPagePath = "/pair"

// PairingTTL is how long a pairing window stays open.
//
// Two minutes is the span of the ceremony itself: pick up the second device,
// scan or open the link, confirm. It is not a span anyone is meant to walk
// away during, and a token found afterwards — in a screenshot, in a photo of a
// QR code, in a chat message — is inert.
const PairingTTL = 2 * time.Minute

// pairTokenBytes is the token's entropy. 256 bits, from crypto/rand, because
// the token is a bearer credential for "register a device that can drive this
// user's shells" and the single-window rule must be the belt, never the braces.
const pairTokenBytes = 32

// maxPairBytes bounds the pairing request body. The whole document is a token,
// a 32-byte key in base64 and a human label; four kilobytes is generous.
const maxPairBytes = 4 << 10

// maxLabelRunes caps the device label. It is free-form text from the device
// being paired and it is persisted, so it gets a bound rather than a promise.
const maxLabelRunes = 64

// pairingState guards the one active pairing window.
//
// One window, not a set: pairing is a thing the user is doing right now, in
// front of two screens, and a daemon that kept several live tokens around
// would be widening the attack surface to describe a workflow nobody has. A
// second pairStart therefore supersedes the first rather than adding to it.
type pairingState struct {
	mu      sync.Mutex
	token   string // "" when no pairing is active
	expires time.Time
}

// start opens a fresh window, replacing any window already open, and returns
// the token and its deadline.
//
// crypto/rand.Read cannot fail here: since Go 1.24 it never returns an error,
// and a system entropy source that is broken enough to make it try crashes the
// program rather than handing back a predictable token. That is the correct
// failure direction for a credential, so this signature carries no error.
func (p *pairingState) start(now time.Time) (token string, expires time.Time) {
	var raw [pairTokenBytes]byte
	_, _ = rand.Read(raw[:])
	// Unpadded and URL-safe, because Pairing.URL splices this straight into
	// ?t= with no escaping: the encoding has to be one that survives a URL as
	// itself. spec/protocol.md states this; the /pair page depends on it.
	token = base64.RawURLEncoding.EncodeToString(raw[:])

	p.mu.Lock()
	defer p.mu.Unlock()
	p.token = token
	p.expires = now.Add(PairingTTL)
	return token, p.expires
}

// cancel closes the window, invalidating any outstanding token.
func (p *pairingState) cancel() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.token, p.expires = "", time.Time{}
}

// redeemResult is the outcome of presenting a pairing token.
//
// It exists for the audit log and for nothing else. To the caller of
// /api/pair every non-accepted value is the same refusal, byte for byte — see
// refusePair — because the difference between them is information about the
// user's live ceremony. To whoever reads the daemon's log the difference is
// the whole point: "someone probed an endpoint that was inert" and "someone
// presented a wrong token against a window the user had open, and burned it"
// are the same 403 and very different events.
type redeemResult int

const (
	pairAccepted redeemResult = iota
	pairNoWindow
	pairWrongToken
	pairExpired
)

// String is what the audit log records. Phrases rather than codes, because
// this is read by a person looking at stderr, not parsed.
func (r redeemResult) String() string {
	switch r {
	case pairAccepted:
		return "accepted"
	case pairNoWindow:
		return "no pairing window open"
	case pairWrongToken:
		return "wrong token against an open window"
	case pairExpired:
		return "pairing window had expired"
	}
	return "unknown"
}

// redeem spends token, reporting whether it was the live one and, when it was
// not, which of the three ways it was not.
//
// This is find-and-delete inside a single critical section — the same
// discipline as local.Auth.Redeem, for the same reason: two concurrent
// presentations serialise, the first clears the window, and the second finds
// nothing, so there is no read-then-write gap in which one token pairs two
// devices.
//
// It differs from the handoff store in one deliberate way. The window is
// cleared whether or not the presented token matched, so a wrong guess burns
// it: with one window and no retries, a guessing attacker gets exactly one
// attempt at a 256-bit secret per ceremony the user starts, rather than as
// many as they can fit inside two minutes. The cost is that a wrong guess
// makes the user press "pair" again, which is a cost worth paying and one the
// UI can explain.
//
// A mismatch is reported as such even when the window had also expired,
// because the two say different things about who presented it: the token was
// never right, as opposed to a real ceremony that ran out of time. Neither
// distinction ever leaves this process except through the log.
//
// The comparison is crypto/subtle's rather than ==, so the answer does not
// depend on how long a prefix the guess got right.
func (p *pairingState) redeem(token string, now time.Time) redeemResult {
	p.mu.Lock()
	defer p.mu.Unlock()

	active, expires := p.token, p.expires
	p.token, p.expires = "", time.Time{}

	switch {
	case active == "":
		return pairNoWindow
	case subtle.ConstantTimeCompare([]byte(active), []byte(token)) != 1:
		return pairWrongToken
	case !now.Before(expires):
		return pairExpired
	}
	return pairAccepted
}

// pairRequest is what the /pair page posts.
type pairRequest struct {
	Token string `json:"token"`
	// PublicKey is the device's Noise static public key, 32 bytes in standard
	// base64. Standard rather than URL-safe: it is a JSON field, not a URL
	// component, and it matches how the daemon's own key is written both in
	// keys/static.key and in the response below.
	PublicKey string `json:"publicKey"`
	Label     string `json:"label"`
}

// pairingReady reports whether this daemon has the identity pairing needs: a
// static key to hand out and a registry to record the device in. A daemon
// constructed without one refuses to pair rather than half-performing the
// ceremony.
func (s *Server) pairingReady() bool {
	return s.identity.Devices != nil && len(s.identity.Key.Public) == 32
}

// daemonPub is the daemon's static public key as the wire carries it.
func (s *Server) daemonPub() string {
	return base64.StdEncoding.EncodeToString(s.identity.Key.Public)
}

// daemonPubParam is the same 32 bytes as the pairing URL carries them.
//
// Unpadded and URL-safe, for the reason the pairing token is: conn.go splices
// both into the query string raw, with no escaping, so the encoding has to be
// one that survives a URL as itself. Standard base64's `+` and `/` do not — a
// `+` in a query string is a space to half the things that will ever read it.
//
// This is the value the device being paired pins. It travels in the QR, which
// is the one channel of this ceremony that an intermediary cannot reach: it is
// drawn on a screen the user physically controls and read by a camera. Every
// other route the key could take — the answer to the device's own POST, most of
// all — is the channel the pinned key exists to protect.
func (s *Server) daemonPubParam() string {
	return base64.RawURLEncoding.EncodeToString(s.identity.Key.Public)
}

// PairOutcome is the transport-neutral answer to a pairing attempt: the HTTP
// status and the JSON body the request should be answered with.
//
// Body is always a JSON value, on every path including refusal. That is the
// relay leg's requirement rather than a preference: relaywire.PairResult
// carries the body the Worker writes as an application/json response, and its
// encoder refuses anything else — a refusal that travelled as the bare text
// the local handler writes would be a frame the daemon could not send at all,
// leaving the browser waiting for an answer that never comes. See
// spec/relay-protocol.md, `pairResult.body`, which fixes both halves of this:
// JSON over the relay, the bare text over the daemon's own origin.
type PairOutcome struct {
	Status int
	Body   []byte
}

// pairRefusedText is the body the local HTTP handler answers a refusal with,
// and pairRefusedJSON is the same refusal as the relay has to carry it. One
// refusal, two renderings, and no third: everything that is refused is refused
// in exactly these bytes.
const pairRefusedText = "pairing refused"

var pairRefusedJSON = []byte(`{"error":"` + pairRefusedText + `"}`)

// PairRefusal is the outcome every refused pairing attempt gets.
//
// It is exported for the one caller that has to refuse a pairing request
// without running the ceremony: the relay adapter, which drops a `pair` whose
// announced origin is not the relay this daemon dialled. That request must be
// answered — a Worker holding a parked HTTP request would otherwise wait out
// its own deadline — and it must be answered without redeeming anything, since
// a token is spent by any presentation and a relay lying about its origin must
// not be able to burn the user's window.
//
// The body is a fresh copy, so no caller can edit the refusal every other
// caller is about to send.
func PairRefusal() PairOutcome {
	return PairOutcome{Status: http.StatusForbidden, Body: slices.Clone(pairRefusedJSON)}
}

// refusePair records why a pairing attempt was refused and returns the one
// answer every refusal gets.
//
// One status and one body — the same bytes, every time — with the reason going
// only to the audit log. Whether a window was open, whether the token was one
// that had existed, whether it had expired: all of that is information about
// the user's live ceremony, and an endpoint reachable without the session
// token must not be an oracle for it. The uniformity of the answer and the
// specificity of the log are both pinned by tests, because the two pull in
// opposite directions and it would be easy to fix one by spoiling the other.
//
// peer is whatever the transport can honestly say about where the attempt came
// from — a socket address over HTTP, "relay" over the relay — and goes to the
// log alone.
func (s *Server) refusePair(peer, reason string, args ...any) PairOutcome {
	s.logger().Warn("pairing refused",
		append([]any{"peer", peer, "reason", reason}, args...)...)
	return PairRefusal()
}

// PairDevice runs the pairing ceremony on a request body whose provenance the
// transport has already checked: shape checks, redeem, register, broadcast.
//
// It is everything handlePair used to be from the third check down, moved here
// so the relay leg answers a browser byte for byte the way the daemon's own
// origin does. The provenance check itself stays with each transport, because
// the two have nothing in common: over HTTP it is Host, Origin and fetch
// metadata; over the relay it is the announced origin matching the relay this
// daemon dialled.
//
// It never returns a body naming a filesystem path or a refusal reason — see
// refusePair.
func (s *Server) PairDevice(body []byte, peer string) PairOutcome {
	if !s.pairingReady() {
		return s.refusePair(peer, "no pairing identity configured")
	}

	var req pairRequest
	// Limited exactly as the HTTP handler limited the request body, so a body
	// that arrived over the relay cannot buy a larger parse than one that
	// arrived over loopback.
	if err := json.NewDecoder(io.LimitReader(bytes.NewReader(body), maxPairBytes)).Decode(&req); err != nil {
		return s.refusePair(peer, "malformed request", "err", err)
	}
	if req.Token == "" {
		return s.refusePair(peer, "no token")
	}
	key, err := base64.StdEncoding.DecodeString(req.PublicKey)
	if err != nil || len(key) != 32 {
		return s.refusePair(peer, "malformed public key")
	}

	if res := s.pairing.redeem(req.Token, time.Now()); res != pairAccepted {
		// Indistinguishable on purpose in the answer, and deliberately
		// distinguished in the log: no window, wrong token and expired token
		// are one 403 to the caller and three different reasons on stderr.
		return s.refusePair(peer, res.String())
	}

	dev, err := s.identity.Devices.Add(deviceLabel(req.Label), key)
	if err != nil {
		// The window is already spent, so this is not a retry loop the caller
		// can drive; it is a device that was already paired, or a registry
		// that could not be written. Both are refusals to the caller and a
		// line in the log for whoever has to work out which.
		return s.refusePair(peer, "registry rejected the device", "err", err)
	}

	s.logger().Info("device paired", "peer", peer, "device", dev.ID, "label", dev.Label)

	// The device was registered on a request the user's other screen never
	// sees, so the screen has to be told. Broadcast before the answer is
	// returned: the pairing device is not the one waiting for this.
	s.broadcastDeviceList()

	// A map rather than a struct, because the encoder sorts a map's keys and
	// that is the byte order this endpoint has always answered in.
	answer, err := json.Marshal(map[string]any{
		"deviceId":  dev.ID,
		"daemonPub": s.daemonPub(),
	})
	if err != nil {
		// Two strings the daemon chose itself; unreachable short of a broken
		// encoder. The device is paired either way, so the refusal is about
		// this answer and the log is where the discrepancy is recorded.
		return s.refusePair(peer, "could not encode the pairing answer", "err", err)
	}
	return PairOutcome{Status: http.StatusOK, Body: answer}
}

// writePairOutcome writes what PairDevice decided as an HTTP response.
//
// The refusal is the one place the two transports deliberately differ. The
// relay cannot carry the bare text — see PairOutcome — and this endpoint has
// answered `pairing refused` as text/plain since it existed, which is what the
// /pair page reads and what spec/relay-protocol.md fixes for the local leg. The
// success body is the same bytes on both, down to the newline json.Encoder used
// to write here.
//
// It renders the two outcomes PairDevice produces and nothing else. The refusal
// is keyed on 403 rather than on "not 200" deliberately: if a third outcome is
// ever added — a 503 while the registry is unwritable, a 429 — rendering it as
// `pairing refused` would tell the user their token was rejected when it was
// not, and would do so silently. Whoever adds one gets a 500 and a log line
// instead, which is a bug that announces itself.
func (s *Server) writePairOutcome(w http.ResponseWriter, out PairOutcome) {
	switch out.Status {
	case http.StatusOK:
	case http.StatusForbidden:
		http.Error(w, pairRefusedText, out.Status)
		return
	default:
		s.logger().Error("pairing produced a status this handler cannot render",
			"status", out.Status)
		http.Error(w, http.StatusText(http.StatusInternalServerError), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(out.Status)
	// Two writes rather than an append: the outcome's body belongs to whoever
	// built it, and appending to it would write into whatever spare capacity
	// that allocation happened to have.
	_, _ = w.Write(out.Body)
	_, _ = w.Write([]byte{'\n'})
}

// handlePair registers a device against a live pairing token.
//
// The order of the checks is the design:
//
//  1. Method, because a GET must never pair — it is the one method a redirect
//     can launder, and methodPolicy's allowlist is repeated locally so the
//     rule survives this handler being mounted somewhere else.
//  2. Provenance (Host, Origin, fetch metadata) through the transport's own
//     helper, before the token is looked at. A cross-origin page must not be
//     able to burn the user's window — the same reasoning that puts
//     checkProvenance ahead of the handoff exchange in local.Auth.Middleware.
//  3. The request's shape: parseable JSON, a token that is at least present,
//     a key that is 32 bytes of base64. A client that fumbles its own request
//     has not guessed at the secret, so it does not spend the window.
//  4. Only then redeem, which spends the window whatever the answer.
//
// The first two are this transport's, and stay here. The last two are the
// ceremony itself and live in PairDevice, which the relay leg reaches with its
// own answer to step 2 — see spec/relay-protocol.md.
//
// Nothing here consults the session token, and nothing here may start doing so
// — a device that could present it would not need to pair.
func (s *Server) handlePair(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	a := s.currentAuth()
	if a == nil {
		s.logAuthFailure(r, ErrNoAuth)
		http.Error(w, ErrNoAuth.Error(), http.StatusServiceUnavailable)
		return
	}
	// Provenance only: the session token is deliberately not required, and the
	// check is the transport's own rather than a second copy of it here.
	// A missing Origin is admitted for the reason it is admitted everywhere
	// else — non-browser clients never send one — and costs nothing, because
	// the pairing token remains the credential either way.
	if err := a.CheckProvenance(r); err != nil {
		s.writePairOutcome(w, s.refusePair(r.RemoteAddr, "provenance", "err", err))
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, maxPairBytes))
	if err != nil {
		// The request went away mid-body. Nothing was redeemed, so the window
		// is untouched; this is only a refusal because there is a response to
		// write and no request left to pair.
		s.writePairOutcome(w, s.refusePair(r.RemoteAddr, "unreadable request body", "err", err))
		return
	}
	s.writePairOutcome(w, s.PairDevice(body, r.RemoteAddr))
}

// deviceLabel normalises the device's self-chosen name: trimmed, bounded, and
// never empty, since it is what the devices screen shows next to a revoke
// button — an unlabelled row is one the user cannot safely act on.
func deviceLabel(raw string) string {
	l := strings.TrimSpace(raw)
	if r := []rune(l); len(r) > maxLabelRunes {
		l = string(r[:maxLabelRunes])
	}
	if l == "" {
		return "unnamed device"
	}
	return l
}
