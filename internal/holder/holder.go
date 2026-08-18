// Package holder runs one session in its own process, which is the whole of
// how sessions outlive the daemon: the pty master, the child, and the
// scrollback ring live here, and the daemon holds nothing a restart can
// lose. The daemon speaks holdwire over the unix socket in the holder's
// directory; the engine underneath is session.Session, unchanged.
package holder

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/karnstack/flue/internal/config"
	"github.com/karnstack/flue/internal/holdwire"
	"github.com/karnstack/flue/internal/session"
)

// SocketName is the holder's listener, beside session.json and holder.log
// in the holder's directory.
const SocketName = "holder.sock"

// orphanGrace is how long a holder whose child has exited waits for a
// daemon before reaping itself. Generously past ExitedRetention: the daemon
// owns retirement while it is alive, and this is only the guard against a
// daemon that never comes back leaving exited holders forever.
var orphanGrace = 60 * time.Minute

// eventPoll is how often the holder looks at the engine for changes worth
// pushing, and activeThrottle bounds how often output activity alone is
// reported. Both are latency/chatter dials, not correctness.
var (
	eventPoll      = 250 * time.Millisecond
	activeThrottle = time.Second
)

// Main is the `flue _holder` entry point: it parses the holder's one flag
// and serves. The ready pipe rides on fd 3 when the spawner passed one —
// the contract SpawnRemote holds up from the other side.
func Main(version string, args []string) error {
	fs := flag.NewFlagSet("_holder", flag.ContinueOnError)
	dir := fs.String("dir", "", "holder directory")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *dir == "" {
		return errors.New("holder: --dir is required")
	}
	var ready io.WriteCloser
	if f := os.NewFile(3, "ready"); f != nil {
		ready = f
	}
	return Serve(*dir, version, ready)
}

// Serve owns one session for the life of the process. It returns after a
// close request, after self-reap, or on a listener error. ready, when
// non-nil, receives one byte once the socket is listening — the spawn
// handshake's "you may dial now".
func Serve(dir, version string, ready io.WriteCloser) error {
	sockPath := filepath.Join(dir, SocketName)
	// A previous holder that died without cleanup leaves a dead socket file;
	// nothing else can legitimately be listening here, so replace it.
	_ = os.Remove(sockPath)
	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		return err
	}
	defer ln.Close()
	if ready != nil {
		_, _ = ready.Write([]byte{1})
		_ = ready.Close()
	}

	h := &holder{dir: dir, version: version, born: time.Now(), done: make(chan struct{})}
	go h.watch()

	// SIGTERM is the machine going down or the user's login ending — the
	// events a holder cannot outlive. That is exactly when the old
	// daemon-side snapshot used to be written, so the holder writes it now:
	// scrollback, identity, and the agent resume hint land in the snapshots
	// directory for the next boot's revive pass. The daemon's close verb is
	// the opposite case — a deliberate retirement — and snapshots nothing.
	sigc := make(chan os.Signal, 1)
	signal.Notify(sigc, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		defer signal.Stop(sigc)
		select {
		case <-sigc:
			h.shutdownOnSignal()
		case <-h.done:
		}
	}()

	go func() {
		<-h.done
		ln.Close()
	}()
	for {
		conn, err := ln.Accept()
		if err != nil {
			select {
			case <-h.done:
				return nil
			default:
				return err
			}
		}
		go h.serveConn(conn)
	}
}

type holder struct {
	dir     string
	version string
	born    time.Time

	mu       sync.Mutex
	sess     *session.Session
	ctrl     map[*ctrlConn]struct{}
	lastSeen time.Time // last moment a control connection existed
	closing  bool

	done chan struct{}
}

// ctrlConn is one control connection: requests answered in order, events
// interleaved. The write mutex is what keeps a reply and an event from
// tearing each other's frames.
type ctrlConn struct {
	conn net.Conn
	wmu  sync.Mutex
}

func (c *ctrlConn) send(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	c.wmu.Lock()
	defer c.wmu.Unlock()
	return holdwire.WriteFrame(c.conn, holdwire.TJSON, b)
}

