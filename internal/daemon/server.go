// Package daemon wires sessions, the wire protocol, and a transport into an
// HTTP server. It owns attachment bookkeeping: ref allocation, which client
// is primary for a session, and promotion when a primary leaves.
//
// # Endpoint policy
//
// The GET surface is read-only. There are four routes — the app shell, a JSON
// session listing, the WebSocket upgrade, and the handoff mint — and no GET
// among them changes any state. Spawning, signalling, resizing and closing a
// session are reachable only over an established WebSocket.
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
// So the defence is structural, in four parts:
//
//   - Only GET and HEAD are routed, with exactly one allowlisted exception:
//     POST to MintPath. Anything else is 405 before it reaches a handler, which
//     also means no CORS preflight ever succeeds, since OPTIONS is refused
//     everywhere.
//   - The privileged operation — minting a handoff token, which converts "I can
//     read the token file" into "here is a fresh credential" — is that POST, and
//     it authenticates on a request header rather than the cookie. Neither a
//     laundered navigation (which is a GET) nor any browser (which cannot set a
//     custom header cross-origin without a preflight that always 405s) can
//     reach it.
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
	"strconv"
	"sync"
	"time"

	"github.com/coder/websocket"
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

// Server serves the flue API and the embedded UI on loopback.
type Server struct {
	reg      *session.Registry
	ui       http.Handler
	version  string
	hostname string

	// baseCtx is the parent of every WebSocket connection's context, and
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

	primaryMu sync.Mutex
	primary   map[string]*conn // session ID -> primary connection
	// attached is the connections holding each session, in
	// least-recently-active order. Activity moves a connection to the back,
	// so the last element is the one promoted when the primary leaves.
	attached map[string][]*conn
}

func New(reg *session.Registry, auth *local.Auth, ui http.Handler, version string) *Server {
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
		baseCtx:    baseCtx,
		baseCancel: baseCancel,
		auth:       auth,
		log:        slog.New(slog.NewTextHandler(os.Stderr, nil)),
		primary:    map[string]*conn{},
		attached:   map[string][]*conn{},
	}
}

// Shutdown closes every established WebSocket connection. ListenAndServe calls
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

// Handler returns the full HTTP handler: UI, JSON API, WebSocket, and mint.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", s.handleWS)
	// Not behind withAuth. That middleware accepts the flue_token cookie, which
	// a browser attaches by itself; minting must be reachable only by a local
	// process that can read the token file. handleMint runs local.Auth.CheckMint
	// instead, which accepts the token from a request header and nothing else.
	mux.HandleFunc(MintPath, s.handleMint)
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

// methodPolicy rejects everything but GET and HEAD, plus POST to MintPath.
//
// This is what makes "no mutating endpoint reachable by GET" an invariant of
// the surface rather than a property of today's handlers: a later task cannot
// add a mutating route, or accept a method-overriding parameter, without
// editing this allowlist first. It also means no CORS preflight ever succeeds,
// since OPTIONS is refused on every path including MintPath — which is what
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
		isMint := r.URL.Path == MintPath
		allowed := r.Method == http.MethodGet || r.Method == http.MethodHead ||
			(isMint && r.Method == http.MethodPost)
		if !allowed {
			allow := "GET, HEAD"
			if isMint {
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
		http.Error(w, ErrNoAuth.Error(), http.StatusServiceUnavailable)
		return
	}
	if err := a.CheckMint(r); err != nil {
		s.logger().Warn("mint rejected", "peer", r.RemoteAddr, "err", err)
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
		s.logger().Warn("auth rejected", "peer", r.RemoteAddr, "path", r.URL.Path, "err", err)
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
		s.logger().Warn("auth rejected", "peer", r.RemoteAddr, "path", r.URL.Path, "err", err)
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
	defer ws.CloseNow()

	// Parented to the server, not to the request: see Server.baseCtx.
	ctx, cancel := context.WithCancel(s.baseCtx)
	defer cancel()

	c := newConn(ctx, cancel, ws, s, r.RemoteAddr)
	c.serve()
	_ = ws.Close(websocket.StatusNormalClosure, "")
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
