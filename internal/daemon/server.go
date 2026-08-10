// Package daemon wires sessions, the wire protocol, and a transport into an
// HTTP server. It owns attachment bookkeeping: ref allocation, which client
// is primary for a session, and promotion when a primary leaves.
//
// # Endpoint policy
//
// The GET surface is read-only. The routes are the app shell, a JSON session
// listing, the WebSocket upgrade, the handoff mint, the pairing POST, and the
// two static reads the pairing page needs before it holds any credential — the
// shell at PairPagePath and the build output under uiAssetPrefix. No GET among
// them changes any state; the mint and the pairing POST answer nothing but a
// POST. Spawning, signalling, resizing and closing a session are reachable only
// over an established WebSocket.
//
// That is a security constraint rather than a stylistic one. Task 5's
// authenticator accepts Sec-Fetch-Site: none, because that is what a typed URL
// or a bookmark sends and the handoff exchange on first load depends on it. But
// per the Fetch Metadata spec the redirect-downgrade loop is skipped when the
// value is already "none", so a user-initiated navigation to a co-resident
// untrusted origin — an unrelated dev server on another loopback port — that
// answers 302 -> http://127.0.0.1:<flue>/<path> arrives at this daemon still
// carrying "none", with no Origin, a correct Host, and the flue_token cookie,
// because SameSite is blind to the port. Every check in Task 5 passes. The
// impact ceiling is a blind authenticated GET: the attacker cannot read the
// response, and the same trick through window.open or an iframe is
// page-initiated, arrives as "same-site", and is already rejected.
//
// So the defence is structural, in five parts:
//
//   - Only GET and HEAD are routed, with exactly two allowlisted exceptions:
//     POST to MintPath and POST to PairPath. Anything else is 405 before it
//     reaches a handler, which also means no CORS preflight ever succeeds,
//     since OPTIONS is refused everywhere.
//   - The privileged operation — minting a handoff token, which converts "I can
//     read the token file" into "here is a fresh credential" — is that POST, and
//     it authenticates on a request header rather than the cookie. Neither a
//     laundered navigation (which is a GET) nor any browser (which cannot set a
//     custom header cross-origin without a preflight that always 405s) can
//     reach it.
//   - The other POST, PairPath, is the one endpoint that does not authenticate
//     on the session token at all, because the device it enrols holds none yet.
//     It is bounded instead: it does nothing unless the user has opened a
//     pairing window from an already-trusted UI, it refuses anything that is
//     not same-origin before comparing the token, and the window closes on the
//     presentation that pairs a device. A wrong one closes nothing: the token
//     is 256 bits and this endpoint is reachable from the internet over a
//     relay, so burn-on-wrong-guess only ever cost the user. See pairing.go.
//   - The page that makes that POST cannot authenticate either, so the two
//     GETs which serve it — PairPagePath and uiAssetPrefix — are exempt from
//     the token as well. What the exemption covers is decided by
//     exemptStaticPath rather than by the routing patterns, which are coarser
//     than they look: http.ServeMux unescapes each segment after cleaning the
//     escaped target, so a percent-encoded traversal matches the asset subtree
//     and resolves outside it. A path that is not already its own cleaned form
//     is refused, and everything the exemption does not cover is answered by
//     withAuth as though it were absent. See withProvenance.
//   - The upgrade — the one GET that leads to state changes — refuses
//     Sec-Fetch-Site: none outright. See handleWS for why that costs a real
//     client nothing.
//   - The one remaining GET that does change state is the handoff exchange in
//     local.Auth.Middleware, which must admit "none" to work at all. It is
//     deliberate and bounded: a laundered request carrying an unknown token
//     changes nothing, and one carrying a token the attacker already knows makes
//     the victim's browser receive a cookie it is already entitled to — strictly
//     worse for the attacker than spending the same token themselves, which
//     would hand them the Set-Cookie header directly. The cookie's value is a
//     constant chosen by the daemon and never anything from the request, so
//     session fixation is structurally impossible.
package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/flynn/noise"
	"github.com/karnstack/flue/internal/crypto"
	"github.com/karnstack/flue/internal/fleet"
	"github.com/karnstack/flue/internal/session"
	"github.com/karnstack/flue/internal/transport/local"
	"github.com/karnstack/flue/internal/wire"
)

// reapInterval is how often exited sessions past their retention are cleaned
// up while the daemon is serving.
const reapInterval = time.Minute

var (
	// ErrNoAuth is returned when the daemon is asked to serve without an
	// authenticator. A daemon that spawns shells must never fall open: a
	// token that could not be loaded is a fatal startup condition, not a
	// reason to serve anonymously.
	ErrNoAuth = errors.New("daemon: no authenticator configured")

	// ErrFetchSite rejects a request whose Sec-Fetch-Site value is anything
	// other than same-origin on an endpoint that requires one.
	ErrFetchSite = errors.New("daemon: this endpoint requires a same-origin request")
)

// Identity is the daemon's cryptographic identity: the static keypair every
// paired device knows it by, and the registry of the devices that have been
// paired to it.
//
// It is one parameter rather than two because the halves are useless apart —
// a key with nowhere to record who holds it, or a registry of devices paired
// to no key — and because the zero value then has an unambiguous meaning: a
// daemon that cannot pair. Tests and any embedder without a config directory
// construct exactly that, and pairing refuses rather than half-running.
type Identity struct {
	Key     noise.DHKey
	Devices *crypto.DeviceStore

	// Fleet is asked — every time, at the moment of signing — what this
	// process may sign for its fleet. Nil is a daemon that signs nothing,
	// which is what a test and any embedder without a config directory
	// construct.
	//
	// A function rather than a value, and that is the whole of the fix this
	// field carries. The key rides relay.json, and relay.json is written by
	// *another process*: `flue relay setup` and `flue relay join` are a
	// terminal command, and the daemon they configure is already running. A
	// key read once at construction is therefore a key that is right until
	// the first time it matters — and the daemon in that window is the worst
	// possible shape of wrong, because the relay leg re-reads the file
	// (cmd/flue's startRelay says why) and comes up live: the machine is on
	// the relay, publishing a machine cert that verifies, and silently unable
	// to sign the device certs and pairing links that make a fleet a fleet.
	// Both of those records are written once, by the pairing ceremony, and
	// nothing repairs them afterwards, so every device paired in that window
	// was permanently fleet-blind. See spec/fleet-trust.md and
	// StaticFleet for the value form tests want.
	Fleet FleetSource
}

// FleetIdentity is everything a signature under the fleet key asserts about
// where it came from: the key itself, and the machine id its certificates name
// as `pairedOn`. They travel together because they are read together — one
// relay.json — and because either one alone signs nothing worth having: a key
// with no machine id mints a certificate no reader can attribute, and a machine
// id with no key mints nothing at all.
type FleetIdentity struct {
	Key       fleet.Key
	MachineID string
}

// FleetSource answers "what may this process sign right now".
//
// Called on the paths that sign and on no other: opening a pairing window,
// completing a ceremony, revoking a device, and filling in a certificate for a
// device that was paired without one. All four are rare — a human is at the
// other end of each — which is why the production implementation simply reads
// relay.json again (cmd/flue.fleetOnDisk) rather than watching it. A file this
// small, read this seldom, needs no cache to go stale.
type FleetSource func() FleetIdentity

// StaticFleet is a FleetSource that always answers the same thing: the value
// form, for tests, for an embedder that holds its own key, and for anything
// whose fleet identity genuinely cannot change under it.
//
// Nothing in cmd/flue uses it. A daemon reading a config directory that other
// processes write must never be given one — that is precisely the bug the
// function form exists to rule out — and having the value form spelled here,
// once, keeps every such construction visibly a choice.
func StaticFleet(key fleet.Key, machineID string) FleetSource {
	return func() FleetIdentity { return FleetIdentity{Key: key, MachineID: machineID} }
}

// fleetIdentity is the one way into Identity.Fleet: every signing path reads
// the key through here, at the moment it signs, so no caller can accidentally
// re-introduce a copy that was right at boot and wrong since.
func (s *Server) fleetIdentity() FleetIdentity {
	if s.identity.Fleet == nil {
		return FleetIdentity{}
	}
	return s.identity.Fleet()
}