func (h *holder) serveConn(conn net.Conn) {
	defer conn.Close()
	typ, p, err := holdwire.ReadFrame(conn)
	if err != nil || typ != holdwire.TJSON {
		return
	}
	var req holdwire.Req
	if err := json.Unmarshal(p, &req); err != nil {
		return
	}
	if req.Verb == "attach" {
		h.serveAttach(conn, req)
		return
	}

	cc := &ctrlConn{conn: conn}
	h.mu.Lock()
	if h.ctrl == nil {
		h.ctrl = map[*ctrlConn]struct{}{}
	}
	h.ctrl[cc] = struct{}{}
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(h.ctrl, cc)
		h.lastSeen = time.Now()
		h.mu.Unlock()
	}()

	for {
		_ = cc.send(h.handle(req))
		typ, p, err := holdwire.ReadFrame(conn)
		if err != nil || typ != holdwire.TJSON {
			return
		}
		req = holdwire.Req{}
		if err := json.Unmarshal(p, &req); err != nil {
			return
		}
	}
}

func (h *holder) handle(req holdwire.Req) holdwire.Resp {
	resp := holdwire.Resp{ID: req.ID}
	fail := func(err error) holdwire.Resp {
		resp.Err = err.Error()
		return resp
	}

	h.mu.Lock()
	s := h.sess
	h.mu.Unlock()

	switch req.Verb {
	case "hello":
		hello := &holdwire.Hello{Proto: holdwire.Proto, Version: h.version}
		if s != nil {
			info, err := json.Marshal(s.Info())
			if err != nil {
				return fail(err)
			}
			hello.Info = info
			hello.Pid = s.Pid()
			hello.BaseSeq, hello.EndSeq = s.Seqs()
		}
		resp.Hello = hello
	case "spawn":
		if req.Spawn == nil {
			return fail(errors.New("spawn request carries no config"))
		}
		if s != nil {
			return fail(errors.New("holder already runs a session"))
		}
		var restore session.Info
		if len(req.Spawn.Restore) > 0 {
			if err := json.Unmarshal(req.Spawn.Restore, &restore); err != nil {
				return fail(err)
			}
		}
		sess, err := session.StartChild(session.ChildConfig{
			ID:        req.Spawn.ID,
			Run:       req.Spawn.Run,
			Argv:      req.Spawn.Argv,
			Env:       req.Spawn.Env,
			Cwd:       req.Spawn.Cwd,
			Cols:      req.Spawn.Cols,
			Rows:      req.Spawn.Rows,
			RingSize:  req.Spawn.RingSize,
			Preload:   req.Spawn.Preload,
			Restore:   restore,
			Group:     req.Spawn.Group,
			Ephemeral: req.Spawn.Ephemeral,
		})
		if err != nil {
			return fail(err)
		}
		h.mu.Lock()
		h.sess = sess
		h.mu.Unlock()
		go h.pushEvents(sess)
	case "write":
		if s == nil {
			return fail(errors.New("no session"))
		}
		if err := s.Write(req.Data); err != nil {
			return fail(err)
		}
	case "resize":
		if s == nil {
			return fail(errors.New("no session"))
		}
		if err := s.Resize(req.Cols, req.Rows); err != nil {
			return fail(err)
		}
	case "signal":
		if s == nil {
			return fail(errors.New("no session"))
		}
		if err := s.Signal(syscall.Signal(req.Sig)); err != nil {
			return fail(err)
		}
	case "tail":
		if s == nil {
			return fail(errors.New("no session"))
		}
		data, cols, rows := s.Tail(req.N)
		resp.Data, resp.Cols, resp.Rows = data, cols, rows
	case "close":
		// Reply first, then die: the daemon deserves its ack, and everything
		// after it is this process ending. The engine's Close kills the
		// process group; closing done tears the listener down and Serve
		// returns.
		h.mu.Lock()
		closing := h.closing
		h.closing = true
		h.mu.Unlock()
		if !closing {
			if s != nil {
				go func() {
					_ = s.Close()
					close(h.done)
				}()
			} else {
				close(h.done)
			}
		}
	default:
		return fail(fmt.Errorf("unknown verb %q", req.Verb))
	}
	return resp
}

