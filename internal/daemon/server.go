// Package daemon wires sessions, the wire protocol, and a transport into an
// HTTP server. It owns attachment bookkeeping: ref allocation, which client
// is primary for a session, and promotion when a primary leaves.
//
// # Endpoint policy
//
// The HTTP surface is read-only. There are exactly three routes — the app
// shell, a JSON session listing, and the WebSocket upgrade — and none of them
// changes any state. Spawning, signalling, resizing and closing a session are
// reachable only over an established WebSocket.
//
// That is a security constraint rather than a stylistic one. Task 5's
// authenticator accepts Sec-Fetch-Site: none, because that is what a typed URL
// or a bookmark sends and the first-load token-in-URL flow depends on it. But
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
// So the defence is structural, in three parts:
//
//   - Only GET and HEAD are routed at all. Anything else is 405 before it
//     reaches a handler.
//   - No GET changes state, so a laundered navigation has nothing to reach.
//   - The upgrade — the one GET that leads to state changes — refuses
//     Sec-Fetch-Site: none outright. See handleWS for why that costs a real
//     client nothing.
package daemon

import (
	"context"
	"encoding/json"
	"errors"
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

	authMu sync.RWMutex
	auth   *local.Auth

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
	return &Server{
		reg:      reg,
		ui:       ui,
		version:  version,
		hostname: host,
		auth:     auth,
		primary:  map[string]*conn{},
		attached: map[string][]*conn{},
	}
}

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

func (s *Server) checkAuth(r *http.Request) error {
	a := s.currentAuth()
	if a == nil {
		return ErrNoAuth
	}
	return a.Check(r)
}

// Handler returns the full HTTP handler: UI, JSON API, and WebSocket.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", s.handleWS)
	mux.Handle("/api/sessions", s.withAuth(http.HandlerFunc(s.handleSessions)))
	mux.Handle("/", s.withAuth(s.ui))

	return securityHeaders(safeMethodsOnly(mux))
}

// safeMethodsOnly rejects everything but GET and HEAD.
//
// This is what makes "no mutating endpoint" an invariant of the surface
// rather than a property of today's handlers: a later task cannot add a POST
// route, or accept a method-overriding parameter, without this failing first.
// It also means no CORS preflight ever succeeds, since OPTIONS is refused
// along with the rest.
func safeMethodsOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead:
		default:
			w.Header().Set("Allow", "GET, HEAD")
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
		a.Middleware(next).ServeHTTP(w, r)
	})
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

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	if err := s.checkAuth(r); err != nil {
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

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	c := newConn(ctx, ws, s)
	c.serve()
	_ = ws.Close(websocket.StatusNormalClosure, "")
}

// listenAddr is the only address this daemon ever binds. Binding 0.0.0.0
// would put a shell-spawning port on every network the machine joins.
func listenAddr(port int) string {
	return net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
}

// ListenAndServe binds 127.0.0.1 only. No adapter ever binds 0.0.0.0.
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

	srv := &http.Server{Handler: s.Handler()}
	done := make(chan struct{})
	defer close(done)

	go func() {
		ticker := time.NewTicker(reapInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
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
	return srv.Serve(ln)
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
