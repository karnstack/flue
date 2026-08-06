package controlplane

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
)

// The credentials these tests move around. Distinctive strings on purpose:
// several assertions are "this must appear nowhere", and they are only worth
// something if a match could not be a coincidence.
const (
	testDeviceCode      = "device-code-must-never-be-printed"
	testEnrollmentToken = "enrollment-token-must-never-be-printed"
	testChannelToken    = "channel-token-must-never-be-printed"
)

// call is one request the fake control plane answered, decoded the way the
// deployed one decodes it.
type call struct {
	path        string
	method      string
	contentType string
	origin      string
	form        url.Values
}

// fakeControlPlane is app.flue.sh's three daemon-facing server functions, in
// process. It is deliberately as strict as the real thing about the two things
// a Go client gets wrong by default — a body that is not form-encoded, and a
// POST with no Origin header — because those are the failures this package
// exists to not have.
type fakeControlPlane struct {
	ts *httptest.Server

	// mu guards everything below: the handler runs on its own goroutine, and a
	// test reads what it recorded.
	mu    sync.Mutex
	calls []call

	// answers is the JSON each path replies with, and status the code it
	// replies with. A test sets whichever it needs.
	answers  map[string]string
	statuses map[string]int
	// pollSequence is answered one entry per poll, so a test can watch the
	// daemon wait through `pending`.
	pollSequence []string
}

