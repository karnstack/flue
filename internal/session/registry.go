package session

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log/slog"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
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
	sessions map[string]handle
	// metaDir is where session metadata is persisted, or "" for nowhere.
	// Empty is the default and it disables persistence outright: a registry
	// only writes files once somebody has said where, so tests and any daemon
	// without a config directory stay file-free.
	metaDir string
	// metaLog receives the one thing that can go wrong out here — a write that
	// failed — since nothing on the edit path is in a position to handle it.
	metaLog *slog.Logger
	// holderExe and holderRoot, both set, switch Spawn and Revive onto
	// holder-backed sessions: each new session runs under `holderExe _holder`
	// in its own directory beneath holderRoot. Unset — every test, and a
	// daemon opted out via FLUE_NO_HOLDER — sessions run in-process exactly
	// as they always have.
	holderExe  string
	holderRoot string
}

func NewRegistry(clock func() time.Time) *Registry {
	if clock == nil {
		clock = time.Now
	}
	return &Registry{clock: clock, sessions: map[string]handle{}}
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

// execArgv decides what start actually execs for a caller-supplied command.
// Commands the daemon can resolve itself — a path, or a bare name LookPath
// finds — run as given. A bare name the daemon cannot find is not yet a
// failure: a service-started daemon carries launchd's or systemd's bare
// PATH, and the agent tools flue resumes ("claude", "codex", "pi") live in
// directories only the user's shell config adds. Those go to the login
// shell to resolve, exactly as they would had the user typed them into a
// session — which is also what makes a hand-started daemon and a
// service-started one behave the same. A name nobody can find still fails
// visibly: the shell prints its own not-found into the terminal and exits.
func execArgv(shell string, argv []string) []string {
	if strings.ContainsRune(argv[0], '/') {
		return argv
	}
	if _, err := exec.LookPath(argv[0]); err == nil {
		return argv
	}
	return wrapInLoginShell(shell, argv)
}

// wrapInLoginShell rewrites argv to run under the user's login shell:
// interactive, so rc files run and build the user's real PATH — zsh only
// reads ~/.zshrc when interactive, and that is where PATH lives for most
// setups — and an exec of the original command, so the shell replaces
// itself and the session's pid stays the program's own for cwd and signal
// tracking. Each word is single-quoted with the POSIX escape for embedded
// quotes, which fish happens to parse identically.
func wrapInLoginShell(shell string, argv []string) []string {
	quoted := make([]string, len(argv))
	for i, a := range argv {
		quoted[i] = "'" + strings.ReplaceAll(a, "'", `'\''`) + "'"
	}
	return []string{shell, "-l", "-i", "-c", "exec " + strings.Join(quoted, " ")}
}

func newID() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// Spawn starts a new session. An empty Cmd runs the user's login shell as a
// login shell, inheriting the environment: flue is a terminal, and a
// sanitised environment would defeat the purpose.
func (r *Registry) Spawn(opts SpawnOpts) (Handle, error) {
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
func (r *Registry) start(opts SpawnOpts, id string, preload []byte, restore Info) (Handle, error) {
	cfg := ResolveSpawn(opts)
	cfg.ID = id
	cfg.Preload = preload
	cfg.Restore = restore
	cfg.Clock = r.clock

	r.mu.Lock()
	exe, root := r.holderExe, r.holderRoot
	r.mu.Unlock()
	if exe != "" && root != "" {
		return r.startRemote(exe, filepath.Join(root, id), cfg)
	}

	s, err := StartChild(cfg)
	if err != nil {
		return nil, err
	}

	r.mu.Lock()
	r.sessions[s.id] = s
	r.mu.Unlock()
	return s, nil
}

// startRemote is start's holder-backed half: the session runs under its own
// holder process, and the identity record beside the socket is what a later
// daemon needs to call the session by its right name.
func (r *Registry) startRemote(exe, dir string, cfg ChildConfig) (Handle, error) {
	rem, err := SpawnRemote(exe, dir, cfg, r.clock)
	if err != nil {
		return nil, err
	}
	info := rem.Info()
	rec := IdentityRecord{
		V: 1, ID: cfg.ID, Cmd: info.Cmd,
		Group: info.Group, Ephemeral: info.Ephemeral,
		CreatedAt: info.CreatedAt,
	}
	if err := SaveIdentity(dir, rec); err != nil {
		// The session is up; a record that failed to write costs the next
		// daemon some fields, not the user their shell. Same judgement as
		// flushMeta.
		_, log := r.metaSink()
		if log == nil {
			log = slog.Default()
		}
		log.Warn("could not persist session identity", "session", cfg.ID, "err", err)
	}

	r.mu.Lock()
	r.sessions[cfg.ID] = rem
	r.mu.Unlock()
	return rem, nil
}

// SetHolderSpawning points the registry at the holder executable and the
// directory holder dirs live under; from then on every Spawn and Revive
// runs its session out-of-process. Empty either disables, which is the
// default and the whole of FLUE_NO_HOLDER.
func (r *Registry) SetHolderSpawning(exe, root string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.holderExe, r.holderRoot = exe, root
}

func (r *Registry) Get(id string) (Handle, bool) {
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
	// The ephemeral flag is the one meta field a reattach reads from the
	// identity record rather than the meta file, so the keep affordance has
	// to land there too or a daemon restart would resurrect the scratch's
	// death sentence.
	if rem, ok := s.(*Remote); ok && p.Ephemeral != nil {
		if rec, err := LoadIdentity(rem.Dir()); err == nil {
			rec.Ephemeral = *p.Ephemeral
			_ = SaveIdentity(rem.Dir(), rec)
		}
	}
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

func (r *Registry) List() []Handle {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]Handle, 0, len(r.sessions))
	for _, s := range r.sessions {
		out = append(out, s)
	}
	return out
}

// Reap removes sessions that exited more than their retention ago —
// ExitedRetention ordinarily, EphemeralRetention for a scratch terminal —
// and closes the running ephemeral children of parents that have ended.
//
// The second half is the whole of an ephemeral session's lifecycle: a scratch
// terminal is dismissed by detaching, never by closing, so the shell inside it
// runs on — a dev server started there keeps serving — until the session it
// was opened from exits or is reaped. This sweep is where that promise is
// kept. A parent that is merely exited (still listable in its retention
// window) already ends its scratch: the terminal the scratch belongs beside is
// over, and nothing can reopen it from there.
//
// Victims are collected under r.mu and closed only after it has been
// released. Close signals a process group, waits for the session's supervisor
// to answer and closes a file descriptor; doing any of that while holding r.mu
// would turn a stall in one session into a stall of Get, List, Spawn and every
// other session too. The session calls made under r.mu, exitStatus and
// groupID, read fields under s.mu and return.
func (r *Registry) Reap() {
	now := r.clock()

	var victims []handle
	var orphans []handle
	r.mu.Lock()
	for id, s := range r.sessions {
		exited, at, ephemeral := s.exitStatus()
		retention := ExitedRetention
		if ephemeral {
			// A scratch terminal's final output has one reader, who has already
			// dismissed it. Keeping it listable for ten minutes would pile
			// hidden exited rows behind every list that folds them away.
			retention = EphemeralRetention
		}
		if exited && now.Sub(at) >= retention {
			victims = append(victims, s)
			delete(r.sessions, id)
			continue
		}
		if !ephemeral || exited {
			continue
		}
		// A running scratch terminal lives exactly as long as its parent. An
		// ephemeral session with no group has no parent to follow and is left
		// alone — its client owns its lifecycle.
		group := s.groupID()
		if group == "" {
			continue
		}
		parent, held := r.sessions[group]
		if held {
			if parentExited, _, _ := parent.exitStatus(); !parentExited {
				continue
			}
		}
		orphans = append(orphans, s)
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
	for _, s := range orphans {
		// Between collection under r.mu and this Close, a Keep may have
		// landed: UpdateMeta clears Ephemeral without r.mu, and a session
		// promoted in that window is an ordinary member now — killing it
		// would be the sweep spending a decision the user just reversed.
		// Re-read the flag at the last moment; the promotion path never sets
		// it back, so a stale read here can only spare, never kill.
		if _, _, ephemeral := s.exitStatus(); !ephemeral {
			continue
		}
		// Close, not delete: the kill lands now, the exit is recorded by the
		// session's own supervisor, and the next sweep reaps the row through
		// the ordinary path above.
		_ = s.Close()
	}
}
