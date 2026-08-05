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
//     first presentation whether or not it was right. See pairing.go.
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
	identity Identity

	// pairing is the one open pairing window, if any. Its own lock; see
	// pairing.go.
	pairing pairingState

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

	primaryMu sync.Mutex
	primary   map[string]*conn // session ID -> primary connection
	// attached is the connections holding each session, in
	// least-recently-active order. Activity moves a connection to the back,
	// so the last element is the one promoted when the primary leaves.
	attached map[string][]*conn
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

		deviceConns: map[string][]*conn{},
		primary:     map[string]*conn{},
		attached:    map[string][]*conn{},
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

	return securityHeaders(methodPolicy(mux))
}

// methodPolicy rejects everything but GET and HEAD, plus POST to the two paths
// that are allowed to receive one: MintPath and PairPath.
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
		postable := r.URL.Path == MintPath || r.URL.Path == PairPath
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

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy",
			"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "+
				"img-src 'self' data:; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; "+
				"object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
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

// markDeviceSeen records that deviceID is connected right now, which is the
// only event that ever moves the "last seen" column the devices screen shows.
//
// Best effort, and deliberately so. It runs on the connect path, where the
// transport has already authenticated the device against this same registry, so
// a registry that has since become unreadable is a reason to log rather than to
// refuse a connection that was granted. A device that is simply not there raced
// its own revocation: whoever removed it is closing this connection, and the
// stamp has nothing to say about that.
func (s *Server) markDeviceSeen(deviceID string) {
	if deviceID == "" || s.identity.Devices == nil {
		return
	}
	if _, err := s.identity.Devices.UpdateLastSeen(deviceID, time.Now()); err != nil {
		s.logger().Warn("could not record a device's last-seen time",
			"device", deviceID, "err", err)
	}
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
func (s *Server) removeDevice(id string) (crypto.Device, bool, error) {
	if s.identity.Devices == nil {
		return crypto.Device{}, false, errNoDeviceRegistry
	}
	return s.identity.Devices.Remove(id)
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

// releasePrimary drops c from the session and promotes the most recently
// active remaining client if c was primary. It returns the promoted
// connection, or nil if nothing was promoted.
func (s *Server) releasePrimary(id string, c *conn) *conn {
	s.primaryMu.Lock()
	defer s.primaryMu.Unlock()

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
		return nil
	}
	s.attached[id] = list
	if s.primary[id] != c {
		return nil
	}
	promoted := list[len(list)-1]
	s.primary[id] = promoted
	return promoted
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