// Server serves the flue API and the embedded UI on loopback.
type Server struct {
	reg      *session.Registry
	ui       http.Handler
	version  string
	hostname string

	// identity is fixed at construction: it is read from the config directory
	// once, by whoever starts the daemon, and a running daemon never changes
	// the key its paired devices know it by.
	//
	// The static key and the registry, that is. The fleet half of it is a
	// question rather than an answer — see Identity.Fleet — because that one
	// lives in a file another process rewrites while this one runs.
	identity Identity

	// pairing is the one open pairing window, if any. Its own lock; see
	// pairing.go.
	pairing pairingState

	// relayUI is the deploy service behind /api/relay/*, injected by cmd/flue
	// (SetRelayUI); nil leaves those endpoints 404. Its own lock, same shape
	// as auth's, because it too is set after construction.
	relayUIMu sync.Mutex
	relayUI   RelayUI

	// fleetPub is where a freshly minted certificate or revocation goes to be
	// published to the fleet directory, injected by whoever starts the relay
	// transport (SetFleetPublisher). Nil on a daemon with no relay, and on
	// every daemon a test constructs, which is why every caller checks: this
	// daemon pairs and revokes identically without one, and the local
	// registry is the record either way.
	fleetPubMu sync.Mutex
	fleetPub   FleetPublisher
	// directoryCounts reads what the directory leg last saw, for the Remote
	// screen's status. Under the same lock as the publisher because it is the
	// same object installed at the same moment.
	directoryCounts func() DirectoryCounts
	// directorySnapshot fetches the directory itself, for this machine's own
	// UI to read (fleet.go). Same lock, same object, same moment as the two
	// above.
	directorySnapshot DirectorySnapshot

	// release is the update checker behind ReleasePath, injected the same way
	// and nil by default. See release.go.
	release releaseState

	// baseCtx is the parent of every served connection's context, and
	// baseCancel is how shutdown reaches them.
	//
	// It cannot be the request context. net/http stops tracking a connection
	// once websocket.Accept hijacks it, and Server.Close only closes the
	// connections it is still tracking — so on shutdown an established socket
	// would survive its own daemon: handleWS never returns, its stream
	// goroutines keep running, and the client can keep spawning shells on a
	// daemon that was told to stop.
	baseCtx    context.Context
	baseCancel context.CancelFunc

	authMu sync.RWMutex
	auth   *local.Auth

	logMu sync.RWMutex
	log   *slog.Logger

	// connMu guards both connection registries below.
	//
	// It is deliberately not primaryMu. That lock is taken on every keystroke —
	// touch runs on the input path — and a device broadcast has no business
	// queueing behind it, nor it behind a broadcast.
	connMu sync.Mutex
	// conns is every established connection, in the order they were accepted.
	// It is what the device-list broadcast walks: attached is keyed by session,
	// and the devices screen is not attached to anything.
	conns []*conn
	// deviceConns is the live connections belonging to each paired device.
	//
	// It is empty today by construction rather than by accident: no loopback
	// connection has a device identity to be keyed by, and registerDeviceConn
	// is the only way in. Its first members arrive with the relay transport,
	// which learns the device from the Noise handshake's static key. The
	// revocation path is built against this map now, and tested through that
	// seam, so the transport that populates it does not also have to ship the
	// disconnect behaviour untested.
	deviceConns map[string][]*conn

	// relayMu guards the relay status below. Its own lock, and the smallest one
	// here: it is written by the relay transport's own goroutine on every
	// reconnect and read on two hot-ish paths — every welcome, and every
	// pairStart — neither of which has any business waiting behind the
	// connection registry or the primary bookkeeping.
	relayMu     sync.RWMutex
	relayStatus string
	relayOrigin string
	// The machine's identity on the relay, from relay.json. Written once at
	// startup by the process that read the file (SetRelayMachine), and never
	// by the transport: it is configuration, not socket state, which is why
	// the status callbacks do not carry it.
	relayMachineID   string
	relayMachineName string
	// relayConfigured is the origin relay.json names, whether or not the
	// transport has reached it. It exists for the Content-Security-Policy and
	// nothing else — see LocalCSPFor.
	relayConfigured string

	// relayPushMu serialises the relay push and guards the snapshot it last
	// sent. A lock of its own rather than relayMu, because the push has to
	// build its message *after* the setter that triggered it has let go — it
	// reads relay.json to decide NoFleetKey, and no lock this hot belongs
	// around a file read.
	//
	// It covers building the snapshot as well as sending it, which is the
	// point: two setters racing would otherwise both build, both compare, and
	// deliver in whichever order the scheduler picked, leaving connections
	// holding the older of the two states with nothing due to correct it.
	relayPushMu sync.Mutex
	// relayPushed is the last state pushed, or nil before the first push. The
	// comparison against it is what keeps a redialling transport — which
	// reports every attempt — from waking every tab on the machine each time.
	relayPushed *wire.RelayInfo

	primaryMu sync.Mutex
	primary   map[string]*conn // session ID -> primary connection
	// attached is the connections holding each session, in
	// least-recently-active order. Activity moves a connection to the back,
	// so the last element is the one promoted when the primary leaves.
	attached map[string][]*conn
	// desired is each attached connection's own fitted size, as its last
	// resize reported it. The PTY wears one of them — the entry belonging to
	// the most recently active view, which attached above already orders (see
	// effectiveLocked). Every view's report is kept rather than only the
	// winner's, because an idle view's desire is not discarded but waiting:
	// the moment that view is used again it is what the PTY takes. A view
	// leaving takes its entry with it, so the size falls to whichever
	// remaining view was active last without any ownership changing hands.
	desired map[string]map[*conn]viewSize
}

// viewSize is one client's fitted cells, recorded per attachment.
type viewSize struct {
	cols, rows uint16
}

func New(reg *session.Registry, auth *local.Auth, ui http.Handler, version string, identity Identity) *Server {
	host, _ := os.Hostname()
	if ui == nil {
		ui = http.NotFoundHandler()
	}
	baseCtx, baseCancel := context.WithCancel(context.Background())
	return &Server{
		reg:        reg,
		ui:         ui,
		version:    version,
		hostname:   host,
		identity:   identity,
		baseCtx:    baseCtx,
		baseCancel: baseCancel,
		auth:       auth,
		log:        slog.New(slog.NewTextHandler(os.Stderr, nil)),

		// No relay until something says otherwise. Whoever starts the daemon
		// decides whether there is one to dial; this server only ever learns
		// what happened to it.
		relayStatus: RelayOff,

		deviceConns: map[string][]*conn{},
		primary:     map[string]*conn{},
		attached:    map[string][]*conn{},
		desired:     map[string]map[*conn]viewSize{},
	}
}

// Shutdown closes every established connection. ListenAndServe calls
// it when its context is cancelled; it is exported so an embedder driving
// Handler directly can reach the same teardown.
func (s *Server) Shutdown() { s.baseCancel() }

// SetAuth swaps the authenticator. Used by tests, which learn their port
// only after the listener is bound.
func (s *Server) SetAuth(a *local.Auth) {
	s.authMu.Lock()
	defer s.authMu.Unlock()
	s.auth = a
}

func (s *Server) currentAuth() *local.Auth {
	s.authMu.RLock()
	defer s.authMu.RUnlock()
	return s.auth
}

// SetLogger swaps the audit logger. The default writes to stderr, which
// launchd and systemd already capture; tests substitute a buffer.
func (s *Server) SetLogger(l *slog.Logger) {
	s.logMu.Lock()
	defer s.logMu.Unlock()
	s.log = l
}

func (s *Server) logger() *slog.Logger {
	s.logMu.RLock()
	defer s.logMu.RUnlock()
	return s.log
}

// logAuthFailure records an auth decision that refused a request, with the
// same fields at every site. A missing authenticator is the daemon's own
// fault rather than the peer's, so it gets its own message at Error level;
// everything else is the audit trail's ordinary "auth rejected".
func (s *Server) logAuthFailure(r *http.Request, err error) {
	if errors.Is(err, ErrNoAuth) {
		s.logger().Error("no authenticator configured", "peer", r.RemoteAddr, "path", r.URL.Path)
		return
	}
	s.logger().Warn("auth rejected", "peer", r.RemoteAddr, "path", r.URL.Path, "err", err)
}

func (s *Server) checkAuth(r *http.Request) error {
	a := s.currentAuth()
	if a == nil {
		return ErrNoAuth
	}
	return a.Check(r)
}

// MintPath is the one route that may be reached by a method other than GET or
// HEAD. It hands the flue CLI a one-time handoff token so that the session
// token never has to appear in a URL — and therefore never in the browser
// opener's argv, which any local user can read.
const MintPath = "/api/handoff"

// uiAssetPrefix is the subtree Vite emits its content-hashed build output
// into — the module the app shell names in its one <script src>, and the
// stylesheet beside it. It is the second half of "the pairing page loads": a
// shell served without its bundle is a blank document.
//
// Unexported, and a prefix rather than a list, because the filenames carry a
// content hash and change on every build; what is stable is the directory. A
// name inside it that the build did not emit is a 404 from the UI handler, not
// the shell — see web.Handler, which refuses to answer this prefix with
// anything but a real file.
const uiAssetPrefix = "/assets/"

