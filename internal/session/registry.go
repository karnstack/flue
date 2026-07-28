package session

import (
	"crypto/rand"
	"encoding/hex"
	"os"
	"os/exec"
	"os/user"
	"sync"
	"time"

	"github.com/creack/pty"
)

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

// loginShell returns the user's shell, preferring $SHELL and falling back to
// the passwd entry, then to /bin/sh.
func loginShell() string {
	if sh := os.Getenv("SHELL"); sh != "" {
		return sh
	}
	if u, err := user.Current(); err == nil {
		if u.HomeDir != "" {
			if _, err := os.Stat("/bin/zsh"); err == nil {
				return "/bin/zsh"
			}
		}
	}
	return "/bin/sh"
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
	argv := opts.Cmd
	if len(argv) == 0 {
		argv = []string{loginShell(), "-l"}
	}

	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = opts.Cwd
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")

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

	s := &Session{
		id:        newID(),
		pty:       f,
		cmd:       cmd,
		clock:     r.clock,
		pid:       cmd.Process.Pid,
		kill:      killGroup,
		sigReq:    make(chan sigRequest),
		masterEnd: make(chan struct{}, 1),
		done:      make(chan struct{}),
		ring:      NewRing(size),
		title:     NewTitleScanner(),
		subs:      map[*Sub]struct{}{},
		info: Info{
			Cwd:        cwd,
			Cmd:        argv,
			State:      "running",
			Cols:       cols,
			Rows:       rows,
			LastActive: r.clock(),
		},
	}
	s.info.ID = s.id
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
