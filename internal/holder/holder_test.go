package holder

import (
	"bytes"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/karnstack/flue/internal/holdwire"
	"github.com/karnstack/flue/internal/session"
)

// startHolder runs Serve in-process against a fresh socket dir and returns
// the dir. The socket lives under os.TempDir directly because a deeply
// nested t.TempDir can push a unix socket path past the platform limit.
func startHolder(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "flueh")
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	done := make(chan error, 1)
	go func() { done <- Serve(dir, "test-version", nil) }()
	// Wait for the socket to appear rather than sleeping a guess.
	sock := filepath.Join(dir, SocketName)
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(sock); err == nil {
			return dir
		}
		select {
		case err := <-done:
			t.Fatalf("Serve returned before listening: %v", err)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("holder socket never appeared")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// client is a test-side control connection that demuxes replies from events.
type client struct {
	t      *testing.T
	conn   net.Conn
	nextID uint64
	events chan holdwire.Event
	resps  chan holdwire.Resp
}

func dialControl(t *testing.T, dir string) *client {
	t.Helper()
	conn, err := net.Dial("unix", filepath.Join(dir, SocketName))
	if err != nil {
		t.Fatalf("dial holder: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	c := &client{t: t, conn: conn, events: make(chan holdwire.Event, 64), resps: make(chan holdwire.Resp, 16)}
	go func() {
		for {
			typ, p, err := holdwire.ReadFrame(conn)
			if err != nil {
				close(c.events)
				close(c.resps)
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
				_ = json.Unmarshal(p, &ev)
				c.events <- ev
				continue
			}
			var resp holdwire.Resp
			_ = json.Unmarshal(p, &resp)
			c.resps <- resp
		}
	}()
	return c
}

func (c *client) roundTrip(req holdwire.Req) holdwire.Resp {
	c.t.Helper()
	req.ID = atomic.AddUint64(&c.nextID, 1)
	b, _ := json.Marshal(req)
	if err := holdwire.WriteFrame(c.conn, holdwire.TJSON, b); err != nil {
		c.t.Fatalf("write %s: %v", req.Verb, err)
	}
	select {
	case resp, ok := <-c.resps:
		if !ok {
			c.t.Fatalf("connection closed awaiting %s reply", req.Verb)
		}
		if resp.ID != req.ID {
			c.t.Fatalf("reply id %d for request %d", resp.ID, req.ID)
		}
		return resp
	case <-time.After(5 * time.Second):
		c.t.Fatalf("no reply to %s within 5s", req.Verb)
	}
	panic("unreachable")
}

func (c *client) mustOK(req holdwire.Req) holdwire.Resp {
	c.t.Helper()
	resp := c.roundTrip(req)
	if resp.Err != "" {
		c.t.Fatalf("%s: %s", req.Verb, resp.Err)
	}
	return resp
}

func spawnReq(cmd string) *holdwire.SpawnReq {
	return &holdwire.SpawnReq{
		ID:   "cafebabe11111111",
		Run:  []string{"/bin/sh", "-c", cmd},
		Argv: []string{"sh", "-c", cmd},
		Env:  []string{"TERM=xterm-256color", "PATH=/usr/bin:/bin"},
		Cwd:  "/",
		Cols: 80, Rows: 24,
	}
}

func TestHolderSpawnHelloAttachWrite(t *testing.T) {
	dir := startHolder(t)
	c := dialControl(t, dir)

	hello := c.mustOK(holdwire.Req{Verb: "hello"}).Hello
	if hello == nil || hello.Proto != holdwire.Proto || hello.Version != "test-version" {
		t.Fatalf("pre-spawn hello = %+v", hello)
	}
	if hello.Pid != 0 {
		t.Fatalf("pre-spawn hello reports pid %d", hello.Pid)
	}

	c.mustOK(holdwire.Req{Verb: "spawn", Spawn: spawnReq("printf ready-mark; exec cat")})
	if resp := c.roundTrip(holdwire.Req{Verb: "spawn", Spawn: spawnReq("true")}); resp.Err == "" {
		t.Fatal("second spawn was accepted")
	}

	hello = c.mustOK(holdwire.Req{Verb: "hello"}).Hello
	if hello.Pid == 0 || hello.Info.State != "running" || hello.Info.ID != "cafebabe11111111" {
		t.Fatalf("post-spawn hello = %+v", hello)
	}

	// Attach from zero: backlog plus stream carries everything.
	att, err := net.Dial("unix", filepath.Join(dir, SocketName))
	if err != nil {
		t.Fatalf("dial attach: %v", err)
	}
	defer att.Close()
	b, _ := json.Marshal(holdwire.Req{ID: 1, Verb: "attach", FromSeq: 0})
	if err := holdwire.WriteFrame(att, holdwire.TJSON, b); err != nil {
		t.Fatalf("attach header: %v", err)
	}
	typ, p, err := holdwire.ReadFrame(att)
	if err != nil || typ != holdwire.TJSON {
		t.Fatalf("attach reply: type %d, %v", typ, err)
	}
	var head holdwire.Resp
	_ = json.Unmarshal(p, &head)
	if head.Err != "" {
		t.Fatalf("attach: %s", head.Err)
	}

	c.mustOK(holdwire.Req{Verb: "write", Data: []byte("echo-me\n")})

	var got bytes.Buffer
	got.Write(head.Data)
	deadline := time.Now().Add(5 * time.Second)
	for !strings.Contains(got.String(), "ready-mark") || !strings.Contains(got.String(), "echo-me") {
		if time.Now().After(deadline) {
			t.Fatalf("stream never carried both marks; have %q", got.String())
		}
		att.SetReadDeadline(time.Now().Add(time.Second))
		typ, p, err := holdwire.ReadFrame(att)
		if err != nil {
			t.Fatalf("stream read: %v (have %q)", err, got.String())
		}
		if typ == holdwire.TChunk {
			got.Write(p)
		}
	}

	// Tail sees the same bytes without an attachment.
	tail := c.mustOK(holdwire.Req{Verb: "tail", N: 4096})
	if !strings.Contains(string(tail.Data), "ready-mark") {
		t.Fatalf("tail = %q, want the ring contents", tail.Data)
	}
	if tail.Cols != 80 || tail.Rows != 24 {
		t.Fatalf("tail size = %dx%d", tail.Cols, tail.Rows)
	}
}

func TestHolderReportsExitAsEvent(t *testing.T) {
	dir := startHolder(t)
	c := dialControl(t, dir)
	c.mustOK(holdwire.Req{Verb: "spawn", Spawn: spawnReq("exec sleep 60")})
	c.mustOK(holdwire.Req{Verb: "signal", Sig: int(syscall.SIGTERM)})

	deadline := time.After(5 * time.Second)
	for {
		select {
		case ev, ok := <-c.events:
			if !ok {
				t.Fatal("control connection closed before the exit event")
			}
			if ev.Event == "exit" {
				if ev.At.IsZero() {
					t.Error("exit event carries no timestamp")
				}
				return
			}
		case <-deadline:
			t.Fatal("no exit event within 5s")
		}
	}
}

func TestHolderCloseEndsTheProcessGroup(t *testing.T) {
	dir := startHolder(t)
	c := dialControl(t, dir)
	c.mustOK(holdwire.Req{Verb: "spawn", Spawn: spawnReq("exec sleep 60")})
	pid := c.mustOK(holdwire.Req{Verb: "hello"}).Hello.Pid

	c.mustOK(holdwire.Req{Verb: "close"})

	deadline := time.Now().Add(5 * time.Second)
	for syscall.Kill(pid, 0) == nil {
		if time.Now().After(deadline) {
			t.Fatalf("child %d still alive after close", pid)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestHolderResizePropagates(t *testing.T) {
	dir := startHolder(t)
	c := dialControl(t, dir)
	c.mustOK(holdwire.Req{Verb: "spawn", Spawn: spawnReq("exec cat")})
	c.mustOK(holdwire.Req{Verb: "resize", Cols: 132, Rows: 43})
	hello := c.mustOK(holdwire.Req{Verb: "hello"}).Hello
	if hello.Info.Cols != 132 || hello.Info.Rows != 43 {
		t.Fatalf("size after resize = %dx%d, want 132x43", hello.Info.Cols, hello.Info.Rows)
	}
}

// Restore fields matter to reattach: a holder that carries a preload and a
// restore record reports them the way a revived in-process session would.
func TestHolderSpawnHonorsPreloadAndRestore(t *testing.T) {
	dir := startHolder(t)
	c := dialControl(t, dir)
	req := spawnReq("exec cat")
	req.Preload = []byte("old-scrollback\r\n")
	req.Restore = session.Info{Title: "carried title"}
	c.mustOK(holdwire.Req{Verb: "spawn", Spawn: req})

	tail := c.mustOK(holdwire.Req{Verb: "tail", N: 4096})
	if !strings.HasPrefix(string(tail.Data), "old-scrollback") {
		t.Fatalf("tail = %q, want the preload first", tail.Data)
	}
	hello := c.mustOK(holdwire.Req{Verb: "hello"}).Hello
	if hello.Info.Title != "carried title" {
		t.Fatalf("Title = %q, want the restored one", hello.Info.Title)
	}
}