// Handler returns the full HTTP handler: UI, JSON API, WebSocket, and mint.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", s.handleWS)
	// Not behind withAuth. That middleware accepts the flue_token cookie, which
	// a browser attaches by itself; minting must be reachable only by a local
	// process that can read the token file. handleMint runs local.Auth.CheckMint
	// instead, which accepts the token from a request header and nothing else.
	mux.HandleFunc(MintPath, s.handleMint)
	// Also not behind withAuth, and for the opposite reason: the device posting
	// here holds no session token yet, and the pairing token is the credential.
	// handlePair runs the provenance half of the transport's checks itself and
	// then spends the token; see pairing.go for why that is the whole ceremony.
	mux.HandleFunc(PairPath, s.handlePair)
	// The page that posts there, and the bundle that page is nothing without.
	// Outside withAuth for the same reason PairPath is: the device that opens
	// the pairing URL holds no session token — that is what it is being paired
	// to get — so serving the shell only to a credential it cannot have makes
	// the QR code answer 401 and the ceremony unstartable.
	//
	// These two patterns say where such a request is routed, and nothing more.
	// What it is allowed to ask for is decided by exemptStaticPath inside
	// withProvenance, because a ServeMux pattern is not the boundary it looks
	// like: the mux unescapes each segment after cleaning the escaped target, so
	// /assets/%2e%2e/sw.js matches this subtree with r.URL.Path already reading
	// /assets/../sw.js. Anything routed here that the exemption does not cover
	// is handed to withAuth, exactly as though these two lines were absent.
	mux.Handle(PairPagePath, s.withProvenance(s.ui))
	mux.Handle(uiAssetPrefix, s.withProvenance(s.ui))
	mux.Handle("/api/sessions", s.withAuth(http.HandlerFunc(s.handleSessions)))
	// The Remote screen's relay endpoints (relayui.go). Loopback-only by the
	// bind, mutating only by POST — methodPolicy names the ones that mutate.
	mux.Handle(RelayInfoPath, s.withAuth(http.HandlerFunc(s.handleRelayInfo)))
	mux.Handle(RelayDeployPath, s.withAuth(http.HandlerFunc(s.handleRelayDeploy)))
	mux.Handle(RelayUpdatePath, s.withAuth(http.HandlerFunc(s.handleRelayUpdate)))
	mux.Handle(RelayJoinPath, s.withAuth(http.HandlerFunc(s.handleRelayJoin)))
	mux.Handle(RelayAddressPath, s.withAuth(http.HandlerFunc(s.handleRelayAddress)))
	mux.Handle(RelayLeavePath, s.withAuth(http.HandlerFunc(s.handleRelayLeave)))
	mux.Handle(RelayReloadPath, s.withAuth(http.HandlerFunc(s.handleRelayReload)))
	// The fleet directory, fetched by this daemon for its own UI because the
	// browser cannot fetch it itself: the relay serves no CORS header, so the
	// cross-origin read from a loopback tab is discarded before it is read.
	// GET-only, so methodPolicy needs nothing. See fleet.go.
	mux.Handle(FleetDirectoryPath, s.withAuth(http.HandlerFunc(s.handleFleetDirectory)))
	// And the other half of a loopback browser's fleet identity: enrolment.
	// A POST, so methodPolicy names it; loopback-only and behind withAuth, and
	// it must never acquire a wire-protocol equivalent — see EnrolPath.
	mux.Handle(EnrolPath, s.withAuth(http.HandlerFunc(s.handleEnrol)))
	mux.Handle(ReleasePath, s.withAuth(http.HandlerFunc(s.handleRelease)))
	// /api is the daemon's namespace, and an unclaimed path in it is a 404 —
	// never the app shell.
	//
	// Without this the SPA catch-all below answers every /api path no handler
	// took, so GET /api/spawn, /api/sessions/<id>/kill and
	// /api/sessions/<id>/resize?cols=1&rows=1 all come back 200 text/html. None
	// of them does anything, but "no such endpoint exists" is the property
	// TestNoStateChangeIsReachableByGET measures, and a 2xx from the shell makes
	// that measurement unreadable: the test can no longer tell an absent
	// endpoint from a live one.
	//
	// It belongs here rather than in web.Handler for two reasons. The routing
	// table is where the fact lives — package web serves a Vite build and has no
	// business knowing which prefixes this daemon reserves. And putting it on the
	// mux makes the invariant independent of the UI handler that gets injected,
	// which is the whole defect: with a stubbed UI the guarantee held for free
	// and said nothing about the binary.
	//
	// A later task that adds a real route keeps the invariant without touching
	// this line: ServeMux prefers the more specific pattern, so /api/sessions
	// and MintPath already win over this subtree, and so would any /api route
	// registered next to them. Only paths nobody claimed land here.
	//
	// Behind withAuth like everything else, so an unauthenticated caller still
	// gets 401 and cannot map the API surface by reading status codes.
	mux.Handle("/api/", s.withAuth(http.NotFoundHandler()))
	mux.Handle("/", s.withAuth(s.ui))

	return s.securityHeaders(methodPolicy(mux))
}

