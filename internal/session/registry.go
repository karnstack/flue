package session

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log/slog"
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
	// metaDir is where session metadata is persisted, or "" for nowhere.
	// Empty is the default and it disables persistence outright: a registry
	// only writes files once somebody has said where, so tests and any daemon
	// without a config directory stay file-free.
	metaDir string
	// metaLog receives the one thing that can go wrong out here — a write that
	// failed — since nothing on the edit path is in a position to handle it.
	metaLog *slog.Logger
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
	return r.start(opts, newID(), nil, Info{})
}

// start is Spawn with the fields a revival dictates: the session's id, bytes
// preloaded into the ring ahead of any live output, and the record the new
// session inherits.
//
// restore is an Info rather than a widening list of positional arguments, since
// everything a revival hands back is by definition a field of the thing Info
// describes. Spawn passes the empty one, which is the honest description of a
// session that inherits nothing.
//
// Only the fields below are read from it. State, size and cwd belong to the
// process about to be started rather than to the one that ended, and a zero
// CreatedAt is read as "this session begins now" — the Spawn case, and equally
// a snapshot written before that field existed.
func (r *Registry) start(opts SpawnOpts, id string, preload []byte, restore Info) (*Session, error) {
	shell := loginShell()
	argv := opts.Cmd
	if len(argv) == 0 {
		argv = []string{shell, "-l"}
	}

	// An empty Cwd is a caller with no preference, and it must not fall
	// through to the daemon's own directory: a service-started daemon runs at
	// / — neither unit in internal/service sets a working directory — and a
	// hand-started one runs wherever it happened to be launched from, so
	// every default session would open somewhere nobody chose. Home is what
	// a terminal emulator or sshd would have picked, and it is where Revive
	// already lands a session whose directory has vanished. When even home is
	// unknowable the empty string stands and the shell inherits — the old
	// behaviour, kept as the floor rather than the default.
	cwd := opts.Cwd
	if cwd == "" {
		cwd, _ = os.UserHomeDir()
	}

	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = cwd
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

	// The recorded cwd is the value resolved above, so what Info reports is
	// where the shell actually started rather than a second opinion. It is
	// only still empty when home was unresolvable, and then the child
	// inherited the daemon's directory — so that is what gets recorded.
	if cwd == "" {
		cwd, _ = os.Getwd()
	}

	// One reading for both stamps. A session that has just started has been
	// active for exactly as long as it has existed, and taking the clock twice
	// would let the two disagree by however long a spawn happens to take.
	born := r.clock()

	// A revival is not a birth: the session kept its age across the restart,
	// and only the shell inside it is new. LastActive is the opposite case and
	// takes the reading above either way — the old one describes a process that
	// no longer exists.
	created := restore.CreatedAt
	if created.IsZero() {
		created = born
	}

	s := &Session{
		id:        id,
		pty:       f,
		cmd:       cmd,
		clock:     r.clock,
		pid:       cmd.Process.Pid,
		kill:      killGroup,
		setsize:   setWinsize,
		cwdOf:     processCwd,
		sigReq:    make(chan sigRequest),
		masterEnd: make(chan struct{}, 1),
		gone:      make(chan struct{}),
		ring:      NewRing(size),
		title:     NewTitleScanner(),
		subs:      map[*Sub]struct{}{},
		info: Info{
			Cwd:    cwd,
			Cmd:    argv,
			State:  "running",
			Cols:   cols,
			Rows:   rows,
			Name:   restore.Name,
			Pinned: restore.Pinned,
			// Through normalizeTags rather than assigned, so a hand-edited
			// snapshot arrives in the same shape an edit would have left it in,
			// and so the slice is this session's own rather than one the
			// snapshot still holds a header to. It settles the no-tags case
			// too: empty rather than nil, which is where the Spawn path lands —
			// see normalizeTags on why no reader should ever meet a null here.
			Tags:       normalizeTags(restore.Tags),
			CreatedAt:  created,
			LastActive: born,
		},
	}
	s.info.ID = s.id
	s.info.Title = restore.Title
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
//
// It flushes the result to disk when a meta directory is configured, before it
// returns: an edit a client has been told succeeded should not be able to
// vanish in the next crash.
func (r *Registry) UpdateMeta(id string, p MetaPatch) (Info, error) {
	s, ok := r.Get(id)
	if !ok {
		return Info{}, ErrNotFound
	}
	info := s.ApplyMeta(p)
	r.flushMeta(info)
	return info, nil
}

// SetMetaDir says where session metadata is persisted, and with what logger.
//
// An empty dir means nowhere, which is the default and the only way to say it:
// a registry nobody has pointed at a directory writes no files at all. A nil
// logger takes the default one, so a caller that has no logger of its own is
// not forced to invent a sink for a line it will probably never see.
//
// Called once at startup, before anything is serving, but it takes r.mu anyway
// — the fields it writes are read on every edit, and "only at startup" is a
// property of today's caller rather than of this method.
func (r *Registry) SetMetaDir(dir string, log *slog.Logger) {
	if log == nil {
		log = slog.Default()
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.metaDir, r.metaLog = dir, log
}

// metaSink reports where metadata goes and where to complain when it cannot.
func (r *Registry) metaSink() (string, *slog.Logger) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.metaDir, r.metaLog
}

// flushMeta writes one session's metadata out, if there is anywhere to write
// it.
//
// A failed write is logged and nothing more. The alternative — failing the edit
// — would make an unwritable config directory take renaming with it, which
// trades a durability problem for a functional one. Durability degrades; the
// function does not.
func (r *Registry) flushMeta(info Info) {
	dir, log := r.metaSink()
	if dir == "" {
		return
	}
	meta := Meta{V: 1, Name: info.Name, Tags: info.Tags, Pinned: info.Pinned}
	if err := SaveMeta(dir, info.ID, meta); err != nil {
		log.Warn("could not persist session metadata", "session", info.ID, "err", err)
	}
}

// AdoptMetas gives the sessions in this registry back the names and tags a
// previous daemon persisted, and sweeps what is left over.
//
// It runs at boot, after revival, and the two halves are one pass because they
// are one question: for each record on disk, is the session it describes here?
// If it is, the metadata is applied — through ApplyMeta, so a hand-edited file's
// tags are normalised like anybody else's, and without re-writing the file that
// was just read. If it is not, the session did not survive the restart and its
// record is deleted, which is what keeps a crash from leaving the directory
// growing forever.
func (r *Registry) AdoptMetas(dir string) {
	if dir == "" {
		return
	}
	for id, m := range LoadMetas(dir) {
		s, ok := r.Get(id)
		if !ok {
			DeleteMeta(dir, id)
			continue
		}
		name, tags, pinned := m.Name, m.Tags, m.Pinned
		s.ApplyMeta(MetaPatch{Name: &name, Tags: &tags, Pinned: &pinned})
	}
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

	dir, _ := r.metaSink()
	for _, s := range victims {
		_ = s.Close()
		// The registry has finished with this session, so its metadata has
		// nothing left to describe. Removing it here rather than at exit is
		// deliberate: an exited session stays listable for ExitedRetention, and
		// a name is exactly what makes it findable in that window.
		DeleteMeta(dir, s.ID())
	}
}
