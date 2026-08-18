package session

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/karnstack/flue/internal/holdwire"
)

// HolderSocketName mirrors holder.SocketName. Declared here rather than
// imported because the dependency runs the other way: the holder package
// imports this one for the engine.
const HolderSocketName = "holder.sock"

// identityName is the daemon-owned record beside the holder's socket.
const identityName = "session.json"

// maxSockPath is the ceiling this package enforces on a holder socket path.
// sockaddr_un is 104 bytes on darwin and 108 on linux; refusing at 100
// leaves slack and one clear error instead of a bind failure that blames
// the wrong layer.
const maxSockPath = 100

// remoteCallTimeout bounds every control round trip. The holder answers
// from memory, so anything slower than this is a holder that is gone.
var remoteCallTimeout = 10 * time.Second

// IdentityRecord is the daemon's half of a holder-backed session's state:
// the fields the daemon owns and the holder is never asked about. Written
// at spawn and rewritten on the one edit that changes it (an ephemeral
// scratch being kept); read at reattach.
type IdentityRecord struct {
	V         int       `json:"v"`
	ID        string    `json:"id"`
	Cmd       []string  `json:"cmd"`
	Group     string    `json:"group,omitempty"`
	Ephemeral bool      `json:"ephemeral,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
}

// SaveIdentity writes dir/session.json, 0600 on a fresh inode like every
// other record in the config tree.
func SaveIdentity(dir string, rec IdentityRecord) error {
	b, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, identityName+"-*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpPath, filepath.Join(dir, identityName))
}

// LoadIdentity reads dir/session.json.
func LoadIdentity(dir string) (IdentityRecord, error) {
	b, err := os.ReadFile(filepath.Join(dir, identityName))
	if err != nil {
		return IdentityRecord{}, err
	}
	var rec IdentityRecord
	if err := json.Unmarshal(b, &rec); err != nil {
		return IdentityRecord{}, err
	}
	if rec.ID == "" {
		return IdentityRecord{}, errors.New("session: identity record carries no id")
	}
	return rec, nil
}

// Remote is a holder-backed session: the same Handle surface *Session
// serves in-process, answered from a cache the holder's events keep fresh,
// with the writes crossing the socket. The daemon holds nothing here a
// restart can lose — a fresh daemon rebuilds a Remote from the socket and
// the identity record alone.
type Remote struct {
	dir   string
	clock func() time.Time
	cwdOf func(pid int) (string, error)

	mu       sync.Mutex
	info     Info
	pid      int
	exitedAt time.Time
	closed   bool
	ctrl     *remoteCtrl
	subs     map[*Sub]net.Conn
}

var _ handle = (*Remote)(nil)

// SpawnRemote launches `exe _holder --dir dir`, waits for its socket, and
// spawns cfg into it. The holder is setsid'd away from the daemon so a
// daemon exit never takes it along; its stderr lands in dir/holder.log.
func SpawnRemote(exe, dir string, cfg ChildConfig, clock func() time.Time) (*Remote, error) {
	sock := filepath.Join(dir, HolderSocketName)
	if len(sock) > maxSockPath {
		return nil, fmt.Errorf("session: holder socket path %q exceeds %d bytes; the config directory sits too deep", sock, maxSockPath)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	logf, err := os.OpenFile(filepath.Join(dir, "holder.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil, err
	}
	defer logf.Close()
	pr, pw, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	defer pr.Close()

	cmd := exec.Command(exe, "_holder", "--dir", dir)
	cmd.Stdout = logf
	cmd.Stderr = logf
	cmd.ExtraFiles = []*os.File{pw} // fd 3, the ready pipe
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		pw.Close()
		return nil, err
	}
	pw.Close()
	// Reap the holder whenever it eventually exits so a retired holder never
	// lingers as a zombie under a long-lived daemon.
	go func() { _ = cmd.Wait() }()

	readyErr := make(chan error, 1)
	go func() {
		var b [1]byte
		if _, err := pr.Read(b[:]); err != nil {
			readyErr <- fmt.Errorf("holder ended before listening (see %s)", filepath.Join(dir, "holder.log"))
			return
		}
		readyErr <- nil
	}()
	select {
	case err := <-readyErr:
		if err != nil {
			return nil, err
		}
	case <-time.After(remoteCallTimeout):
		return nil, errors.New("session: holder never reported ready")
	}

	r, err := newRemote(dir, clock)
	if err != nil {
		return nil, err
	}
	restore, err := json.Marshal(cfg.Restore)
	if err != nil {
		r.teardown()
		return nil, err
	}
	spawn := &holdwire.SpawnReq{
		ID: cfg.ID, Run: cfg.Run, Argv: cfg.Argv, Env: cfg.Env, Cwd: cfg.Cwd,
		Cols: cfg.Cols, Rows: cfg.Rows, RingSize: cfg.RingSize,
		Preload: cfg.Preload, Restore: restore,
		Group: cfg.Group, Ephemeral: cfg.Ephemeral,
	}
	if _, err := r.call(holdwire.Req{Verb: "spawn", Spawn: spawn}); err != nil {
		r.teardown()
		return nil, err
	}
	if err := r.refreshHello(); err != nil {
		r.teardown()
		return nil, err
	}
	return r, nil
}

// DialRemote rebuilds a Remote from a live holder's socket and the identity
// record beside it: the reattach path. The record's daemon-owned fields
// win over what the holder reports for them.
func DialRemote(dir string, rec IdentityRecord, clock func() time.Time) (*Remote, error) {
	r, err := newRemote(dir, clock)
	if err != nil {
		return nil, err
	}
	if err := r.refreshHello(); err != nil {
		r.teardown()
		return nil, err
	}
	r.mu.Lock()
	if rec.ID != "" {
		r.info.ID = rec.ID
	}
	if len(rec.Cmd) > 0 {
		r.info.Cmd = rec.Cmd
	}
	if rec.Group != "" {
		r.info.Group = rec.Group
	}
	r.info.Ephemeral = rec.Ephemeral
	if !rec.CreatedAt.IsZero() {
		r.info.CreatedAt = rec.CreatedAt
	}
	r.mu.Unlock()
	return r, nil
}

func newRemote(dir string, clock func() time.Time) (*Remote, error) {
	if clock == nil {
		clock = time.Now
	}
	r := &Remote{dir: dir, clock: clock, cwdOf: processCwd, subs: map[*Sub]net.Conn{}}
	if err := r.dialCtrl(); err != nil {
		return nil, err
	}
	return r, nil
}

// remoteCtrl is one control connection: a writer serialized by wmu, and a
// reader goroutine that demuxes replies to their callers and folds events
// into the Remote's cache.
type remoteCtrl struct {
	conn net.Conn
	wmu  sync.Mutex

	mu      sync.Mutex
	pending map[uint64]chan holdwire.Resp
	nextID  uint64
	dead    bool
}

func (r *Remote) dialCtrl() error {
	conn, err := net.Dial("unix", filepath.Join(r.dir, HolderSocketName))
	if err != nil {
		return err
	}
	c := &remoteCtrl{conn: conn, pending: map[uint64]chan holdwire.Resp{}}
	r.mu.Lock()
	r.ctrl = c
	r.mu.Unlock()
	go r.readCtrl(c)
	return nil
}

func (r *Remote) readCtrl(c *remoteCtrl) {
	for {
		typ, p, err := holdwire.ReadFrame(c.conn)
		if err != nil {
			c.fail()
			r.ctrlDown(c)
			return
		}
		if typ != holdwire.TJSON {
			continue
		}
		var probe struct {
			Event string `json:"event"`
		}
		_ = json.Unmarshal(p, &probe)
		if probe.Event != "" {
			var ev holdwire.Event
			if json.Unmarshal(p, &ev) == nil {
				r.applyEvent(ev)
			}
			continue
		}
		var resp holdwire.Resp
		if json.Unmarshal(p, &resp) != nil {
			continue
		}
		c.mu.Lock()
		ch, ok := c.pending[resp.ID]
		delete(c.pending, resp.ID)
		c.mu.Unlock()
		if ok {
			ch <- resp
		}
	}
}

// fail answers every waiter with a dead-connection error.
func (c *remoteCtrl) fail() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.dead = true
	for id, ch := range c.pending {
		delete(c.pending, id)
		ch <- holdwire.Resp{ID: id, Err: "holder connection lost"}
	}
}

// ctrlDown is the reconnect policy: a Remote that is neither closed nor
// exited redials a few times, and a holder that stays unreachable is
// recorded as an exit the registry's sweep can retire — a session nobody
// can reach is not a session the list should call running.
func (r *Remote) ctrlDown(c *remoteCtrl) {
	r.mu.Lock()
	if r.ctrl == c {
		r.ctrl = nil
	}
	done := r.closed || r.info.State == "exited"
	r.mu.Unlock()
	if done {
		return
	}
	for attempt := 0; attempt < 3; attempt++ {
		time.Sleep(time.Duration(attempt) * 500 * time.Millisecond)
		if err := r.dialCtrl(); err == nil {
			_ = r.refreshHello()
			return
		}
	}
	r.markExited(-1)
}

func (r *Remote) markExited(code int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.info.State == "exited" {
		return
	}
	r.info.State = "exited"
	r.info.ExitCode = code
	r.exitedAt = r.clock()
}

func (r *Remote) applyEvent(ev holdwire.Event) {
	r.mu.Lock()
	defer r.mu.Unlock()
	switch ev.Event {
	case "title":
		r.info.Title = ev.Title
	case "active":
		if ev.At.After(r.info.LastActive) {
			r.info.LastActive = ev.At
		}
	case "exit":
		if r.info.State != "exited" {
			r.info.State = "exited"
			r.info.ExitCode = ev.Code
			r.exitedAt = ev.At
			if r.exitedAt.IsZero() {
				r.exitedAt = r.clock()
			}
		}
	}
}

// call runs one request against the current control connection.
func (r *Remote) call(req holdwire.Req) (holdwire.Resp, error) {
	r.mu.Lock()
	c := r.ctrl
	closed := r.closed
	r.mu.Unlock()
	// Close itself is the one caller that legitimately speaks after the
	// Remote is marked closed: the mark comes first so no new work sneaks
	// in, and then the holder still has to be told.
	if closed && req.Verb != "close" {
		return holdwire.Resp{}, ErrSessionClosed
	}
	if c == nil {
		if err := r.dialCtrl(); err != nil {
			return holdwire.Resp{}, fmt.Errorf("session: holder unreachable: %w", err)
		}
		r.mu.Lock()
		c = r.ctrl
		r.mu.Unlock()
	}

	ch := make(chan holdwire.Resp, 1)
	c.mu.Lock()
	if c.dead {
		c.mu.Unlock()
		return holdwire.Resp{}, errors.New("session: holder connection lost")
	}
	c.nextID++
	req.ID = c.nextID
	c.pending[req.ID] = ch
	c.mu.Unlock()

	b, err := json.Marshal(req)
	if err != nil {
		return holdwire.Resp{}, err
	}
	c.wmu.Lock()
	err = holdwire.WriteFrame(c.conn, holdwire.TJSON, b)
	c.wmu.Unlock()
	if err != nil {
		c.mu.Lock()
		delete(c.pending, req.ID)
		c.mu.Unlock()
		return holdwire.Resp{}, err
	}

	select {
	case resp := <-ch:
		if resp.Err != "" {
			return resp, errors.New(resp.Err)
		}
		return resp, nil
	case <-time.After(remoteCallTimeout):
		c.mu.Lock()
		delete(c.pending, req.ID)
		c.mu.Unlock()
		return holdwire.Resp{}, fmt.Errorf("session: holder did not answer %q", req.Verb)
	}
}

// refreshHello reseeds the cache from the holder's own account of the
// session, checking the protocol while it is there.
func (r *Remote) refreshHello() error {
	resp, err := r.call(holdwire.Req{Verb: "hello"})
	if err != nil {
		return err
	}
	if resp.Hello == nil {
		return errors.New("session: holder answered hello with nothing")
	}
	if resp.Hello.Proto != holdwire.Proto {
		return fmt.Errorf("session: holder speaks protocol %d, this daemon %d", resp.Hello.Proto, holdwire.Proto)
	}
	var helloInfo Info
	if len(resp.Hello.Info) > 0 {
		if err := json.Unmarshal(resp.Hello.Info, &helloInfo); err != nil {
			return err
		}
	}
	r.mu.Lock()
	// Keep the daemon-owned meta edits made since the cache was seeded; the
	// holder's word is authoritative for the live fields only.
	name, tags, pinned, eph := r.info.Name, r.info.Tags, r.info.Pinned, r.info.Ephemeral
	seeded := r.info.ID != ""
	r.info = helloInfo
	if seeded {
		r.info.Name, r.info.Tags, r.info.Pinned, r.info.Ephemeral = name, tags, pinned, eph
	}
	r.pid = resp.Hello.Pid
	if r.info.State == "exited" && r.exitedAt.IsZero() {
		r.exitedAt = r.clock()
	}
	r.mu.Unlock()
	return nil
}

func (r *Remote) ID() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.info.ID
}

// Dir is the holder directory this Remote speaks to.
func (r *Remote) Dir() string { return r.dir }

// Info mirrors Session.Info: the cache, with the child's cwd re-read from
// the kernel while the session runs — the holder's pid makes that a local
// question the daemon can keep answering itself.
func (r *Remote) Info() Info {
	r.mu.Lock()
	pid := r.pid
	running := r.info.State == "running"
	r.mu.Unlock()
	var cwd string
	var err error
	if running && pid > 0 {
		cwd, err = r.cwdOf(pid)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if err == nil && cwd != "" && r.info.State == "running" {
		r.info.Cwd = cwd
	}
	return r.info
}

func (r *Remote) ApplyMeta(p MetaPatch) Info {
	r.mu.Lock()
	defer r.mu.Unlock()
	if p.Name != nil {
		r.info.Name = *p.Name
	}
	if p.Tags != nil {
		r.info.Tags = normalizeTags(*p.Tags)
	}
	if p.Pinned != nil {
		r.info.Pinned = *p.Pinned
	}
	if p.Ephemeral != nil {
		r.info.Ephemeral = *p.Ephemeral
	}
	return r.info
}

func (r *Remote) Tail(n int) (data []byte, cols, rows uint16) {
	resp, err := r.call(holdwire.Req{Verb: "tail", N: n})
	if err != nil {
		r.mu.Lock()
		defer r.mu.Unlock()
		return nil, r.info.Cols, r.info.Rows
	}
	return resp.Data, resp.Cols, resp.Rows
}

func (r *Remote) Write(p []byte) error {
	r.mu.Lock()
	r.info.LastActive = r.clock()
	r.mu.Unlock()
	_, err := r.call(holdwire.Req{Verb: "write", Data: p})
	return err
}

func (r *Remote) Resize(cols, rows uint16) error {
	if _, err := r.call(holdwire.Req{Verb: "resize", Cols: cols, Rows: rows}); err != nil {
		return err
	}
	r.mu.Lock()
	r.info.Cols, r.info.Rows = cols, rows
	r.mu.Unlock()
	return nil
}

func (r *Remote) Signal(sig os.Signal) error {
	ss, ok := sig.(syscall.Signal)
	if !ok {
		return fmt.Errorf("session: signal %v is not a syscall.Signal", sig)
	}
	_, err := r.call(holdwire.Req{Verb: "signal", Sig: int(ss)})
	return err
}

// Subscribe opens one attach connection per subscriber. The Sub's contract
// is the engine's exactly: backlog plus channel is gap-free from StartSeq,
// and a subscriber that falls too far behind is dropped to reattach.
func (r *Remote) Subscribe(fromSeq uint64) *Sub {
	dead := func(truncated bool) *Sub {
		ch := make(chan []byte)
		close(ch)
		return &Sub{StartSeq: fromSeq, Truncated: truncated, C: ch, ch: ch, closed: true}
	}
	r.mu.Lock()
	closed := r.closed
	r.mu.Unlock()
	if closed {
		return dead(false)
	}

	conn, err := net.Dial("unix", filepath.Join(r.dir, HolderSocketName))
	if err != nil {
		return dead(false)
	}
	b, _ := json.Marshal(holdwire.Req{ID: 1, Verb: "attach", FromSeq: fromSeq})
	if err := holdwire.WriteFrame(conn, holdwire.TJSON, b); err != nil {
		conn.Close()
		return dead(false)
	}
	typ, p, err := holdwire.ReadFrame(conn)
	if err != nil || typ != holdwire.TJSON {
		conn.Close()
		return dead(false)
	}
	var head holdwire.Resp
	if json.Unmarshal(p, &head) != nil || head.Err != "" {
		conn.Close()
		return dead(false)
	}

	ch := make(chan []byte, subChanDepth)
	sub := &Sub{Backlog: head.Data, StartSeq: head.StartSeq, Truncated: head.Truncated, C: ch, ch: ch}
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		conn.Close()
		sub.closed = true
		close(ch)
		return sub
	}
	r.subs[sub] = conn
	r.mu.Unlock()

	go func() {
		defer r.Unsubscribe(sub)
		for {
			typ, p, err := holdwire.ReadFrame(conn)
			if err != nil {
				return
			}
			if typ != holdwire.TChunk {
				continue
			}
			select {
			case ch <- p:
			default:
				// Too far behind, the engine's own rule: drop, and the
				// subscriber reattaches from its lastSeq.
				return
			}
		}
	}()
	return sub
}

func (r *Remote) Unsubscribe(sub *Sub) {
	r.mu.Lock()
	conn, ok := r.subs[sub]
	if ok {
		delete(r.subs, sub)
	}
	wasClosed := sub.closed
	if !wasClosed {
		sub.closed = true
	}
	r.mu.Unlock()
	if ok {
		conn.Close()
	}
	if !wasClosed {
		close(sub.ch)
	}
}

// Close retires the session: the holder kills the process group and exits,
// and the holder's directory — socket, identity record, log — goes with it.
func (r *Remote) Close() error {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return nil
	}
	r.closed = true
	subs := make([]*Sub, 0, len(r.subs))
	for sub := range r.subs {
		subs = append(subs, sub)
	}
	ctrl := r.ctrl
	r.mu.Unlock()

	for _, sub := range subs {
		r.mu.Lock()
		conn := r.subs[sub]
		delete(r.subs, sub)
		wasClosed := sub.closed
		sub.closed = true
		r.mu.Unlock()
		if conn != nil {
			conn.Close()
		}
		if !wasClosed {
			close(sub.ch)
		}
	}

	// Best effort with the timeout call already enforces: a holder that is
	// gone is a holder that needs no telling.
	_, _ = r.call(holdwire.Req{Verb: "close"})
	if ctrl != nil {
		ctrl.conn.Close()
	}
	return os.RemoveAll(r.dir)
}

func (r *Remote) teardown() {
	r.mu.Lock()
	ctrl := r.ctrl
	r.closed = true
	r.mu.Unlock()
	if ctrl != nil {
		ctrl.conn.Close()
	}
}

func (r *Remote) exitStatus() (exited bool, at time.Time, ephemeral bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.info.State == "exited", r.exitedAt, r.info.Ephemeral
}

func (r *Remote) groupID() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.info.Group
}