// methodPolicy rejects everything but GET and HEAD, plus POST to the named
// paths that are allowed to receive one: MintPath, PairPath, and the Remote
// screen's relay mutations.
//
// This is what makes "no mutating endpoint reachable by GET" an invariant of
// the surface rather than a property of today's handlers: a later task cannot
// add a mutating route, or accept a method-overriding parameter, without
// editing this allowlist first. It also means no CORS preflight ever succeeds,
// since OPTIONS is refused on every path including these two — which is what
// stops a browser from ever issuing a cross-origin request carrying the
// X-Flue-Token header a mint requires.
//
// The path comparison is against the raw r.URL.Path, before http.ServeMux sees
// it. ServeMux matches on the cleaned path and answers 301 when cleaning
// changes anything, so "POST /api/./handoff" is refused here rather than
// dispatched: there is no normalisation gap where a POST reaches a handler this
// check believed it was not reaching. Denial is the failure direction.
func methodPolicy(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		postable := r.URL.Path == MintPath || r.URL.Path == PairPath ||
			r.URL.Path == RelayDeployPath || r.URL.Path == RelayUpdatePath ||
			r.URL.Path == RelayAddressPath || r.URL.Path == RelayLeavePath ||
			r.URL.Path == RelayReloadPath || r.URL.Path == EnrolPath
		allowed := r.Method == http.MethodGet || r.Method == http.MethodHead ||
			(postable && r.Method == http.MethodPost)
		if !allowed {
			allow := "GET, HEAD"
			if postable {
				allow = "POST"
			}
			w.Header().Set("Allow", allow)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// The Content-Security-Policy the UI is served under, in the two shapes the two
// origins that can serve it need.
//
// It is not decoration on either. The browser's static Noise key lives in
// IndexedDB as raw bytes (web/src/crypto/keys.ts — a non-extractable CryptoKey
// cannot feed a userland Noise implementation), so a stored key is a standing
// grant to a shell and an injected script would be key theft. `script-src
// 'self'` is the compensating control that file names, and it has to hold on
// every origin that serves the bundle, not only on the one that is already
// unreachable from the internet.
//
// The two differ in `connect-src`, and that difference is why there are two.
//
// The daemon serves the UI over http on loopback and the socket the UI opens is
// `ws://127.0.0.1:7717`, which `'self'` does not cover; a relay serves it over
// https and the socket is a same-origin `wss://`, which `'self'` does. Those
// loopback entries carry wildcard ports — an injected script could reach every
// other service on the machine through them (docs/FOLLOW-UPS.md §6) — so an
// internet-facing origin must not inherit them just because the daemon needs
// them.
//
// Composed rather than written twice, so the shared half cannot drift.
const (
	cspHead = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
		"img-src 'self' data:; connect-src 'self'"
	cspTail = "; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"

	// cspLoopbackSockets is the daemon-only addition: its own WebSocket, which
	// is not same-origin under CSP's rules because the scheme differs.
	cspLoopbackSockets = " ws://127.0.0.1:* ws://localhost:*"

	// LocalCSP is what this daemon serves its own UI under when it has no relay
	// configured. A daemon that has one serves LocalCSPFor(origin) instead —
	// see there for why the relay origin has to be in `connect-src`.
	LocalCSP = cspHead + cspLoopbackSockets + cspTail

	// RelayCSP is what a relay origin serves the same bundle under. It is
	// carried to the deploy as the `_headers` file the Worker's static assets
	// are served with — see cmd/flue/relay.go. It grants nothing beyond
	// 'self': the bundle on a relay origin talks to that origin alone.
	RelayCSP = cspHead + cspTail
)

// LocalCSPFor is what this daemon serves its own UI under when relay.json
// names a relay: LocalCSP, plus that one origin in `connect-src`.
//
// It is not a convenience. A page the daemon served on loopback reaches its own
// daemon over `ws://127.0.0.1:7717`, and everything *else* it reaches is on the
// relay: `wss://<relay>/client/<id>` for every other machine in the fleet, and
// now `https://<relay>/directory` to find out which machines those are. Neither
// is covered by `'self'` — a different origin is a different origin, whatever
// this daemon's relationship with it — so under the policy without this clause
// the browser blocks both. The socket failure looks like a machine that will
// not connect; the fetch failure looks like nothing at all, because
// `readDirectory` answers "no machines" for every fault by design. A loopback
// tab would quietly show a fleet of one.
//
// One exact origin, and only the two schemes the page uses on it. That is a far
// narrower grant than the loopback clause beside it — which carries wildcard
// ports and is the standing item in docs/FOLLOW-UPS.md §6 — and it is the
// origin this daemon is configured to dial anyway. It comes from relay.json
// rather than from the live transport because a policy is fixed when the
// document is served: a tab loaded while the relay was still dialling would
// otherwise carry a policy that forbids the connection the page makes a second
// later, and nothing would correct it short of a reload.
//
// The relay-served copy of the same bundle keeps RelayCSP, which grants nothing
// beyond 'self': there the relay *is* the origin.
func LocalCSPFor(relayOrigin string) string {
	if relayOrigin == "" {
		return LocalCSP
	}
	// The socket is the https origin with the scheme swapped, which is exactly
	// how web/src/relay/socket.ts builds it.
	ws := "wss://" + strings.TrimPrefix(strings.TrimPrefix(relayOrigin, "https://"), "http://")
	if strings.HasPrefix(relayOrigin, "http://") {
		ws = "ws://" + strings.TrimPrefix(relayOrigin, "http://")
	}
	return cspHead + cspLoopbackSockets + " " + relayOrigin + " " + ws + cspTail
}

// fleetPubKey is the fleet public key this daemon signs under right now, for
// the welcome to carry, and nil on a daemon that holds no fleet key.
//
// Read through fleetIdentity like every other use of the key, so a machine
// joined to a fleet while it was running answers with the key it can actually
// sign under rather than the one it booted with (Identity.Fleet). That matters
// here more than anywhere: the whole point of putting the key on the welcome is
// to repair browsers paired during exactly that window.
//
// The public half. fleet.Key.Public returns nil for the zero key, which is what
// omits the field, so a daemon with no fleet says nothing about one rather than
// sending an empty claim.
func (s *Server) fleetPubKey() []byte {
	return s.fleetIdentity().Key.Public()
}

// fleetCertFor is the fleet device certificate belonging to the device this
// connection authenticated as, for the welcome to carry.
//
// Resolved by the key bytes and not by the id, which is the same discipline
// crypto.FindByKey keeps and for the same reason: an id is hex(sha256(key))
// truncated to 48 bits, and Add deliberately permits two devices to hold
// colliding ids, so a lookup by id alone can name a device that is not this
// one. The consequence here would be handing a browser somebody else's
// certificate — recoverable, because the browser checks the subject against
// its own key before storing it and every machine checks it again at the
// handshake, but "the other end will notice" is not a reason for this end to
// answer the wrong question. FindByKey also refuses a revoked key inside the
// same critical section as the read, so a revocation that landed since the
// handshake costs this welcome its certificate, which is the right answer.
//
// Empty for every connection with no device identity, which is every loopback
// one: a certificate is a statement about a device key, and a session-token
// connection has not named one. Empty too when the registry cannot be read.
//
// It re-mints nothing for a device that has one. The blob is the one this
// machine's ceremony signed and devices.json has held ever since, or the one
// the device itself presented in its handshake after pairing elsewhere
// (AddFromFleetCert). Handing back the same bytes keeps a certificate one
// artifact for the life of a pairing, which is what lets a browser compare
// what it holds against what it is offered.
//
// A device with none is the one case that does mint: see backfillFleetCert.
func (s *Server) fleetCertFor(deviceKey []byte) []byte {
	if len(deviceKey) == 0 || s.identity.Devices == nil {
		return nil
	}
	dev, ok, err := s.identity.Devices.FindByKey(deviceKey)
	if err != nil {
		// The socket is up and the device is admitted; a registry that cannot
		// be read right now costs this device its certificate on this
		// connection and nothing else. The next one carries it. Logged by id,
		// because that is the identity every other line about this device —
		// and the Devices screen — speaks in.
		s.logger().Warn("could not read a device's fleet certificate for the welcome",
			"device", crypto.DeviceID(deviceKey), "err", err)
		return nil
	}
	if !ok {
		return nil
	}
	if len(dev.Cert) == 0 {
		return s.backfillFleetCert(dev)
	}
	return dev.Cert
}

// backfillFleetCert mints the certificate a device's own ceremony could not,
// on the first connection where this machine can.
//
// Who this is for: every device paired while this machine held no fleet key.
// Devices from before the key existed, and — the reason this was written —
// devices paired in the window between a relay being set up and a daemon being
// restarted, which was a window this program used to require and no longer
// has. Their registry entries carry no cert, Add writes one only at the
// ceremony, and AddFromFleetCert needs a cert the device already holds, so
// nothing repaired them: the browser reached the machine it paired with, could
// present nothing to any sibling, and re-pairing was the only way out. That is
// also what made the re-supply path in web/src/fleet/fleet.ts a promise the
// daemon could not keep — "a browser paired before its machine had a fleet key
// picks one up from any machine it can still reach" needs a machine with one to
// hand over.
//
// Lazily, at the welcome, rather than in a sweep at startup, and the reason is
// the same one that put the fleet key on a live read: this daemon may acquire
// a fleet key at any moment, from a file another process writes. A sweep would
// have to be re-run to be correct — on a timer, or on a watcher, or on the
// restart this whole change exists to remove — while the welcome is exactly the
// moment the answer is needed and the moment the device is present to receive
// it. It costs one relay.json read per connection for devices that have no
// cert, and none at all once they do: the mint is persisted, so this runs once
// per device, not once per connection.
//
// Every failure is silent to the device and loud in the log. The connection is
// established, the device is admitted, and a welcome without a certificate is
// the answer this daemon has been giving that device all along.
//
// What it does not do is publish. Device certificates are deliberately absent
// from the fleet directory (PairDevice says why), and this changes nothing
// about that: the cert goes to the one party it is about.
func (s *Server) backfillFleetCert(dev crypto.Device) []byte {
	fi := s.fleetIdentity()
	if !fi.Key.Valid() || fi.MachineID == "" {
		return nil
	}
	// The ceremony's own timestamp, not this moment: `iat` is when the device
	// joined the fleet, which is the fact the Devices screen shows on every
	// other machine (AddFromFleetCert takes pairedAt from the cert). A registry
	// entry from before that field was written falls back to now, which is at
	// worst late and never a claim about a pairing that did not happen.
	iat := dev.PairedAt
	if iat.IsZero() {
		iat = time.Now()
	}
	blob, err := fi.Key.Sign(fleet.DeviceCert{
		Device:   dev.PublicKey,
		Name:     dev.Label,
		PairedOn: fi.MachineID,
		IAT:      iat.Unix(),
	})
	if err != nil {
		s.logger().Error("could not mint the fleet certificate a device was paired without",
			"device", dev.ID, "err", err)
		return nil
	}
	if _, err := s.identity.Devices.SetCert(dev.PublicKey, blob); err != nil {
		// The blob is good and the device is here, so it is handed over
		// anyway: the welcome is what the device actually needs, and a
		// registry write that failed costs this machine its own copy, not the
		// device its certificate. The next connection tries again.
		s.logger().Warn("could not record a back-filled fleet certificate; the device has it, this machine does not",
			"device", dev.ID, "err", err)
		return blob
	}
	s.logger().Info("minted the fleet certificate a device was paired without; it can reach the rest of the fleet now",
		"device", dev.ID, "pairedOn", fi.MachineID)
	return blob
}

// SetRelayOrigin records the origin relay.json names, for the Content-Security-
// Policy alone.
//
// Deliberately not the same field as the transport's `relayOrigin`, which is
// socket state and is empty until a dial succeeds. This is configuration: it is
// true from the moment relay.json is read, and the CSP on a document has to
// permit the connections that document will make later, including the ones it
// makes while the relay is still coming up.
func (s *Server) SetRelayOrigin(origin string) {
	s.relayMu.Lock()
	defer s.relayMu.Unlock()
	s.relayConfigured = origin
}

func (s *Server) configuredRelayOrigin() string {
	s.relayMu.RLock()
	defer s.relayMu.RUnlock()
	return s.relayConfigured
}

func (s *Server) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", LocalCSPFor(s.configuredRelayOrigin()))
		next.ServeHTTP(w, r)
	})
}

// withAuth authenticates through the transport's own middleware rather than
// reimplementing it, so the token check, the URL-token-for-cookie exchange
// and the status codes all stay in the one place they were audited.
//
// The middleware is built per request because SetAuth may swap the
// authenticator underneath a long-lived handler.
func (s *Server) withAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		a := s.currentAuth()
		if a == nil {
			s.logAuthFailure(r, ErrNoAuth)
			http.Error(w, ErrNoAuth.Error(), http.StatusServiceUnavailable)
			return
		}
		// The middleware answers 401/403 itself, so the audit hook watches
		// the status it wrote rather than re-deciding anything. The peer is
		// the resolved identity the local transport has: the socket address.
		rec := &statusRecorder{ResponseWriter: w}
		a.Middleware(next).ServeHTTP(rec, r)
		if rec.status == http.StatusUnauthorized || rec.status == http.StatusForbidden {
			s.logger().Warn("auth rejected", "peer", r.RemoteAddr, "path", r.URL.Path, "status", rec.status)
		}
	})
}

// exemptStaticPath reports whether p is one of the two static reads the pairing
// ceremony needs before any credential exists: the pairing page itself, or a
// file out of the build's content-hashed asset directory.
//
// It is a predicate over the path rather than a routing pattern because the
// routing pattern is not the boundary it appears to be. http.ServeMux unescapes
// each segment of the request target *after* cleaning the escaped form, so
// /assets/%2e%2e/sw.js never trips the redirect that would normalise it, still
// matches the /assets/ subtree, and arrives with r.URL.Path already reading
// /assets/../sw.js — which web.Handler cleans to sw.js and serves. The pattern
// says where a request was routed; only this says what it asked for.
//
// Two rules, both in the denial direction, which is the same argument
// methodPolicy makes about a POST that only differs by normalisation:
//
//   - The path must already be its own cleaned form. A target that means
//     something other than what it spells is refused rather than normalised, so
//     there is no gap between the path this reads and the path the UI handler
//     resolves. Nothing the build emits is spelled any other way.
//   - What is left must be PairPagePath exactly, or inside uiAssetPrefix. The
//     directory itself is not: it names no file, and http.FileServer would
//     answer it with the app shell.
func exemptStaticPath(p string) bool {
	if p != path.Clean(p) {
		return false
	}
	return p == PairPagePath || strings.HasPrefix(p+"/", uiAssetPrefix)
}

