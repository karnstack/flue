package daemon

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/karnstack/flue/internal/session"
	"github.com/karnstack/flue/internal/transport/local"
)

// postClose issues the request the flue CLI makes: POST, JSON body, session
// token in a header, no browser provenance headers at all.
func postClose(t *testing.T, ts *httptest.Server, body string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, ts.URL+SessionsClosePath, strings.NewReader(body))
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(local.HeaderName, tok)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST %s: %v", SessionsClosePath, err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

// closeAnswer decodes a successful close reply.
func closeAnswer(t *testing.T, resp *http.Response) (closed int, missing []string) {
	t.Helper()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("POST %s = %d (%s), want 200", SessionsClosePath, resp.StatusCode, body)
	}
	var out struct {
		Closed  int      `json:"closed"`
		Missing []string `json:"missing"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decoding the close answer: %v", err)
	}
	return out.Closed, out.Missing
}

func spawnTwo(t *testing.T, reg *session.Registry) (a, b session.Handle) {
	t.Helper()
	for _, s := range []*session.Handle{&a, &b} {
		h, err := reg.Spawn(session.SpawnOpts{Cmd: []string{"sleep", "5"}, Cols: 80, Rows: 24})
		if err != nil {
			t.Fatalf("Spawn: %v", err)
		}
		t.Cleanup(func() { _ = h.Close() })
		*s = h
	}
	return a, b
}

func TestSessionsCloseAllClosesEverything(t *testing.T) {
	ts, reg := newTestServer(t)
	spawnTwo(t, reg)

	closed, missing := closeAnswer(t, postClose(t, ts, `{"all":true}`))
	if closed != 2 {
		t.Errorf("closed = %d, want 2", closed)
	}
	if len(missing) != 0 {
		t.Errorf("missing = %v, want none", missing)
	}
	if left := reg.List(); len(left) != 0 {
		t.Errorf("the registry still holds %d sessions", len(left))
	}
}

func TestSessionsCloseByIDClosesTheNamedOneAndReportsTheRest(t *testing.T) {
	ts, reg := newTestServer(t)
	a, b := spawnTwo(t, reg)

	body := `{"ids":["` + a.ID() + `","feedfeed00000000"]}`
	closed, missing := closeAnswer(t, postClose(t, ts, body))
	if closed != 1 {
		t.Errorf("closed = %d, want 1", closed)
	}
	if len(missing) != 1 || missing[0] != "feedfeed00000000" {
		t.Errorf("missing = %v, want the unknown id alone", missing)
	}
	if _, ok := reg.Get(a.ID()); ok {
		t.Error("the named session is still in the registry")
	}
	if _, ok := reg.Get(b.ID()); !ok {
		t.Error("the unnamed session went with it")
	}
}

// TestSessionsCloseWithBothFieldsMeansAll pins the tie-break: a body that
// says all and names ids is an all-close, so nothing lands in missing.
func TestSessionsCloseWithBothFieldsMeansAll(t *testing.T) {
	ts, reg := newTestServer(t)
	spawnTwo(t, reg)

	closed, missing := closeAnswer(t, postClose(t, ts, `{"all":true,"ids":["feedfeed00000000"]}`))
	if closed != 2 {
		t.Errorf("closed = %d, want 2", closed)
	}
	if len(missing) != 0 {
		t.Errorf("missing = %v, want none: all outranks ids", missing)
	}
}

func TestSessionsCloseWithNeitherFieldIsRefused(t *testing.T) {
	ts, reg := newTestServer(t)
	spawnTwo(t, reg)

	for _, body := range []string{`{}`, `{"all":false,"ids":[]}`, `not json`} {
		if resp := postClose(t, ts, body); resp.StatusCode != http.StatusBadRequest {
			t.Errorf("POST with body %q = %d, want 400", body, resp.StatusCode)
		}
	}
	if left := reg.List(); len(left) != 2 {
		t.Errorf("a refused request closed sessions: %d left, want 2", len(left))
	}
}

func TestSessionsCloseRequiresAuth(t *testing.T) {
	ts, reg := newTestServer(t)
	spawnTwo(t, reg)

	resp, err := http.Post(ts.URL+SessionsClosePath, "application/json", strings.NewReader(`{"all":true}`))
	if err != nil {
		t.Fatalf("POST %s: %v", SessionsClosePath, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated POST %s = %d, want 401", SessionsClosePath, resp.StatusCode)
	}
	if left := reg.List(); len(left) != 2 {
		t.Errorf("an unauthenticated request closed sessions: %d left, want 2", len(left))
	}
}

// TestSessionsCloseRefusesGET: methodPolicy names this path postable, which
// widens it to GET-or-POST at the routing layer, so the handler itself must
// narrow it back — a GET is the one method a redirect can launder.
func TestSessionsCloseRefusesGET(t *testing.T) {
	ts, reg := newTestServer(t)
	spawnTwo(t, reg)

	resp := get(t, ts, SessionsClosePath, "same-origin")
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("GET %s = %d, want 405", SessionsClosePath, resp.StatusCode)
	}
	if left := reg.List(); len(left) != 2 {
		t.Errorf("a GET closed sessions: %d left, want 2", len(left))
	}
}