func newFakeControlPlane(t *testing.T) *fakeControlPlane {
	t.Helper()
	f := &fakeControlPlane{
		answers:  map[string]string{},
		statuses: map[string]int{},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/", f.serve)
	f.ts = httptest.NewServer(mux)
	t.Cleanup(f.ts.Close)
	return f
}

func (f *fakeControlPlane) origin() string { return f.ts.URL }

func (f *fakeControlPlane) serve(w http.ResponseWriter, r *http.Request) {
	ct := r.Header.Get("Content-Type")
	// What Start does: a form-encoded or multipart body becomes FormData and
	// reaches the validator; anything else goes through seroval's fromJSON and
	// throws above the handler. So a JSON body is not a validation error here
	// either — it never arrives.
	if !strings.HasPrefix(ct, "application/x-www-form-urlencoded") {
		w.Header().Set("x-tss-serialized", "true")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"t":10,"i":0}`))
		return
	}
	if err := r.ParseForm(); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	origin := r.Header.Get("Origin")
	f.mu.Lock()
	f.calls = append(f.calls, call{
		path:        r.URL.Path,
		method:      r.Method,
		contentType: ct,
		origin:      origin,
		form:        r.PostForm,
	})
	f.mu.Unlock()
	// start.ts's CSRF middleware refuses a server-fn POST that carries no
	// origin signal at all, and a Go client sends none unless it is told to.
	if origin == "" {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}

	f.mu.Lock()
	defer f.mu.Unlock()
	if r.URL.Path == PollDeviceAuthPath() && len(f.pollSequence) > 0 {
		body := f.pollSequence[0]
		f.pollSequence = f.pollSequence[1:]
		writeJSON(w, http.StatusOK, body)
		return
	}
	status := f.statuses[r.URL.Path]
	if status == 0 {
		status = http.StatusOK
	}
	body, ok := f.answers[r.URL.Path]
	if !ok {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	writeJSON(w, status, body)
}

func writeJSON(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(body))
}

func (f *fakeControlPlane) lastCall(t *testing.T) call {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.calls) == 0 {
		t.Fatal("nothing reached the control plane")
	}
	return f.calls[len(f.calls)-1]
}

func (f *fakeControlPlane) client() *Client {
	return &Client{Origin: f.origin()}
}

func TestStartDeviceAuthPostsFormEncodedWithAnOrigin(t *testing.T) {
	t.Parallel()
	f := newFakeControlPlane(t)
	f.answers[StartDeviceAuthPath()] = fmt.Sprintf(`{
		"userCode":"BCDF-GHJK",
		"deviceCode":%q,
		"verificationUrl":"https://app.flue.sh/enroll",
		"verificationUrlComplete":"https://app.flue.sh/enroll?code=BCDF-GHJK",
		"expiresIn":600,
		"interval":5
	}`, testDeviceCode)

	grant, err := f.client().StartDeviceAuth(context.Background(), "a go daemon", "AAAA")
	if err != nil {
		t.Fatalf("StartDeviceAuth: %v", err)
	}

	got := f.lastCall(t)
	// The three things the deployed endpoint requires and a naive http.Post
	// gets wrong: the path, the encoding, and saying which origin it is
	// talking to.
	if got.path != StartDeviceAuthPath() {
		t.Errorf("posted to %s, want %s", got.path, StartDeviceAuthPath())
	}
	if got.method != http.MethodPost {
		t.Errorf("method = %s, want POST", got.method)
	}
	if !strings.HasPrefix(got.contentType, "application/x-www-form-urlencoded") {
		t.Errorf("Content-Type = %q, want application/x-www-form-urlencoded", got.contentType)
	}
	if got.origin != f.origin() {
		t.Errorf("Origin = %q, want %q (the host it is talking to)", got.origin, f.origin())
	}
	if v := got.form.Get("label"); v != "a go daemon" {
		t.Errorf("label = %q, want %q", v, "a go daemon")
	}
	if v := got.form.Get("publicKey"); v != "AAAA" {
		t.Errorf("publicKey = %q, want %q", v, "AAAA")
	}

	if grant.UserCode != "BCDF-GHJK" {
		t.Errorf("UserCode = %q, want BCDF-GHJK", grant.UserCode)
	}
	if grant.DeviceCode != testDeviceCode {
		t.Errorf("DeviceCode was not carried through")
	}
	if grant.VerificationURL != "https://app.flue.sh/enroll" {
		t.Errorf("VerificationURL = %q", grant.VerificationURL)
	}
	if grant.ExpiresIn != 600 || grant.Interval != 5 {
		t.Errorf("ExpiresIn/Interval = %d/%d, want 600/5", grant.ExpiresIn, grant.Interval)
	}
}

// TestGrantAndPollNeverFormatTheirCredentials: a Grant holds the device code
// and a Poll holds the enrollment token, and both are values somebody will
// eventually put through %v while debugging. Redacting in String() is what
// stops a printf from being the leak.
func TestGrantAndPollNeverFormatTheirCredentials(t *testing.T) {
	t.Parallel()

	g := Grant{UserCode: "BCDF-GHJK", DeviceCode: testDeviceCode}
	if s := fmt.Sprintf("%v/%s/%+v", g, g, g); strings.Contains(s, testDeviceCode) {
		t.Errorf("formatting a Grant printed the device code: %s", s)
	}
	p := Poll{Status: StatusApproved, DeviceID: "abc123", DeviceToken: testEnrollmentToken}
	if s := fmt.Sprintf("%v/%s/%+v", p, p, p); strings.Contains(s, testEnrollmentToken) {
		t.Errorf("formatting a Poll printed the enrollment token: %s", s)
	}
	c := ChannelGrant{Token: testChannelToken, RelayURL: "wss://relay.flue.sh"}
	if s := fmt.Sprintf("%v/%s/%+v", c, c, c); strings.Contains(s, testChannelToken) {
		t.Errorf("formatting a ChannelGrant printed the channel token: %s", s)
	}
}

func TestPollDeviceAuthReadsEveryOutcome(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name string
		body string
		want Poll
	}{
		{"pending", `{"status":"pending"}`, Poll{Status: StatusPending}},
		{"expired", `{"status":"expired"}`, Poll{Status: StatusExpired}},
		{
			"conflict",
			`{"status":"conflict","deviceId":"abc123abc123"}`,
			Poll{Status: StatusConflict, DeviceID: "abc123abc123"},
		},
		{
			"approved",
			fmt.Sprintf(`{"status":"approved","deviceId":"abc123abc123","deviceToken":%q}`, testEnrollmentToken),
			Poll{Status: StatusApproved, DeviceID: "abc123abc123", DeviceToken: testEnrollmentToken},
		},
		{
			// The lost-response case: another poll won the race and took the
			// token with it. Not a crash, and not something to retry.
			"approved without a token",
			`{"status":"approved","deviceId":"abc123abc123"}`,
			Poll{Status: StatusApproved, DeviceID: "abc123abc123"},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			f := newFakeControlPlane(t)
			f.answers[PollDeviceAuthPath()] = tc.body

			got, err := f.client().PollDeviceAuth(context.Background(), testDeviceCode)
			if err != nil {
				t.Fatalf("PollDeviceAuth: %v", err)
			}
			if got != tc.want {
				t.Errorf("PollDeviceAuth = %+v, want %+v", got, tc.want)
			}
			if v := f.lastCall(t).form.Get("deviceCode"); v != testDeviceCode {
				t.Errorf("deviceCode = %q, want the code it was given", v)
			}
		})
	}
}

func TestDaemonTokenPostsTheEnrollmentTokenInTheBody(t *testing.T) {
	t.Parallel()
	f := newFakeControlPlane(t)
	f.answers[DaemonTokenPath()] = fmt.Sprintf(
		`{"token":%q,"relayUrl":"wss://relay.flue.sh","expiresIn":300}`, testChannelToken)

	grant, err := f.client().DaemonToken(context.Background(), "abc123abc123", testEnrollmentToken)
	if err != nil {
		t.Fatalf("DaemonToken: %v", err)
	}
	if grant.Token != testChannelToken || grant.RelayURL != "wss://relay.flue.sh" || grant.ExpiresIn != 300 {
		t.Fatalf("DaemonToken returned %v", grant)
	}

	got := f.lastCall(t)
	if got.path != DaemonTokenPath() {
		t.Errorf("posted to %s, want %s", got.path, DaemonTokenPath())
	}
	if v := got.form.Get("deviceId"); v != "abc123abc123" {
		t.Errorf("deviceId = %q", v)
	}
	if v := got.form.Get("enrollmentToken"); v != testEnrollmentToken {
		t.Errorf("the enrollment token did not reach the body")
	}
	// In the body, never in the URL: a query string is what ends up in the
	// Worker's request logs and in every proxy between here and there.
	if strings.Contains(got.path, testEnrollmentToken) {
		t.Error("the enrollment token was put in the URL")
	}
}

func TestRefusalsCarryTheirStatusAndSayWhetherToRetry(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name      string
		status    int
		body      string
		retryable bool
	}{
		{"over the cap", http.StatusTooManyRequests, `{"error":"enroll: too many enrolments from this address"}`, true},
		{"a bad key", http.StatusBadRequest, `{"error":"enroll: the device key must be 32 bytes, base64"}`, false},
		{"not enrolled", http.StatusUnauthorized, `{"error":"enroll: this machine is not enrolled"}`, false},
		{"a broken database", http.StatusInternalServerError, `{"error":"enroll: could not open a grant"}`, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			f := newFakeControlPlane(t)
			f.statuses[StartDeviceAuthPath()] = tc.status
			f.answers[StartDeviceAuthPath()] = tc.body

			_, err := f.client().StartDeviceAuth(context.Background(), "l", "k")
			if err == nil {
				t.Fatal("a refusal came back as success")
			}
			var refusal *Error
			if !errors.As(err, &refusal) {
				t.Fatalf("err = %v (%T), want a *controlplane.Error", err, err)
			}
			if refusal.Status != tc.status {
				t.Errorf("Status = %d, want %d", refusal.Status, tc.status)
			}
			// The message the control plane wrote reaches the operator: these
			// strings are written to be read by whoever runs the daemon.
			if !strings.Contains(err.Error(), "enroll:") {
				t.Errorf("the control plane's own message was dropped: %v", err)
			}
			if refusal.Retryable() != tc.retryable {
				t.Errorf("Retryable() = %v, want %v", refusal.Retryable(), tc.retryable)
			}
		})
	}
}

// TestARefusalNeverQuotesTheResponseBody: everything above assumes the control
// plane is honest. This one does not. The body of a response is bytes chosen by
// whatever answered, and a client that pasted them into an error would print
// whatever a compromised or impersonating host felt like putting there —
// including the very credential it was just handed.
func TestARefusalNeverQuotesTheResponseBody(t *testing.T) {
	t.Parallel()
	f := newFakeControlPlane(t)
	f.statuses[StartDeviceAuthPath()] = http.StatusBadGateway
	f.answers[StartDeviceAuthPath()] = "<html>" + testEnrollmentToken + "</html>"

	_, err := f.client().StartDeviceAuth(context.Background(), "l", "k")
	if err == nil {
		t.Fatal("a 502 of HTML came back as success")
	}
	if strings.Contains(err.Error(), testEnrollmentToken) {
		t.Fatalf("the error quotes the response body: %v", err)
	}
	// It still has to be useful: the status is what tells an operator whether
	// this is their configuration or somebody else's outage.
	if !strings.Contains(err.Error(), "502") {
		t.Errorf("the error does not name the status: %v", err)
	}
}

// TestARefusalIsClippedAndStripped: the `error` field is JSON, so unlike the
// body around it this daemon does print it — to stderr with no escaping
// (cmd/flue/main.go) and into the log on every failed relay dial
// (internal/transport/relay). It is still a string chosen by whatever answered,
// bounded only by the 64 KiB read cap, so what reaches those two places is a
// clipped, printable version of it. `printableCode` in cmd/flue/link.go is the
// same argument about the other server-chosen string in this flow.
func TestARefusalIsClippedAndStripped(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name string
		sent string
		// gone is what must not survive into the printed error.
		gone []string
		// kept is the readable part of the same message.
		kept string
	}{
		{
			name: "an escape sequence that repaints the operator's screen",
			// ESC[2J clears it; \r rewrites the line above; ESC]0; retitles
			// the window on most emulators.
			sent: "enroll: refused\x1b[2J\x1b]0;owned\x07\rflue: success",
			gone: []string{"\x1b", "\r", "\x07"},
			kept: "enroll: refused",
		},
		{
			name: "characters that make the sentence read backwards",
			sent: "enroll: refused‮gnihtemos",
			gone: []string{"‮"},
			kept: "enroll: refused",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			f := newFakeControlPlane(t)
			f.statuses[StartDeviceAuthPath()] = http.StatusForbidden
			f.answers[StartDeviceAuthPath()] = string(mustJSON(t, map[string]string{"error": tc.sent}))

			_, err := f.client().StartDeviceAuth(context.Background(), "l", "k")
			if err == nil {
				t.Fatal("a refusal came back as success")
			}
			for _, bad := range tc.gone {
				if strings.Contains(err.Error(), bad) {
					t.Errorf("the error carries %q through to a terminal: %q", bad, err.Error())
				}
			}
			// And it is still the sentence somebody has to read.
			if !strings.Contains(err.Error(), tc.kept) {
				t.Errorf("the readable part was lost: %q", err.Error())
			}
		})
	}

	t.Run("a message far longer than a message", func(t *testing.T) {
		t.Parallel()
		// The relay transport logs this on every failed dial and retries
		// forever, so an unclipped one is a log nobody reads and a disk
		// somebody pays for.
		f := newFakeControlPlane(t)
		f.statuses[StartDeviceAuthPath()] = http.StatusForbidden
		f.answers[StartDeviceAuthPath()] = string(mustJSON(t, map[string]string{
			"error": strings.Repeat("A", 40_000),
		}))

		_, err := f.client().StartDeviceAuth(context.Background(), "l", "k")
		if err == nil {
			t.Fatal("a refusal came back as success")
		}
		var refusal *Error
		if !errors.As(err, &refusal) {
			t.Fatalf("err = %v (%T), want a *controlplane.Error", err, err)
		}
		if len(refusal.Message) > maxServerMessage+len("…") {
			t.Errorf("Message is %d bytes, want at most %d", len(refusal.Message), maxServerMessage)
		}
	})
}

// mustJSON encodes a value the way the control plane would, so a test can put
// bytes that are awkward to write as a Go string literal inside a JSON string
// without hand-escaping them.
func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}
	return b
}

// TestTheClientDoesNotFollowRedirects: every one of these POSTs carries a
// credential in its body — a device code, or the enrollment token itself. Go's
// default client follows a 307/308 and re-sends the body; a control plane that
// answered with one (a hijacked DNS record, a misconfigured proxy) would have
// the daemon hand its enrollment token to wherever it pointed. A redirect is
// never a valid answer here, so refusing costs nothing.
func TestTheClientDoesNotFollowRedirects(t *testing.T) {
	t.Parallel()

	var elsewhere int
	sink := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		elsewhere++
		writeJSON(w, http.StatusOK, `{"token":"stolen","relayUrl":"wss://x","expiresIn":300}`)
	}))
	defer sink.Close()

	redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, sink.URL+r.URL.Path, http.StatusTemporaryRedirect)
	}))
	defer redirector.Close()

	c := &Client{Origin: redirector.URL}
	_, err := c.DaemonToken(context.Background(), "abc123abc123", testEnrollmentToken)
	if err == nil {
		t.Fatal("the client followed a redirect and treated the answer as a token")
	}
	if elsewhere != 0 {
		t.Fatalf("the enrollment token was re-sent to the redirect target %d times", elsewhere)
	}
}

func TestClientRefusesAnOriginItCannotUse(t *testing.T) {
	t.Parallel()
	for _, origin := range []string{"", "app.flue.sh", "https://", "not a url at all::"} {
		c := &Client{Origin: origin}
		if _, err := c.StartDeviceAuth(context.Background(), "l", "k"); err == nil {
			t.Errorf("Origin %q was accepted, want a refusal", origin)
		}
	}
}

// TestClientTrimsATrailingSlash: the Origin header the CSRF check compares
// against is `scheme://host` with no trailing slash, and the operator typing
// `--app https://app.flue.sh/` must not be the reason a POST is 403'd.
func TestClientTrimsATrailingSlash(t *testing.T) {
	t.Parallel()
	f := newFakeControlPlane(t)
	f.answers[PollDeviceAuthPath()] = `{"status":"pending"}`

	c := &Client{Origin: f.origin() + "/"}
	if _, err := c.PollDeviceAuth(context.Background(), testDeviceCode); err != nil {
		t.Fatalf("PollDeviceAuth: %v", err)
	}
	if got := f.lastCall(t).origin; got != f.origin() {
		t.Errorf("Origin = %q, want %q", got, f.origin())
	}
}
