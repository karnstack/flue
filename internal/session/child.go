package session

import (
	"os"
	"os/exec"
	"time"

	"github.com/creack/pty"
)

// ChildConfig is a spawn with nothing left to decide: the login shell,
// environment, working directory and sizes are all resolved. It exists so
// exactly one constructor starts children no matter which process the pty
// ends up in — the registry resolves and calls StartChild in-process, and a
// holder receives a resolved config over the wire and calls the same
// function.
type ChildConfig struct {
	ID string
	// Run is what execs; Argv is what Info reports. See registry.start for
	// why a login-shell detour is how a session starts, not what it is.
	Run  []string
	Argv []string
	Env  []string
	Cwd  string
	Cols uint16
	Rows uint16
	// RingSize of zero means DefaultRingSize, kept lenient here because a
	// wire-borne config omits it in the common case.
	RingSize int
	// Preload seeds the ring ahead of any live output — revival's scrollback.
	Preload []byte
	// Restore carries the fields a revival hands back; see registry.start.
	Restore Info
	// Group and Ephemeral mirror SpawnOpts, taking precedence over Restore
	// the same way a spawn's own naming does.
	Group     string
	Ephemeral bool
	// Clock defaults to time.Now. Tests substitute it; the wire never
	// carries it.
	Clock func() time.Time
}

// StartChild starts the child and its engine: pty, ring, pump, supervise.
// The session belongs to no registry until a caller adds it to one.
func StartChild(cfg ChildConfig) (*Session, error) {
	clock := cfg.Clock
	if clock == nil {
		clock = time.Now
	}

	cmd := exec.Command(cfg.Run[0], cfg.Run[1:]...)
	cmd.Dir = cfg.Cwd
	cmd.Env = cfg.Env

	f, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: cfg.Cols, Rows: cfg.Rows})
	if err != nil {
		return nil, err
	}

	size := cfg.RingSize
	if size == 0 {
		size = DefaultRingSize
	}

	// The recorded cwd is what was resolved for the spawn, so Info reports
	// where the shell actually started. It is only empty when even home was
	// unresolvable, and then the child inherited this process's directory —
	// so that is what gets recorded.
	cwd := cfg.Cwd
	if cwd == "" {
		cwd, _ = os.Getwd()
	}

	// One reading for both stamps. A session that has just started has been
	// active for exactly as long as it has existed, and taking the clock twice
	// would let the two disagree by however long a spawn happens to take.
	born := clock()

	// A revival is not a birth: the session kept its age across the restart,
	// and only the shell inside it is new. LastActive is the opposite case and
	// takes the reading above either way — the old one describes a process that
	// no longer exists.
	created := cfg.Restore.CreatedAt
	if created.IsZero() {
		created = born
	}

	s := &Session{
		id:        cfg.ID,
		pty:       f,
		cmd:       cmd,
		clock:     clock,
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
			Cmd:    cfg.Argv,
			State:  "running",
			Cols:   cfg.Cols,
			Rows:   cfg.Rows,
			Name:   cfg.Restore.Name,
			Pinned: cfg.Restore.Pinned,
			// Through normalizeTags rather than assigned, so a hand-edited
			// snapshot arrives in the same shape an edit would have left it in,
			// and so the slice is this session's own rather than one the
			// restore record still holds a header to.
			Tags:       normalizeTags(cfg.Restore.Tags),
			CreatedAt:  created,
			LastActive: born,
			Group:      cfg.Group,
			Ephemeral:  cfg.Ephemeral,
		},
	}
	if s.info.Group == "" {
		s.info.Group = cfg.Restore.Group
	}
	s.info.ID = s.id
	s.info.Title = cfg.Restore.Title
	// Before pump starts, so everything restored precedes everything live.
	// The `head` a fresh attach reports covers the whole preloaded region as
	// a consequence, which is what keeps the client's probe-reply mute gate
	// correct over restored scrollback.
	if len(cfg.Preload) > 0 {
		s.ring.Write(cfg.Preload)
	}
	go s.pump()
	go s.supervise()
	return s, nil
}

// ResolveSpawn turns a caller's SpawnOpts into the resolved config
// StartChild wants, making every decision registry.start used to make
// inline: login shell, exec argv, environment, cwd fallback, default sizes
// and ring capacity. ID and Clock are the caller's to fill.
func ResolveSpawn(opts SpawnOpts) ChildConfig {
	shell := loginShell()
	argv := opts.Cmd
	var run []string
	if len(argv) == 0 {
		argv = []string{shell, "-l"}
		run = argv
	} else {
		run = execArgv(shell, argv)
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

	cols, rows := opts.Cols, opts.Rows
	if cols == 0 {
		cols = 80
	}
	if rows == 0 {
		rows = 24
	}
	size := opts.RingSize
	if size == 0 {
		size = DefaultRingSize
	}

	return ChildConfig{
		Run:  run,
		Argv: argv,
		Env:  sessionEnv(os.Environ(), shell),
		Cwd:  cwd,
		Cols: cols, Rows: rows,
		RingSize:  size,
		Group:     opts.Group,
		Ephemeral: opts.Ephemeral,
	}
}
