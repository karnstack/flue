package daemon

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
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

// refusePair answers a rejected pairing attempt.
//
// One status and one body — the same bytes, every time — with the reason going
// only to the audit log. Whether a window was open, whether the token was one
// that had existed, whether it had expired: all of that is information about
// the user's live ceremony, and an endpoint reachable without the session
// token must not be an oracle for it. The uniformity of the answer and the
// specificity of the log are both pinned by tests, because the two pull in
// opposite directions and it would be easy to fix one by spoiling the other.
func (s *Server) refusePair(w http.ResponseWriter, r *http.Request, reason string, args ...any) {
	s.logger().Warn("pairing refused",
		append([]any{"peer", r.RemoteAddr, "reason", reason}, args...)...)
	http.Error(w, "pairing refused", http.StatusForbidden)
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
		s.refusePair(w, r, "provenance", "err", err)
		return
	}

	if !s.pairingReady() {
		s.refusePair(w, r, "no pairing identity configured")
		return
	}

	var req pairRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxPairBytes)).Decode(&req); err != nil {
		s.refusePair(w, r, "malformed request", "err", err)
		return
	}
	if req.Token == "" {
		s.refusePair(w, r, "no token")
		return
	}
	key, err := base64.StdEncoding.DecodeString(req.PublicKey)
	if err != nil || len(key) != 32 {
		s.refusePair(w, r, "malformed public key")
		return
	}

	if res := s.pairing.redeem(req.Token, time.Now()); res != pairAccepted {
		// Indistinguishable on purpose in the answer, and deliberately
		// distinguished in the log: no window, wrong token and expired token
		// are one 403 to the caller and three different reasons on stderr.
		s.refusePair(w, r, res.String())
		return
	}

	dev, err := s.identity.Devices.Add(deviceLabel(req.Label), key)
	if err != nil {
		// The window is already spent, so this is not a retry loop the caller
		// can drive; it is a device that was already paired, or a registry
		// that could not be written. Both are refusals to the caller and a
		// line in the log for whoever has to work out which.
		s.refusePair(w, r, "registry rejected the device", "err", err)
		return
	}

	s.logger().Info("device paired",
		"peer", r.RemoteAddr, "device", dev.ID, "label", dev.Label)

	// The device was registered on an HTTP request the user's other screen
	// never sees, so the screen has to be told. Broadcast before the response
	// is written: the pairing device is not the one waiting for this.
	s.broadcastDeviceList()

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"deviceId":  dev.ID,
		"daemonPub": s.daemonPub(),
	})
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
