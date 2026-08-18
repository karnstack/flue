package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// TestSessionsSurviveDaemonRestart is the whole feature, end to end, against
// the real binary: spawn a session through a real daemon, SIGTERM the
// daemon, start a new one, and find the same session — same id, same child
// process, scrollback intact. Skipped under -short because it builds the
// binary and runs two daemons.
func TestSessionsSurviveDaemonRestart(t *testing.T) {
	if testing.Short() {
		t.Skip("builds the flue binary and runs real daemons")
	}

	// The config dir must sit shallow enough for the holder socket path; a
	// nested t.TempDir can blow the platform's sockaddr limit.
	xdg, err := os.MkdirTemp("", "fe")
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(xdg) })

	// Not xdg/flue: config.Dir wants to create a directory by that name.
	bin := filepath.Join(xdg, "bin", "flue")
	if err := os.MkdirAll(filepath.Dir(bin), 0o755); err != nil {
		t.Fatal(err)
	}
	build := exec.Command("go", "build", "-o", bin, ".")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}

	port := freePort(t)
	env := append(os.Environ(), "XDG_CONFIG_HOME="+xdg)

	daemon1 := startDaemon(t, bin, port, env)
	token := readToken(t, xdg)

	// A child that names its own pid is the witness: the same line after
	// the restart proves the same process, not a lookalike.
	ws := dialWS(t, port, token)
	send(t, ws, map[string]any{
		"type": "spawn", "reqId": 1, "cols": 80, "rows": 24, "cwd": "/",
		"cmd": []string{"/bin/sh", "-c", `echo "MARK-$$"; exec sleep 300`},
	})
	sessionID := awaitAttached(t, ws)
	backlog := awaitMark(t, ws)
	childPid := pidFromMark(t, backlog)
	ws.Close(websocket.StatusNormalClosure, "")

	// The restart: graceful SIGTERM, as a service manager would deliver it.
	if err := daemon1.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatalf("SIGTERM daemon: %v", err)
	}
	if _, err := daemon1.Process.Wait(); err != nil {
		t.Fatalf("daemon did not exit: %v", err)
	}

	daemon2 := startDaemon(t, bin, port, env)
	defer func() {
		_ = daemon2.Process.Signal(syscall.SIGTERM)
		_, _ = daemon2.Process.Wait()
	}()

	infos, err := fetchSessions(port, token)
	if err != nil {
		t.Fatalf("fetchSessions: %v", err)
	}
	var found bool
	for _, s := range infos {
		if s.ID == sessionID {
			found = true
			if s.State != "running" {
				t.Fatalf("session %s State = %q after restart, want running", s.ID, s.State)
			}
		}
	}
	if !found {
		t.Fatalf("session %s is gone after the restart; got %+v", sessionID, infos)
	}

	if err := syscall.Kill(childPid, 0); err != nil {
		t.Fatalf("child %d is dead after the restart: %v", childPid, err)
	}

	ws2 := dialWS(t, port, token)
	defer ws2.Close(websocket.StatusNormalClosure, "")
	send(t, ws2, map[string]any{"type": "attach", "id": sessionID, "lastSeq": 0, "reqId": 2})
	backlog2 := awaitMark(t, ws2)
	if pid2 := pidFromMark(t, backlog2); pid2 != childPid {
		t.Fatalf("marker pid changed across restart: %d then %d", childPid, pid2)
	}

	// Retire the session so nothing outlives the test.
	send(t, ws2, map[string]any{"type": "close", "id": sessionID})
	deadline := time.Now().Add(5 * time.Second)
	for syscall.Kill(childPid, 0) == nil {
		if time.Now().After(deadline) {
			t.Fatalf("child %d survived the close", childPid)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	return port
}

func startDaemon(t *testing.T, bin string, port int, env []string) *exec.Cmd {
	t.Helper()
	cmd := exec.Command(bin, "serve", "--port", strconv.Itoa(port))
	cmd.Env = env
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatalf("start daemon: %v", err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 200*time.Millisecond)
		if err == nil {
			conn.Close()
			return cmd
		}
		if time.Now().After(deadline) {
			t.Fatal("daemon never bound its port")
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func readToken(t *testing.T, xdg string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(xdg, "flue", "token"))
	if err != nil {
		t.Fatalf("read token: %v", err)
	}
	return strings.TrimSpace(string(b))
}

func dialWS(t *testing.T, port int, token string) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	ws, _, err := websocket.Dial(ctx, fmt.Sprintf("ws://127.0.0.1:%d/ws", port), &websocket.DialOptions{
		HTTPHeader: http.Header{"X-Flue-Token": []string{token}},
	})
	if err != nil {
		t.Fatalf("ws dial: %v", err)
	}
	ws.SetReadLimit(1 << 22)
	return ws
}

func send(t *testing.T, ws *websocket.Conn, msg map[string]any) {
	t.Helper()
	b, _ := json.Marshal(msg)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := ws.Write(ctx, websocket.MessageText, b); err != nil {
		t.Fatalf("ws write %v: %v", msg["type"], err)
	}
}

// awaitAttached reads until the attached control message and returns the
// session id it names.
func awaitAttached(t *testing.T, ws *websocket.Conn) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for {
		typ, b, err := ws.Read(ctx)
		if err != nil {
			t.Fatalf("ws read awaiting attached: %v", err)
		}
		if typ != websocket.MessageText {
			continue
		}
		var m struct {
			Type string `json:"type"`
			ID   string `json:"id"`
			Msg  string `json:"msg"`
		}
		if json.Unmarshal(b, &m) != nil {
			continue
		}
		if m.Type == "error" {
			t.Fatalf("daemon answered error: %s", m.Msg)
		}
		if m.Type == "attached" {
			return m.ID
		}
	}
}

// awaitMark accumulates stream output until the MARK-<pid> line is whole.
// Output frames are binary; everything else is control chatter to skip.
func awaitMark(t *testing.T, ws *websocket.Conn) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var out strings.Builder
	for {
		typ, b, err := ws.Read(ctx)
		if err != nil {
			t.Fatalf("ws read awaiting mark: %v (have %q)", err, out.String())
		}
		if typ == websocket.MessageBinary {
			out.Write(b)
		}
		if markRE.MatchString(out.String()) {
			return out.String()
		}
	}
}

var markRE = regexp.MustCompile(`MARK-(\d+)`)

func pidFromMark(t *testing.T, s string) int {
	t.Helper()
	m := markRE.FindStringSubmatch(s)
	if m == nil {
		t.Fatalf("no MARK line in %q", s)
	}
	pid, err := strconv.Atoi(m[1])
	if err != nil {
		t.Fatalf("bad pid in mark: %v", err)
	}
	return pid
}