// withProvenance serves next to a caller that presents no credential at all,
// once the request has proved both that it asked for something the exemption
// covers and that it came from somewhere this daemon accepts.
//
// It is withAuth with the token check removed and nothing else, and it is
// reachable only for the paths the pairing ceremony needs before a token
// exists. The provenance half is the transport's own — the same CheckProvenance
// handlePair runs, for the same reason — so a cross-origin page cannot pull the
// app shell out of this daemon, and the Host allowlist still answers DNS
// rebinding.
//
// Three rules keep it from widening:
//
//   - Anything outside exemptStaticPath is answered by withAuth, exactly as it
//     would have been had this handler never been mounted. Not a bespoke
//     refusal: a 401 identical to every other authenticated path's is also the
//     answer that tells a prober nothing about which spellings are exempt.
//   - Only GET and HEAD are served. methodPolicy already refuses everything
//     else on these paths, and repeating the check here means the rule survives
//     this handler being mounted somewhere the middleware does not wrap.
//   - The handoff exchange in local.Auth.Middleware is deliberately not
//     reached, so no request to an unauthenticated path can spend a live
//     handoff token — a page that never needed a credential must not be able to
//     burn the one flue open is carrying.
//
// Nothing here logs. A file the build emitted, served to whoever asked for it,
// is not an authentication event, and an audit trail that records every asset
// fetch is one nobody reads.
func (s *Server) withProvenance(next http.Handler) http.Handler {
	// Built once rather than per request: withAuth reads the authenticator
	// inside its own handler, so it already survives SetAuth.
	authenticated := s.withAuth(next)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if !exemptStaticPath(r.URL.Path) {
			authenticated.ServeHTTP(w, r)
			return
		}
		a := s.currentAuth()
		if a == nil {
			// The one condition here that is the daemon's own fault rather
			// than the caller's, and the one it keeps its Error line for.
			s.logAuthFailure(r, ErrNoAuth)
			http.Error(w, ErrNoAuth.Error(), http.StatusServiceUnavailable)
			return
		}
		if err := a.CheckProvenance(r); err != nil {
			http.Error(w, err.Error(), http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// statusRecorder captures the status code a handler wrote. The withAuth
// routes are plain HTTP (the upgrade lives on /ws, outside it), so no
// Hijacker passthrough is needed.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

// requireSameOriginFetchSite admits a request only if it does not claim to
// have come from anywhere else. An absent header is allowed, because
// non-browser clients — curl, the flue CLI, Go's own http client — never send
// one; a present one must say same-origin exactly.
//
// Repeated values are refused rather than read through Header.Get, which
// would silently examine only the first: a second value must not ride along
// unexamined behind an acceptable one.
func requireSameOriginFetchSite(r *http.Request) error {
	vals := r.Header.Values("Sec-Fetch-Site")
	if len(vals) == 0 {
		return nil
	}
	if len(vals) > 1 || vals[0] != "same-origin" {
		return ErrFetchSite
	}
	return nil
}

// writeAuthError mirrors the transport middleware's status codes: a bad or
// missing token is 401, any other failed check is 403, and an unconfigured
// daemon is 503 because the fault is the daemon's, not the caller's.
func writeAuthError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrNoAuth):
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
	case errors.Is(err, local.ErrNoToken):
		http.Error(w, err.Error(), http.StatusUnauthorized)
	default:
		http.Error(w, err.Error(), http.StatusForbidden)
	}
}

// handleSessions lists the daemon's sessions. It performs no authentication
// of its own and must stay behind withAuth; it is also a pure read, and must
// stay one, because it is reachable by a GET carrying Sec-Fetch-Site: none.
func (s *Server) handleSessions(w http.ResponseWriter, r *http.Request) {
	infos := []session.Info{}
	for _, sess := range s.reg.List() {
		infos = append(infos, sess.Info())
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"sessions": infos})
}

// handleMint issues a one-time handoff token to a local process that has
// proved it can read the session token file.
//
// It authenticates itself rather than sitting behind withAuth, and the
// difference is the whole point: withAuth accepts the flue_token cookie, and
// the cookie is attached automatically by the browser. SameSite is blind to the
// port, so a co-resident untrusted origin on another loopback port can cause
// the victim's browser to send it. A credential the browser volunteers must
// never be enough to mint a fresh one. CheckMint requires the session token in
// the X-Flue-Token header — which no browser can send cross-origin, because the
// preflight it would need is answered 405 — and refuses any request carrying a
// Sec-Fetch-Site header at all, which every browser sends and the flue CLI
// never does.
//
// The response is the one place a handoff token is written out. It is never
// logged and never persisted.
func (s *Server) handleMint(w http.ResponseWriter, r *http.Request) {
	// methodPolicy already refuses everything but GET, HEAD and POST here, and
	// a GET must not mint: it is the one method a redirect can launder.
	// Repeating the check locally means the rule survives a handler being
	// mounted somewhere the middleware does not wrap.
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
	if err := a.CheckMint(r); err != nil {
		s.logger().Warn("mint rejected", "peer", r.RemoteAddr, "path", r.URL.Path, "err", err)
		writeAuthError(w, err)
		return
	}

	handoff, err := a.Mint()
	if err != nil {
		http.Error(w, "could not mint a handoff token", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"handoff":       handoff,
		"expires_in_ms": local.HandoffTTL.Milliseconds(),
	})
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	if err := s.checkAuth(r); err != nil {
		s.logAuthFailure(r, err)
		writeAuthError(w, err)
		return
	}

	// The upgrade is a GET that leads to every state change flue has, so it
	// gets the strict fetch-metadata rule the read-only routes do not need.
	//
	// Rejecting "none" here costs a real client nothing, because no browser
	// can produce a WebSocket handshake carrying it. A handshake is always
	// page-initiated, so its Sec-Fetch-Site is same-origin, same-site or
	// cross-site — "none" means a user-initiated navigation, and a navigation
	// cannot be an upgrade. Nor can a redirect turn one thing into the other:
	// a navigation redirected here is still an ordinary GET with no Upgrade
	// header, which Accept refuses, and a handshake cannot be redirected at
	// all, since anything but a 101 fails the connection outright.
	//
	// The attacker's own page is independently shut out twice over: a browser
	// always sends Origin on a handshake, and http://127.0.0.1:3000 is not on
	// the allowlist; and that handshake's Sec-Fetch-Site is "same-site",
	// which Task 5 already refuses.
	if err := requireSameOriginFetchSite(r); err != nil {
		s.logAuthFailure(r, err)
		http.Error(w, err.Error(), http.StatusForbidden)
		return
	}

	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// The Origin check has already run in checkAuth against our own
		// allowlist, which is stricter than the library's host comparison.
		InsecureSkipVerify: true,
	})
	if err != nil {
		return
	}
	ws.SetReadLimit(readLimit)
	// The backstop, not the close: ServeConn closes the connection through
	// MessageConn, which for this transport is the close handshake. This runs
	// after it, and matters only when that handshake could not complete.
	defer ws.CloseNow()

	// Authentication is done; everything past here is transport-independent.
	// The loopback transport carries no device identity — the session token
	// names a machine's user, not a paired device — so DeviceID stays empty.
	s.ServeConn(r.Context(), wsMessageConn{ws}, ConnMeta{
		Peer:   r.RemoteAddr,
		Origin: requestOrigin(r),
	})
}

// requestOrigin is the absolute origin this request arrived on, which is the
// origin the pairing URL has to name: the second device opens that URL, so it
// must be the address this daemon is actually reachable at rather than one
// composed from a configured port.
//
// The Origin header is preferred when present and the Host is the fallback,
// which is what a non-browser client leaves us. Neither is trusted blind: this
// only ever runs after local.Auth.Check has admitted the request, and that
// refuses a Host outside the allowlist, a repeated Origin, and an Origin that
// is not one of this daemon's own. The scheme is http because loopback is the
// only thing this transport ever binds.
func requestOrigin(r *http.Request) string {
	if o := r.Header.Get("Origin"); o != "" {
		return o
	}
	return "http://" + r.Host
}

// listenAddr is the only address this daemon ever binds. Binding 0.0.0.0
// would put a shell-spawning port on every network the machine joins.
func listenAddr(port int) string {
	return net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
}

// ListenAndServe binds 127.0.0.1 only. No adapter ever binds 0.0.0.0.
//
// It blocks until ctx is cancelled or the listener fails. A shutdown caused by
// ctx returns nil rather than http.ErrServerClosed: being asked to stop, and
// stopping, is not an error the caller has to recognise and filter out.
func (s *Server) ListenAndServe(ctx context.Context, port int) error {
	// Refuse before binding. Whoever starts the daemon is responsible for
	// treating a failed or empty token as fatal; this is the backstop that
	// makes a skipped check impossible to miss rather than silently
	// permissive.
	if s.currentAuth() == nil {
		return ErrNoAuth
	}

	ln, err := net.Listen("tcp", listenAddr(port))
	if err != nil {
		return err
	}

	// Whatever ends this call, established WebSockets end with it. Serve
	// returning on a listener error is as much a reason to tear them down as
	// an explicit shutdown; the difference matters only to the return value.
	defer s.Shutdown()

	srv := &http.Server{Handler: s.Handler()}
	done := make(chan struct{})
	defer close(done)

	go func() {
		ticker := time.NewTicker(reapInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				// Close the hijacked sockets first: net/http has already
				// forgotten them, so srv.Close will not.
				s.Shutdown()
				_ = srv.Close()
				return
			case <-done:
				// Serve returned on its own; nothing left to supervise.
				return
			case <-ticker.C:
				s.reg.Reap()
			}
		}
	}()

	err = srv.Serve(ln)
	if errors.Is(err, http.ErrServerClosed) && ctx.Err() != nil {
		return nil
	}
	return err
}

