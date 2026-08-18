package daemon

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/karnstack/flue/internal/agentstore"
	"github.com/karnstack/flue/internal/wire"
)

const (
	agentClaudeID = "11111111-1111-4111-8111-111111111111"
	agentCodexID  = "22222222-2222-4222-8222-222222222222"
	agentPiID     = "33333333-3333-4333-8333-333333333333"
)

// agentFixtureHome lays the three stores out under a throwaway home, from the
// same fixtures the agentstore tests parse — the slug for /home/dev/proj is
// its bytes with everything non-alphanumeric mapped to '-'.
func agentFixtureHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	copyFixture := func(name, dest string) {
		b, err := os.ReadFile(filepath.Join("..", "agentstore", "testdata", name))
		if err != nil {
			t.Fatalf("read fixture: %v", err)
		}
		if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
			t.Fatalf("MkdirAll: %v", err)
		}
		if err := os.WriteFile(dest, b, 0o600); err != nil {
			t.Fatalf("WriteFile: %v", err)
		}
	}
	copyFixture("claude-session.jsonl",
		filepath.Join(home, ".claude", "projects", "-home-dev-proj", agentClaudeID+".jsonl"))
	copyFixture("codex-rollout.jsonl",
		filepath.Join(home, ".codex", "sessions", "2026", "07", "01", "rollout-2026-07-01T10-00-00-"+agentCodexID+".jsonl"))
	copyFixture("pi-session.jsonl",
		filepath.Join(home, ".pi", "agent", "sessions", "--home-dev-proj--", "2026-03-27T12-35-33_"+agentPiID+".jsonl"))
	return home
}

// newAgentTestServer is newTestServer with a transcript index wired, the way
// cmd/flue wires one — after construction, which is also why SetAgentIndex
// exists rather than a parameter on New.
func newAgentTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	ts, _, srv := newTestServerUI(t, http.NotFoundHandler())
	srv.SetAgentIndex(agentstore.New(t.TempDir(), agentFixtureHome(t)))
	return ts
}

