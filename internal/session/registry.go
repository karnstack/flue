package session

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"os/exec"
	"os/user"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/creack/pty"
)

// ErrNotFound is what the registry answers for an id it does not hold. A
// client editing a session that has just exited and been reaped is ordinary
// rather than exceptional, so callers get a sentinel to turn into a polite
// answer instead of a message they would have to match on.
var ErrNotFound = errors.New("session: not found")

// Registry owns every session on this daemon.
type Registry struct {
	clock func() time.Time

	mu       sync.Mutex
	sessions map[string]*Session
}

func NewRegistry(clock func() time.Time) *Registry {
	if clock == nil {
		clock = time.Now
	}
	return &Registry{clock: clock, sessions: map[string]*Session{}}
}

// loginShell returns the user's shell: $SHELL when set, otherwise the user
// database, otherwise /bin/sh.
//
// The database fallback matters because $SHELL is absent in exactly the
// environment the README advertises: a daemon started by launchd or a
// systemd user manager gets no login-session environment, so this is the
// path a service-started daemon takes for every session.
func loginShell() string {
	if sh := os.Getenv("SHELL"); sh != "" {
		return sh
	}
	if sh := passwdShell(runtime.GOOS); sh != "" {
		return sh
	}
	return "/bin/sh"
}

// passwdShell asks the platform's user database for the current user's login
// shell. os/user carries no shell field, so the lookup shells out: dscl on
// macOS, where accounts live in Directory Services rather than /etc/passwd,
// and getent elsewhere, which resolves through NSS and so agrees with
// whatever nsswitch.conf says a user is.
func passwdShell(goos string) string {
	u, err := user.Current()
	if err != nil {
		return ""
	}
	if goos == "darwin" {
		out, err := exec.Command("/usr/bin/dscl", ".", "-read", "/Users/"+u.Username, "UserShell").Output()
		if err != nil {
			return ""
		}
		return shellFromDscl(string(out))
	}
	out, err := exec.Command("getent", "passwd", u.Username).Output()
	if err != nil {
		return ""
	}
	return shellFromPasswd(string(out))
}

// shellFromDscl extracts the path from dscl's "UserShell: /bin/zsh" output.
func shellFromDscl(out string) string {
	_, path, ok := strings.Cut(out, ":")
	if !ok {
		return ""
	}
	return validShell(strings.TrimSpace(path))
}

// shellFromPasswd extracts the seventh field of a passwd(5) line.
func shellFromPasswd(out string) string {
	line, _, _ := strings.Cut(out, "\n")
	fields := strings.Split(line, ":")
	if len(fields) < 7 {
		return ""
	}
	return validShell(strings.TrimSpace(fields[6]))
}

// validShell refuses what could not be exec'd anyway: passwd permits an
// empty shell field and a relative path, and either would make Spawn fail
// in a way that blames the wrong thing.
func validShell(path string) string {
	if !strings.HasPrefix(path, "/") {
		return ""
	}
	return path
}

// sessionEnv is the environment every session starts with: the daemon's
// own, TERM pinned, and SHELL filled in when the daemon itself has none —
// a service-started daemon has no $SHELL, and without this every program in
// the session that consults it would come up empty.
func sessionEnv(environ []string, shell string) []string {
	env := append(append([]string(nil), environ...), "TERM=xterm-256color")
	for _, kv := range environ {
		if strings.HasPrefix(kv, "SHELL=") {
			return env
		}
	}
	return append(env, "SHELL="+shell)
}

func newID() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// Spawn starts a new session. An empty Cmd runs the user's login shell as a
// login shell, inheriting the environment: flue is a terminal, and a
// sanitised environment would defeat the purpose.
func (r *Registry) Spawn(opts SpawnOpts) (*Session, error) {
	return r.start(opts, newID(), nil, "")
}