// --- the relay's status ---

// The three states the relay leg can be in, and the only three strings that
// ever reach a client in wire.RelayInfo.Status.
//
// They are exported because the transport that reports them lives in another
// package (internal/transport/relay) and the compiler is the only thing that
// can keep the two spellings identical.
const (
	// RelayOff is a daemon with no relay: none configured, or one that has
	// stopped being dialled. It is never sent on the wire — the welcome omits
	// the relay field entirely — so no client has to branch on it.
	RelayOff = "off"
	// RelayConnecting is a relay this daemon is trying to reach: dialling,
	// backing off between dials, or waiting out a refusal. Nothing is reachable
	// through it, so it names no origin.
	RelayConnecting = "connecting"
	// RelayConnected is a live socket to the relay, and the one state that
	// carries an origin.
	RelayConnected = "connected"
)

// SetRelayStatus records what the relay transport is doing. It is the only way
// into that state and the transport is its only caller.
//
// Every change is pushed to the connections already open (pushRelayState). A
// client that connected before the relay came up used to learn of it on its
// next connection, which on a loopback tab is never — see RelayState in
// internal/wire for what that cost.
//
// Two inputs are refused rather than stored, because both would have something
// downstream act on a state that cannot be true:
//
//   - A status outside the three constants above. The wire field is a closed
//     set and the TypeScript type is a union of the same three, so a fourth
//     would reach a client with no branch for it. Treated as off.
//   - "connected" with no origin. The origin is the entire use of a connected
//     relay: it is the address a pairing URL names and the one a client shows.
//     A socket that cannot name one is, to everything downstream, still
//     dialling — and recording it as connected would hand pairStart an empty
//     string to build a URL from.
func (s *Server) SetRelayStatus(status, origin string) {
	switch status {
	case RelayConnected:
		if origin == "" {
			status = RelayConnecting
		}
	case RelayConnecting:
		// Dialling reaches nothing, so it names nothing, whatever it was
		// handed.
		origin = ""
	default:
		status, origin = RelayOff, ""
	}

	s.relayMu.Lock()
	s.relayStatus, s.relayOrigin = status, origin
	s.relayMu.Unlock()

	s.pushRelayState()
}

// SetRelayMachine records which machine this daemon is on the relay: the id it
// dials /daemon/<id> as, and the human label that goes with it. Both come from
// relay.json, read by the process that wires the transport up.
//
// Empty strings are the un-set, and there is exactly one caller that means it:
// leaving a relay (cmd/flue, forgetRelay), which deletes the file these came
// from. Short of that, a machine identity does not change while the daemon
// runs — a relay swapped underneath a running daemon takes effect on its next
// start, and the id it dialled until then is the id it held.
//
// It is separate from SetRelayStatus because the two describe different
// things: the status is the socket's, reported by the transport as it dials
// and loses and regains it; the identity is the configuration's, true from the
// first welcome even while the transport is still connecting.
//
// Pushed like the status, and this is the half that mattered most: which
// machine this daemon is, is what a pairing link has to name, and the screen
// that draws that link is the one a human is looking at while the relay comes
// up underneath it.
func (s *Server) SetRelayMachine(id, name string) {
	s.relayMu.Lock()
	s.relayMachineID, s.relayMachineName = id, name
	s.relayMu.Unlock()

	s.pushRelayState()
}

// pushRelayState hands the relay leg's current state to every live connection,
// unless it is the state they were last handed.
//
// The snapshot is built here rather than by the caller so that what goes out is
// the whole of it — status, origin, machine, and whether this daemon can sign
// for its fleet — however small the change that triggered the push. That is the
// property the poll it replaces could not have: /api/relay/info answers for the
// transport, so a screen leaning on it learned that a relay existed and never
// which machine it was on.
//
// A relay that is off is said out loud, unlike on the welcome, which omits the
// field instead. A push has nothing to omit: the message exists to correct what
// a tab already believes, and silence corrects nothing. The client folds the two
// spellings together, and has to anyway (client/protocol.ts, RelayInfo).
func (s *Server) pushRelayState() {
	s.relayPushMu.Lock()
	defer s.relayPushMu.Unlock()

	now := s.relayInfo()
	if now == nil {
		now = &wire.RelayInfo{Status: RelayOff}
	}
	if s.relayPushed != nil && *s.relayPushed == *now {
		return
	}
	s.relayPushed = now

	msg := wire.RelayState{Relay: *now}
	for _, c := range s.allConns() {
		_ = c.sendControl(msg)
	}
}

// relayMachine reads the identity SetRelayMachine recorded. The id can be
// empty — a daemon with no relay, or a pairing that raced startup — and the
// one consumer that persists it (the device cert's pairedOn) records the
// empty string honestly rather than inventing a name.
func (s *Server) relayMachine() (m struct{ id, name string }) {
	s.relayMu.RLock()
	defer s.relayMu.RUnlock()
	m.id, m.name = s.relayMachineID, s.relayMachineName
	return m
}

// relayInfo is what a welcome carries, or nil when this daemon has no relay.
//
// Nil rather than an object saying "off": the field is optional on both sides,
// and "present but off" is a third shape neither the Go encoder nor the client
// has a meaning for.
func (s *Server) relayInfo() *wire.RelayInfo {
	// Read before the lock, because it reads relay.json and no lock here has
	// any business being held across a file read.
	blind := !s.canSignForTheFleet()

	s.relayMu.RLock()
	defer s.relayMu.RUnlock()
	if s.relayStatus == "" || s.relayStatus == RelayOff {
		return nil
	}
	return &wire.RelayInfo{
		Status:      s.relayStatus,
		Origin:      s.relayOrigin,
		MachineID:   s.relayMachineID,
		MachineName: s.relayMachineName,
		NoFleetKey:  blind,
	}
}

// canSignForTheFleet reports whether a pairing performed right now would give
// the device what a fleet membership is made of: the fleet key in the link it
// scans, and a certificate minted at the ceremony.
//
// Both need the same two things — a usable fleet key and a machine id to name
// — so this is one question rather than two, and it is asked of the same live
// source the ceremony will ask (Identity.Fleet). After the read went live this
// should be false only for a machine whose relay.json is genuinely incomplete;
// it is reported anyway, because the consequence of pairing while it is true is
// silent and permanent, and "nearly unreachable" is not a reason to leave a
// trapdoor unmarked.
func (s *Server) canSignForTheFleet() bool {
	fi := s.fleetIdentity()
	return fi.Key.Valid() && fi.MachineID != ""
}

// pairingOrigin is the origin a pairing URL should name, given the origin the
// connection asking for one arrived on.
//
// A live relay wins. The URL is what a second device opens — usually by pointing
// a camera at a QR code on this screen — and a phone cannot reach
// http://127.0.0.1:7717 however correct that address is for the browser that
// asked. Without a relay the connection's own origin is the only honest answer,
// and for a connection that arrived *over* the relay the two are the same value
// anyway.
func (s *Server) pairingOrigin(connOrigin string) string {
	s.relayMu.RLock()
	defer s.relayMu.RUnlock()
	if s.relayStatus == RelayConnected && s.relayOrigin != "" {
		return s.relayOrigin
	}
	return connOrigin
}

// --- the connection registry ---

// addConn records an established connection, together with the device it
// authenticated as when it has one. Every connection enters here and leaves
// through removeConn, so "every live client" is a fact the server holds rather
// than one a broadcast has to reconstruct.
//
// Both registries are written under a single hold of connMu because the gap
// between them is reachable, and a revoke is what reaches it: disconnectDevice
// takes the device's bucket as it stands — without a connection that has been
// added but not yet bound — closes what it found, and returns. A binding that
// followed would then re-create the bucket the revocation had just emptied,
// leaving the revoked device holding a live socket that nothing will ever look
// for again. There is no such gap: a revoke observes both registries or
// neither.
func (s *Server) addConn(c *conn, deviceID string) {
	s.connMu.Lock()
	defer s.connMu.Unlock()
	s.conns = append(s.conns, c)
	if deviceID == "" {
		return
	}
	s.bindDeviceLocked(deviceID, c)
}

// removeConn forgets a connection that has ended, including its device bucket.
// It tolerates a connection that is already gone, because disconnectDevice
// removes the connections it is closing straight away rather than waiting for
// each one to unwind.
func (s *Server) removeConn(c *conn) {
	s.connMu.Lock()
	defer s.connMu.Unlock()
	s.conns = dropConn(s.conns, c)
	if c.device == "" {
		return
	}
	if rest := dropConn(s.deviceConns[c.device], c); len(rest) > 0 {
		s.deviceConns[c.device] = rest
	} else {
		delete(s.deviceConns, c.device)
	}
}