// settleAgents polls the agents verb until the sweep has run and the list is
// populated, and returns the settled index. The first answer legitimately
// says building with no sessions — the verb never waits for the sweep it
// triggered — so a client polls, and this helper is that client.
func settleAgents(t *testing.T, c *websocket.Conn) wire.AgentIndex {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for reqID := uint64(1000); ; reqID++ {
		writeControl(t, c, wire.Agents{ReqID: reqID})
		var got wire.AgentIndex
		readUntil(t, c, func(msg any, _ []byte) bool {
			ai, ok := msg.(wire.AgentIndex)
			if ok && ai.ReqID == reqID {
				got = ai
				return true
			}
			return false
		})
		if !got.Building && len(got.Sessions) > 0 {
			return got
		}
		if time.Now().After(deadline) {
			t.Fatalf("the index never settled: building %v, %d sessions", got.Building, len(got.Sessions))
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestWelcomeAdvertisesAgentsOnlyWithAnIndex(t *testing.T) {
	// With an index: the cap is there.
	ts := newAgentTestServer(t)
	c := dial(t, ts)
	readUntil(t, c, func(msg any, _ []byte) bool {
		w, ok := msg.(wire.Welcome)
		if !ok {
			return false
		}
		if !slices.Contains(w.Caps, "agents") {
			t.Errorf("caps = %v, want them to carry agents", w.Caps)
		}
		return true
	})

	// Without: no cap, and the verbs answer bad_message rather than sitting
	// silent — the race a client that raced the welcome can still hit.
	bare, _ := newTestServer(t)
	c2 := dial(t, bare)
	readUntil(t, c2, func(msg any, _ []byte) bool {
		w, ok := msg.(wire.Welcome)
		if !ok {
			return false
		}
		if slices.Contains(w.Caps, "agents") {
			t.Errorf("caps = %v on a daemon with no index", w.Caps)
		}
		return true
	})
	for i, send := range []func(){
		func() { writeControl(t, c2, wire.Agents{ReqID: 21}) },
		func() { writeControl(t, c2, wire.AgentRead{Tool: "claude", ID: agentClaudeID, ReqID: 21}) },
		func() { writeControl(t, c2, wire.AgentSearch{Query: "x", ReqID: 21}) },
	} {
		send()
		readUntil(t, c2, func(msg any, _ []byte) bool {
			e, ok := msg.(wire.Error)
			if !ok {
				return false
			}
			if e.Code != "bad_message" || e.ReqID != 21 {
				t.Errorf("verb %d: error = %+v, want bad_message for reqId 21", i, e)
			}
			return true
		})
	}
}

func TestAgentsListsTranscriptsNewestFirst(t *testing.T) {
	ts := newAgentTestServer(t)
	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})

	idx := settleAgents(t, c)
	if len(idx.Sessions) != 3 {
		t.Fatalf("sessions = %d, want 3", len(idx.Sessions))
	}
	for i, want := range []string{"claude", "codex", "pi"} {
		if string(idx.Sessions[i].Tool) != want {
			t.Errorf("sessions[%d].Tool = %s, want %s (newest first)", i, idx.Sessions[i].Tool, want)
		}
	}
	s := idx.Sessions[0]
	if s.ID != agentClaudeID || s.Title != "Fix flaky nginx test" || s.Cwd != "/home/dev/proj" {
		t.Errorf("claude summary = %+v", s)
	}
	if want := (agentstore.TokenUsage{Input: 42, Output: 65, CacheRead: 3600, CacheWrite: 600}); s.Tokens != want {
		t.Errorf("claude Tokens = %+v, want %+v (requestId dedupe)", s.Tokens, want)
	}
	if s.Resume == nil || len(s.Resume.Cmd) != 3 || s.Resume.Cmd[0] != "claude" {
		t.Errorf("claude Resume = %+v", s.Resume)
	}

	// And the filters ride the verb.
	writeControl(t, c, wire.Agents{Tools: []string{"pi"}, ReqID: 7})
	readUntil(t, c, func(msg any, _ []byte) bool {
		ai, ok := msg.(wire.AgentIndex)
		if !ok || ai.ReqID != 7 {
			return false
		}
		if len(ai.Sessions) != 1 || ai.Sessions[0].Tool != "pi" {
			t.Errorf("filtered sessions = %+v, want the pi session alone", ai.Sessions)
		}
		return true
	})
}

func TestAgentReadPagesForwardAndBackward(t *testing.T) {
	ts := newAgentTestServer(t)
	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	settleAgents(t, c)

	// Forward from the top: the first three normalized messages.
	writeControl(t, c, wire.AgentRead{Tool: "claude", ID: agentClaudeID, Offset: 0, Limit: 3, ReqID: 31})
	var first wire.AgentPage
	readUntil(t, c, func(msg any, _ []byte) bool {
		p, ok := msg.(wire.AgentPage)
		if ok && p.ReqID == 31 {
			first = p
			return true
		}
		return false
	})
	if first.Tool != "claude" || first.ID != agentClaudeID {
		t.Errorf("page identity = (%s, %s)", first.Tool, first.ID)
	}
	if len(first.Messages) != 3 || first.Messages[2].Kind != "text" || first.Messages[2].Role != "user" {
		t.Errorf("forward page = %+v, want the caveat, the /clear echo and the prompt", first.Messages)
	}
	if first.Eof {
		t.Error("Eof = true with the file half read")
	}

	// The next page continues from Next, no cursor state on the daemon.
	writeControl(t, c, wire.AgentRead{Tool: "claude", ID: agentClaudeID, Offset: first.Next, Limit: 100, ReqID: 32})
	readUntil(t, c, func(msg any, _ []byte) bool {
		p, ok := msg.(wire.AgentPage)
		if !ok || p.ReqID != 32 {
			return false
		}
		if len(p.Messages) != 5 || !p.Eof {
			t.Errorf("second page = %d messages eof %v, want 5 and true", len(p.Messages), p.Eof)
		}
		return true
	})

	// Backward from the end — offset = fileSize is jump-to-end.
	writeControl(t, c, wire.AgentRead{Tool: "claude", ID: agentClaudeID, Offset: first.FileSize, Dir: "backward", Limit: 3, ReqID: 33})
	readUntil(t, c, func(msg any, _ []byte) bool {
		p, ok := msg.(wire.AgentPage)
		if !ok || p.ReqID != 33 {
			return false
		}
		kinds := []string{}
		for _, m := range p.Messages {
			kinds = append(kinds, m.Kind)
		}
		if !slices.Equal(kinds, []string{"tool_call", "tool_result", "text"}) {
			t.Errorf("backward page kinds = %v", kinds)
		}
		if !p.Eof || p.Start != p.Messages[0].Offset {
			t.Errorf("backward page = start %d eof %v", p.Start, p.Eof)
		}
		return true
	})
}

func TestAgentSearchFindsAndBounds(t *testing.T) {
	ts := newAgentTestServer(t)
	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	settleAgents(t, c)

	writeControl(t, c, wire.AgentSearch{Query: "NGINX", ReqID: 41})
	readUntil(t, c, func(msg any, _ []byte) bool {
		h, ok := msg.(wire.AgentHits)
		if !ok || h.ReqID != 41 {
			return false
		}
		if len(h.Hits) != 3 || h.Truncated {
			t.Errorf("hits = %d truncated %v, want 3 and false", len(h.Hits), h.Truncated)
		}
		if len(h.Hits) > 0 && !strings.Contains(strings.ToLower(h.Hits[0].Snippet), "nginx") {
			t.Errorf("snippet = %q", h.Hits[0].Snippet)
		}
		return true
	})

	// The cap is reported, not silent.
	writeControl(t, c, wire.AgentSearch{Query: "nginx", Limit: 1, ReqID: 42})
	readUntil(t, c, func(msg any, _ []byte) bool {
		h, ok := msg.(wire.AgentHits)
		if !ok || h.ReqID != 42 {
			return false
		}
		if len(h.Hits) != 1 || !h.Truncated {
			t.Errorf("capped hits = %d truncated %v, want 1 and true", len(h.Hits), h.Truncated)
		}
		return true
	})
}

// TestAgentWorkIsCappedPerConnection pins the busy refusal the way
// TestAThirdReadIsRefusedWhileTwoAreHeld pins the file-read cap: with no
// timing in it. The counter is planted at the cap — exactly the state
// maxAgentWork requests in flight leave behind — and the next verb is asked
// for directly, because a test that raced real goroutines against the read
// loop would fail only on a machine loaded enough to hide why.
func TestAgentWorkIsCappedPerConnection(t *testing.T) {
	_, _, srv := newTestServerUI(t, http.NotFoundHandler())
	idx := agentstore.New(t.TempDir(), agentFixtureHome(t))
	// Settle the index before the conn exists, so nothing in the test body
	// pokes a background sweep that could still be writing its cache while
	// the test's temp directories are being torn down.
	deadline := time.Now().Add(5 * time.Second)
	for {
		sums, building := idx.Snapshot(nil, "")
		if !building && len(sums) > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the index never settled")
		}
		time.Sleep(10 * time.Millisecond)
	}
	srv.SetAgentIndex(idx)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := newConn(ctx, cancel, newPipeConn(), srv, "test", "", nil)
	c.mu.Lock()
	c.agentWork = maxAgentWork
	c.mu.Unlock()

	expectBusy := func(reqID uint64, send func()) {
		t.Helper()
		send()
		select {
		case f := <-c.out:
			msg, err := wire.DecodeControl(f.b)
			if err != nil {
				t.Fatalf("DecodeControl: %v", err)
			}
			e, ok := msg.(wire.Error)
			if !ok {
				t.Fatalf("a request over the cap was answered with %#v, want an error", msg)
			}
			if e.Code != "busy" || e.ReqID != reqID {
				t.Fatalf("error = %+v, want busy for reqId %d", e, reqID)
			}
		default:
			t.Fatal("a request over the cap was not answered at all")
		}
	}
	expectBusy(71, func() { c.handleAgentRead(wire.AgentRead{Tool: "claude", ID: agentClaudeID, ReqID: 71}) })
	expectBusy(72, func() { c.handleAgentSearch(wire.AgentSearch{Query: "nginx", ReqID: 72}) })

	// Neither refusal took a slot on its way out: refusals that counted would
	// let a burst of them lock the connection out of agent work for good.
	c.mu.Lock()
	held := c.agentWork
	c.mu.Unlock()
	if held != maxAgentWork {
		t.Fatalf("agentWork = %d after two refusals, want the %d that were already there", held, maxAgentWork)
	}

	// A freed slot makes the same request answerable, and the answer hands
	// the slot back: the decrement pairs with the goroutine, not the refusal.
	c.mu.Lock()
	c.agentWork--
	c.mu.Unlock()
	c.handleAgentSearch(wire.AgentSearch{Query: "nginx", ReqID: 73})
	select {
	case f := <-c.out:
		msg, err := wire.DecodeControl(f.b)
		if err != nil {
			t.Fatalf("DecodeControl: %v", err)
		}
		h, ok := msg.(wire.AgentHits)
		if !ok || h.ReqID != 73 {
			t.Fatalf("a request under the cap was answered with %#v, want agentHits for reqId 73", msg)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a request under the cap was never answered")
	}
	c.pumps.Wait()
	c.mu.Lock()
	held = c.agentWork
	c.mu.Unlock()
	if held != maxAgentWork-1 {
		t.Fatalf("agentWork = %d after the answer, want %d", held, maxAgentWork-1)
	}
}

func TestAgentVerbsRefuseWhatTheyShould(t *testing.T) {
	ts := newAgentTestServer(t)
	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	settleAgents(t, c)

	cases := []struct {
		name string
		send func(reqID uint64)
		code string
	}{
		{"unknownTool", func(r uint64) {
			writeControl(t, c, wire.AgentRead{Tool: "cursor", ID: "x", ReqID: r})
		}, "bad_message"},
		{"badDir", func(r uint64) {
			writeControl(t, c, wire.AgentRead{Tool: "claude", ID: agentClaudeID, Dir: "sideways", ReqID: r})
		}, "bad_message"},
		{"unknownID", func(r uint64) {
			writeControl(t, c, wire.AgentRead{Tool: "claude", ID: "never-existed", ReqID: r})
		}, "not_found"},
		{"emptyQuery", func(r uint64) {
			writeControl(t, c, wire.AgentSearch{Query: "  ", ReqID: r})
		}, "bad_message"},
	}
	for i, tc := range cases {
		reqID := uint64(50 + i)
		tc.send(reqID)
		readUntil(t, c, func(msg any, _ []byte) bool {
			e, ok := msg.(wire.Error)
			if !ok || e.ReqID != reqID {
				return false
			}
			if e.Code != tc.code {
				t.Errorf("%s: code = %q, want %q", tc.name, e.Code, tc.code)
			}
			return true
		})
	}
}