func (h *holder) serveAttach(conn net.Conn, req holdwire.Req) {
	h.mu.Lock()
	s := h.sess
	h.mu.Unlock()
	head := holdwire.Resp{ID: req.ID}
	if s == nil {
		head.Err = "no session"
		b, _ := json.Marshal(head)
		_ = holdwire.WriteFrame(conn, holdwire.TJSON, b)
		return
	}
	sub := s.Subscribe(req.FromSeq)
	defer s.Unsubscribe(sub)
	head.StartSeq, head.Truncated, head.Data = sub.StartSeq, sub.Truncated, sub.Backlog
	b, _ := json.Marshal(head)
	if err := holdwire.WriteFrame(conn, holdwire.TJSON, b); err != nil {
		return
	}
	// Reads from the peer are how its hangup is noticed; nothing legitimate
	// arrives on an attach connection after the header.
	go func() {
		_, _ = io.Copy(io.Discard, conn)
		s.Unsubscribe(sub)
	}()
	for chunk := range sub.C {
		if err := holdwire.WriteFrame(conn, holdwire.TChunk, chunk); err != nil {
			return
		}
	}
}

// pushEvents watches the engine and tells every control connection what
// changed: the title, an activity stamp (throttled), and — once — the exit.
// A poll rather than engine hooks: the engine stays exactly what it was
// in-process, and 4 reads a second in a process that exists for one session
// is beneath measuring.
func (h *holder) pushEvents(s *session.Session) {
	var (
		lastTitle    string
		lastActive   time.Time
		lastActiveEv time.Time
		exitSent     bool
	)
	tick := time.NewTicker(eventPoll)
	defer tick.Stop()
	for {
		select {
		case <-h.done:
			return
		case <-tick.C:
		}
		info := s.Info()
		var evs []holdwire.Event
		if info.Title != lastTitle {
			lastTitle = info.Title
			evs = append(evs, holdwire.Event{Event: "title", Title: info.Title})
		}
		if info.LastActive.After(lastActive) {
			lastActive = info.LastActive
			if time.Since(lastActiveEv) >= activeThrottle {
				lastActiveEv = time.Now()
				evs = append(evs, holdwire.Event{Event: "active", At: info.LastActive})
			}
		}
		if info.State == "exited" && !exitSent {
			exitSent = true
			evs = append(evs, holdwire.Event{Event: "exit", Code: info.ExitCode, At: time.Now()})
		}
		if len(evs) == 0 {
			continue
		}
		h.mu.Lock()
		conns := make([]*ctrlConn, 0, len(h.ctrl))
		for cc := range h.ctrl {
			conns = append(conns, cc)
		}
		h.mu.Unlock()
		for _, cc := range conns {
			for _, ev := range evs {
				_ = cc.send(ev)
			}
		}
	}
}

// shutdownOnSignal is the holder's half of a graceful machine or login
// shutdown: snapshot for revival, close the session, exit. The holder dir
// is left in place on purpose — the next boot's reattach pass finds its
// socket dead, sweeps the dir, and the revive pass brings the session back
// from the snapshot written here.
func (h *holder) shutdownOnSignal() {
	h.mu.Lock()
	s := h.sess
	closing := h.closing
	h.closing = true
	h.mu.Unlock()
	if closing {
		return
	}
	if s != nil {
		if snap, ok := s.SnapshotForShutdown(); ok {
			if dir, err := config.Dir(); err == nil {
				_ = session.SaveSnapshots(filepath.Join(dir, session.SnapshotsDirName), []session.Snapshot{snap})
			}
		}
		_ = s.Close()
	}
	close(h.done)
}

// watch is the self-reap guard: a holder whose child has exited and whose
// daemon has not spoken for orphanGrace removes its directory and exits.
// While a daemon holds a control connection the holder never self-reaps —
// retirement is the daemon's call, made through close.
func (h *holder) watch() {
	tick := time.NewTicker(time.Minute)
	defer tick.Stop()
	for {
		select {
		case <-h.done:
			return
		case <-tick.C:
		}
		h.mu.Lock()
		s, seen, held := h.sess, h.lastSeen, len(h.ctrl) > 0
		h.mu.Unlock()
		if held {
			continue
		}
		// A live child pins the holder no matter how absent the daemon is —
		// keeping that process running is the product. What may be reaped is
		// a holder with nothing to hold: its child exited, or a session was
		// never spawned at all (a daemon that died mid-handshake and whose
		// successor has no identity record to reattach by).
		if s != nil && s.Info().State != "exited" {
			continue
		}
		// The idle clock starts when the last daemon hung up, or at birth
		// for a holder no daemon ever spoke to.
		idle := seen
		if idle.IsZero() {
			idle = h.born
		}
		if time.Since(idle) < orphanGrace {
			continue
		}
		_ = os.RemoveAll(h.dir)
		close(h.done)
		return
	}
}