// registerDeviceConn records that a connection already in s.conns is
// authenticated as deviceID, so revoking that device reaches it.
//
// Admission is not this: a transport that knows the device before it hands the
// connection over — which is every transport that has one, since the identity
// comes out of the handshake — passes it to ServeConn and is registered in one
// step by addConn. What is left for this is binding a device to a connection
// that is already up, which is how the revocation path is exercised over the
// loopback transport: no local connection has a device identity of its own, the
// session token being a machine-local credential rather than a device, so
// without this seam the map revocation walks would have no members to test
// against until the relay shipped.
//
// A connection that is no longer live is refused rather than registered.
func (s *Server) registerDeviceConn(deviceID string, c *conn) {
	if c == nil || deviceID == "" {
		return
	}
	s.connMu.Lock()
	defer s.connMu.Unlock()
	// A connection that has already left must not be registered after the fact.
	// Revocation walks this bucket, so an entry for a conn that is gone is one
	// it will close pointlessly — and worse, the bucket the late registration
	// re-creates holds nothing but dead connections, which is a device that can
	// never be disconnected again. A linear scan because s.conns is the live
	// client list, which is small by the nature of the thing.
	if !slices.Contains(s.conns, c) {
		return
	}
	s.bindDeviceLocked(deviceID, c)
}

// bindDeviceLocked records c under deviceID in the device registry. connMu
// must be held: c.device is written here and read by removeConn, and the
// bucket is what revocation walks.
func (s *Server) bindDeviceLocked(deviceID string, c *conn) {
	c.device = deviceID
	s.deviceConns[deviceID] = append(s.deviceConns[deviceID], c)
}

// allConns snapshots the live connections.
//
// The snapshot is the point. Sending under connMu would hold it across
// conn.enqueue, which drops a backlogged peer by cancelling its context — and
// that peer's own goroutine takes connMu on its way out. Nothing deadlocks
// today only because the cancel is asynchronous, which is far too fine a
// distinction to rest a shell-spawning daemon on. Copy, unlock, then send.
func (s *Server) allConns() []*conn {
	s.connMu.Lock()
	defer s.connMu.Unlock()
	return append([]*conn(nil), s.conns...)
}

func dropConn(list []*conn, c *conn) []*conn {
	for i, other := range list {
		if other == c {
			// The vacated tail slot is cleared rather than left holding the
			// element that was copied down. The slice shrinks; its backing
			// array does not, so a stale pointer there keeps a finished
			// connection — its outbox, its attachments, its context — reachable
			// for as long as the registry lives.
			copy(list[i:], list[i+1:])
			list[len(list)-1] = nil
			return list[:len(list)-1]
		}
	}
	return list
}

// --- devices and revocation ---

// errNoDeviceRegistry is the answer for a daemon constructed without an
// identity: it has no paired devices to list and none to revoke, and says so
// rather than reporting an empty registry it does not have.
var errNoDeviceRegistry = errors.New("daemon: this daemon has no device registry")

// deviceList reads the registry into the shape the wire carries: unix seconds
// rather than the registry's time.Time, and never the device's public key.
func (s *Server) deviceList() (wire.DeviceList, error) {
	if s.identity.Devices == nil {
		return wire.DeviceList{}, errNoDeviceRegistry
	}
	paired, err := s.identity.Devices.List()
	if err != nil {
		return wire.DeviceList{}, err
	}
	infos := make([]wire.DeviceInfo, 0, len(paired))
	for _, d := range paired {
		infos = append(infos, wire.DeviceInfo{
			ID:       d.ID,
			Label:    d.Label,
			PairedAt: d.PairedAt.Unix(),
			LastSeen: d.LastSeen.Unix(),
		})
	}
	return wire.DeviceList{Devices: infos}, nil
}

// markDeviceSeen records that deviceID is connected right now — the only event
// that ever moves the "last seen" column the devices screen shows — and reports
// whether the registry still holds the device at all.
//
// The two halves are not the same kind of answer. The stamp is bookkeeping and
// best effort: a registry that has become unreadable or unwritable since the
// handshake is the operator's problem, logged and then set aside, because
// bookkeeping does not get to refuse a connection that was already granted. Not
// finding the device is not bookkeeping. It means the registry was read and the
// device is not in it, which is the one thing that can be true of a credential
// that was revoked between the handshake and now — and ServeConn treats it as
// such. A read that failed says nothing either way, so it reports still-paired
// rather than turning a broken file into a lockout of every paired device.
//
// An empty id or an identity-less daemon has no device to say anything about:
// the local transport authenticates a machine-local session token rather than a
// device, and there is nothing for a revocation to have removed.
func (s *Server) markDeviceSeen(deviceID string) (stillPaired bool) {
	if deviceID == "" || s.identity.Devices == nil {
		return true
	}
	found, err := s.identity.Devices.UpdateLastSeen(deviceID, time.Now())
	if err != nil {
		s.logger().Warn("could not record a device's last-seen time",
			"device", deviceID, "err", err)
		return true
	}
	return found
}

// deviceIDLen is the width of the identity crypto.DeviceID derives: twelve
// characters of lowercase hex. It is repeated here rather than imported
// because what this file needs is a bound on a client-supplied string, and a
// bound that moved with the deriver would stop being one.
const deviceIDLen = 12

// validDeviceID reports whether id has the shape a device identity can have.
//
// The check exists for the audit log rather than for the registry, which would
// refuse anything else by simply not finding it. A revoke carries a
// client-chosen string straight into a log line, and a client may send up to
// readLimit of it — a megabyte of attacker-chosen text per message, in the one
// file whoever is investigating an incident has to be able to read. Bounded
// before it is written, not after.
func validDeviceID(id string) bool {
	if len(id) != deviceIDLen {
		return false
	}
	for _, r := range id {
		if (r < '0' || r > '9') && (r < 'a' || r > 'f') {
			return false
		}
	}
	return true
}

// removeDevice unpairs a device, reporting whether there was one to unpair.
//
// On a daemon holding the fleet key, unpairing is two writes and their order
// is load-bearing: the signed revocation is recorded first, the registry
// entry removed second. An entry removed without its revocation on file is
// not revoked at all — the device's fleet cert would walk it straight back
// into the registry on its next handshake (AddFromFleetCert) — so a
// revocation that cannot be recorded fails the whole revoke, loudly, rather
// than performing the half that does not stick. The converse partial (a
// revocation recorded, the removal failed) is safe, and safe by mechanism
// rather than by luck: both acceptance paths read the revocation list inside
// the same critical section as their registry read — crypto.FindByKey for
// rule 1, AddFromFleetCert for rule 2 — so the key is already dead to the
// acceptance rule while the entry still shows on the Devices screen, and the
// retry completes it.
//
// The signed blob is kept by the store (crypto.StoredRevocation) and handed
// to the fleet directory, because it is the same artifact every other machine
// drops the key on — one revoke on any Devices screen, and the key is dead
// fleet-wide. A daemon with no directory publisher keeps it locally and binds
// only itself, which is the whole difference between a machine on a relay and
// one that is not.
func (s *Server) removeDevice(id string) (crypto.Device, bool, error) {
	if s.identity.Devices == nil {
		return crypto.Device{}, false, errNoDeviceRegistry
	}
	if fk := s.fleetIdentity().Key; fk.Valid() {
		dev, ok, err := s.identity.Devices.FindByID(id)
		if err != nil || !ok {
			return crypto.Device{}, ok, err
		}
		blob, err := fk.Sign(fleet.Revocation{Device: dev.PublicKey, IAT: time.Now().Unix()})
		if err == nil {
			err = s.identity.Devices.AddRevocation(dev.PublicKey, blob)
		}
		if err != nil {
			return crypto.Device{}, false, fmt.Errorf("daemon: recording the revocation: %w", err)
		}
		// On file locally, so now to the rest of the fleet: this is the blob
		// every other machine drops the key on (ApplyFleetRevocation, at the
		// far end of the directory). Published before the registry write
		// rather than after, because the revocation is the part that must
		// travel and the removal below can fail — a revoke that got half way
		// should have got the *outward* half.
		s.publishFleetBlob(blob)
	}
	return s.identity.Devices.Remove(id)
}

// --- the fleet directory ---

// FleetPublisher publishes one signed fleet artifact — a device certificate or
// a revocation this daemon has just minted — to the relay's fleet directory,
// so the other machines in the fleet learn of it without being asked
// (spec/fleet-trust.md, "The fleet directory").
//
// Publish must not block: its callers are the pairing ceremony and the revoke
// op, both of which are answering a client that is waiting, and neither has
// anywhere to put a network failure. Losing a publish is survivable by
// construction — everything publishable is also written to disk, and the
// implementation re-publishes what this machine holds on every reconnect — so
// the contract is "take this and go away", not "deliver this".
type FleetPublisher interface {
	PublishFleetBlob(blob []byte)
}

// SetFleetPublisher installs the directory client. Nil — a daemon with no
// relay, or any test's — means minted artifacts stay on this machine, which is
// exactly what a machine that is not on a relay should do with them.
func (s *Server) SetFleetPublisher(p FleetPublisher) {
	s.fleetPubMu.Lock()
	defer s.fleetPubMu.Unlock()
	s.fleetPub = p
}

// publishFleetBlob hands one signed artifact to the directory, if there is one
// to hand it to. Empty blobs are dropped here rather than at each call site: a
// daemon with no fleet key mints nothing, and its callers should not each have
// to remember that.
func (s *Server) publishFleetBlob(blob []byte) {
	if len(blob) == 0 {
		return
	}
	s.fleetPubMu.Lock()
	p := s.fleetPub
	s.fleetPubMu.Unlock()
	if p == nil {
		return
	}
	p.PublishFleetBlob(blob)
}