// start is Spawn with the fields a revival dictates: the session's id, bytes
// preloaded into the ring ahead of any live output, and an initial title.
func (r *Registry) start(opts SpawnOpts, id string, preload []byte, title string) (*Session, error) {
	shell := loginShell()
	argv := opts.Cmd
	if len(argv) == 0 {
		argv = []string{shell, "-l"}
	}

	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = opts.Cwd
	cmd.Env = sessionEnv(os.Environ(), shell)

	cols, rows := opts.Cols, opts.Rows
	if cols == 0 {
		cols = 80
	}
	if rows == 0 {
		rows = 24
	}

	f, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: cols, Rows: rows})
	if err != nil {
		return nil, err
	}

	size := opts.RingSize
	if size == 0 {
		size = DefaultRingSize
	}

	cwd := opts.Cwd
	if cwd == "" {
		cwd, _ = os.Getwd()
	}

	// One reading for both stamps. A session that has just started has been
	// active for exactly as long as it has existed, and taking the clock twice
	// would let the two disagree by however long a spawn happens to take.
	born := r.clock()

	s := &Session{
		id:        id,
		pty:       f,
		cmd:       cmd,
		clock:     r.clock,
		pid:       cmd.Process.Pid,
		kill:      killGroup,
		setsize:   setWinsize,
		sigReq:    make(chan sigRequest),
		masterEnd: make(chan struct{}, 1),
		gone:      make(chan struct{}),
		ring:      NewRing(size),
		title:     NewTitleScanner(),
		subs:      map[*Sub]struct{}{},
		info: Info{
			Cwd:   cwd,
			Cmd:   argv,
			State: "running",
			Cols:  cols,
			Rows:  rows,
			// Empty rather than nil: see normalizeTags on why no reader
			// should ever meet a null here.
			Tags:       []string{},
			CreatedAt:  born,
			LastActive: born,
		},
	}
	s.info.ID = s.id
	s.info.Title = title
	// Before pump starts, so everything restored precedes everything live.
	// The `head` a fresh attach reports covers the whole preloaded region as
	// a consequence, which is what keeps the client's probe-reply mute gate
	// correct over restored scrollback.
	if len(preload) > 0 {
		s.ring.Write(preload)
	}
	go s.pump()
	go s.supervise()

	r.mu.Lock()
	r.sessions[s.id] = s
	r.mu.Unlock()
	return s, nil
}

func (r *Registry) Get(id string) (*Session, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	s, ok := r.sessions[id]
	return s, ok
}

// UpdateMeta patches one session's metadata by id and returns the resulting
// snapshot, ready to answer the request and to broadcast to everyone else
// watching. An id the registry does not hold is ErrNotFound.
//
// Get releases r.mu before ApplyMeta takes s.mu, which keeps this on the right
// side of the one ordering rule between the two locks (see Session). It costs
// nothing worth having: the session could be reaped a moment after either
// lock, so holding both would not make the edit any less racy against the
// world, only more likely to stall it.
func (r *Registry) UpdateMeta(id string, p MetaPatch) (Info, error) {
	s, ok := r.Get(id)
	if !ok {
		return Info{}, ErrNotFound
	}
	return s.ApplyMeta(p), nil
}

func (r *Registry) List() []*Session {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]*Session, 0, len(r.sessions))
	for _, s := range r.sessions {
		out = append(out, s)
	}
	return out
}

// Reap removes sessions that exited more than ExitedRetention ago.
//
// Victims are collected under r.mu and closed only after it has been
// released. Close signals a process group, waits for the session's supervisor
// to answer and closes a file descriptor; doing any of that while holding r.mu
// would turn a stall in one session into a stall of Get, List, Spawn and every
// other session too. The one session call made under r.mu, exitStatus, reads
// two fields under s.mu and returns.
func (r *Registry) Reap() {
	now := r.clock()

	var victims []*Session
	r.mu.Lock()
	for id, s := range r.sessions {
		exited, at := s.exitStatus()
		if exited && now.Sub(at) >= ExitedRetention {
			victims = append(victims, s)
			delete(r.sessions, id)
		}
	}
	r.mu.Unlock()

	for _, s := range victims {
		_ = s.Close()
	}
}