// ApplyFleetRevocation is the receiving half of the fleet-wide kill switch: a
// revocation minted on some other machine, verified under the fleet public key
// by the transport that read it out of the directory, and now applied here.
//
// Three things, in this order, and the order is the same one revokeDevice
// keeps for a locally-minted revocation:
//
//  1. Record the revocation. This is what makes the key dead to both
//     acceptance paths — crypto.FindByKey for rule 1, AddFromFleetCert for
//     rule 2 — and it is first because it is the half that must not be
//     skipped: an entry removed without its revocation on file is not revoked
//     at all, since the device's own fleet cert would walk it straight back in
//     on the next handshake.
//  2. Drop the local registry row, if this machine had one. By key rather
//     than by id: the caller holds 32 bytes and the id is a 48-bit digest of
//     them (crypto.RemoveByKey says what that difference is worth).
//  3. Close the device's live channels with the reason every revoked device
//     gets. This is the part that makes it a kill switch rather than a
//     bookkeeping change — a socket already established is the access, and a
//     registry nothing re-reads would not take it away.
//
// It is idempotent, which the push socket and the reconnect GET both require:
// hearing the same revocation twice records nothing new, removes nothing
// twice, and closes an empty set of connections.
//
// Verification is deliberately not repeated here. It belongs to the reader
// that owns the fleet public key, and this method's contract is that it has
// already happened — which is why the parameters are the parsed key and the
// blob rather than a blob to be trusted.
func (s *Server) ApplyFleetRevocation(deviceKey, blob []byte) error {
	if s.identity.Devices == nil {
		return errNoDeviceRegistry
	}
	if err := s.identity.Devices.AddRevocation(deviceKey, blob); err != nil {
		return fmt.Errorf("daemon: recording a fleet revocation: %w", err)
	}
	dev, removed, err := s.identity.Devices.RemoveByKey(deviceKey)
	if err != nil {
		// The revocation is on file, so the key is already refused everywhere
		// it matters; what failed is the Devices screen catching up. Reported
		// so the caller logs it, and the next delivery of this revocation —
		// the reconnect GET, if nothing else — completes it.
		return fmt.Errorf("daemon: dropping a revoked device from the registry: %w", err)
	}
	// Keyed by the id the connection registry is keyed by, which is the digest
	// of the same key the handshake proved (channel.go).
	id := crypto.DeviceID(deviceKey)
	closed := s.disconnectDevice(id, "revoked")
	if !removed && closed == 0 {
		// A revocation for a device this machine never paired and is not
		// carrying. Recorded and nothing else — which is the common case in a
		// fleet, and must stay silent enough not to drown the log on the
		// reconnect that re-reads the whole directory.
		return nil
	}
	s.logger().Info("device revoked by the fleet",
		"device", id, "label", dev.Label, "unpaired", removed, "connections", closed)
	// The Devices screen is showing a row that no longer exists.
	s.broadcastDeviceList()
	return nil
}

// disconnectDevice tells every connection belonging to deviceID why it is
// ending and ends it, returning how many there were.
//
// The connections are dropped from both registries in the same critical
// section that snapshots them, so the broadcast that follows a revocation
// reaches everyone still connected and nobody who was just cut off. They are
// closed by the writer once the reason has been written; the frame is the last
// one each of those sockets will carry, so anything queued behind it — the
// broadcast included, had they still been registered — is never sent.
func (s *Server) disconnectDevice(deviceID, reason string) int {
	s.connMu.Lock()
	doomed := s.deviceConns[deviceID]
	delete(s.deviceConns, deviceID)
	for _, c := range doomed {
		s.conns = dropConn(s.conns, c)
	}
	s.connMu.Unlock()

	for _, c := range doomed {
		_ = c.sendFinal(wire.Revoked{Reason: reason})
	}
	return len(doomed)
}

// broadcastDeviceList hands the current registry to every live connection.
//
// It is a push rather than an invalidation because the list is what a client
// acts on: a devices screen that learns of a revocation only when it next asks
// is a screen offering a revoke button for a device that is already gone.
func (s *Server) broadcastDeviceList() {
	list, err := s.deviceList()
	if err != nil {
		// Nothing to broadcast and nobody to answer — this is not a client's
		// request — so the failure goes to the log rather than to a socket.
		s.logger().Error("could not read the device registry", "err", err)
		return
	}
	for _, c := range s.allConns() {
		_ = c.sendControl(list)
	}
}

// --- primary bookkeeping ---

// claimPrimaryIfUnset registers c as attached and makes it primary when the
// session has none. Reports whether c ended up primary.
func (s *Server) claimPrimaryIfUnset(id string, c *conn) bool {
	s.primaryMu.Lock()
	defer s.primaryMu.Unlock()
	s.attached[id] = append(s.attached[id], c)
	if s.primary[id] == nil {
		s.primary[id] = c
		return true
	}
	return s.primary[id] == c
}

func (s *Server) setPrimary(id string, c *conn) {
	s.primaryMu.Lock()
	defer s.primaryMu.Unlock()
	s.primary[id] = c
}

func (s *Server) isPrimary(id string, c *conn) bool {
	s.primaryMu.Lock()
	defer s.primaryMu.Unlock()
	return s.primary[id] == c
}

// touch records that c is the most recently active client of this session, by
// moving it to the back of the attachment list.
//
// The list order is the whole implementation of "most recently active", which
// is the rule for promotion: when a primary leaves, the client that was last
// typing or resizing is the one still looking at the terminal, and it is the
// one whose dimensions should win. Attach order alone would hand the PTY to
// whichever tab happened to connect last, including one left open and idle on
// another machine.
func (s *Server) touch(id string, c *conn) {
	s.primaryMu.Lock()
	defer s.primaryMu.Unlock()

	list := s.attached[id]
	for i, other := range list {
		if other == c {
			if i == len(list)-1 {
				return
			}
			copy(list[i:], list[i+1:])
			list[len(list)-1] = c
			return
		}
	}
}

// recordDesire notes c's fitted size for a session. What the PTY is actually
// set to is effective's business: the desire of the most recently active
// view, which after a report is usually — but not necessarily — the reporter.
func (s *Server) recordDesire(id string, c *conn, cols, rows uint16) {
	s.primaryMu.Lock()
	defer s.primaryMu.Unlock()
	m := s.desired[id]
	if m == nil {
		m = map[*conn]viewSize{}
		s.desired[id] = m
	}
	m[c] = viewSize{cols: cols, rows: rows}
}

// effective is effectiveLocked behind its lock, for callers outside the
// primaryMu critical sections.
func (s *Server) effective(id string) (viewSize, bool) {
	s.primaryMu.Lock()
	defer s.primaryMu.Unlock()
	return s.effectiveLocked(id)
}

// effectiveLocked computes, under primaryMu, the size the PTY should wear:
// the fitted size of the most recently active view that has reported one.
// The attachment list already encodes recency — touch keeps each session's
// most recent client at the back — so the walk is from the back, skipping
// views that have yet to report. One pty has one grid, so someone must be
// chosen; choosing the view being *used* is what lets a phone pick a session
// up at phone size and a laptop take it back with a keystroke.
func (s *Server) effectiveLocked(id string) (viewSize, bool) {
	list := s.attached[id]
	desires := s.desired[id]
	for i := len(list) - 1; i >= 0; i-- {
		if v, ok := desires[list[i]]; ok {
			return v, true
		}
	}
	return viewSize{}, false
}

// releasePrimary drops c from the session — role, activity order and desired
// size alike — and promotes the most recently active remaining client if c
// was primary. It returns the promoted connection (nil when none), the
// effective size of what remains — the most recently active surviving view's
// desire — and whether any view remains to want one; the caller resizes the
// PTY to it, which is how a departing laptop's columns are handed back.
func (s *Server) releasePrimary(id string, c *conn) (promoted *conn, eff viewSize, ok bool) {
	s.primaryMu.Lock()
	defer s.primaryMu.Unlock()

	if m := s.desired[id]; m != nil {
		delete(m, c)
		if len(m) == 0 {
			delete(s.desired, id)
		}
	}

	list := s.attached[id]
	for i, other := range list {
		if other == c {
			list = append(list[:i], list[i+1:]...)
			break
		}
	}
	if len(list) == 0 {
		delete(s.attached, id)
		delete(s.primary, id)
		return nil, viewSize{}, false
	}
	s.attached[id] = list
	eff, ok = s.effectiveLocked(id)
	if s.primary[id] != c {
		return nil, eff, ok
	}
	promoted = list[len(list)-1]
	s.primary[id] = promoted
	return promoted, eff, ok
}

// broadcastSize tells every attached client the new dimensions, and with them
// which client currently owns those dimensions.
func (s *Server) broadcastSize(id string, cols, rows uint16) {
	s.primaryMu.Lock()
	list := append([]*conn(nil), s.attached[id]...)
	primary := s.primary[id]
	s.primaryMu.Unlock()

	for _, c := range list {
		for _, ref := range c.refsFor(id) {
			_ = c.sendControl(wire.SizeChanged{
				Ref: ref, Cols: cols, Rows: rows, Primary: c == primary,
			})
		}
	}
}
