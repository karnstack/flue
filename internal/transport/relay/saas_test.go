package relay

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/flynn/noise"
)

// stubTokens is a TokenSource a test drives: it hands out `tokens` in order and
// then repeats the last one, which is how "a fresh credential per dial" is told
// apart from "one credential captured at construction".
type stubTokens struct {
	mu     sync.Mutex
	tokens []string
	err    error
	calls  int
}

func (s *stubTokens) Token(context.Context) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	if s.err != nil {
		return "", s.err
	}
	if len(s.tokens) == 0 {
		return "", errors.New("stubTokens: nothing to hand out")
	}
	tok := s.tokens[0]
	if len(s.tokens) > 1 {
		s.tokens = s.tokens[1:]
	}
	return tok, nil
}

func (s *stubTokens) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls
}

// newSaaSTransport builds an adapter that authenticates the way a machine
// linked to flue.sh does: with a channel token it minted, and no shared secret
// anywhere.
func newSaaSTransport(t *testing.T, r *fakeRelay, tokens TokenSource, log *slog.Logger) *Transport {
	t.Helper()
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	tr, err := New(Config{
		URL:    r.URL(),
		Origin: "https://relay.flue.sh",
		Tokens: tokens,
	}, &stubServer{}, noise.DHKey{}, nil, log)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return tr
}

// TestTransportPresentsAMintedChannelToken is the SaaS dial, end to end: the
// bearer on the upgrade is what the control plane minted, and no shared secret
// exists on this machine to present instead. That is the property the whole
// arrangement is for — RELAY_SIGNING_SECRET lives on two Workers, and a daemon
// that held it could sign a token naming any account.
func TestTransportPresentsAMintedChannelToken(t *testing.T) {
	t.Parallel()
	const token = "channel-token-for-this-machine"
	r := newFakeRelay(t, "")
	r.admits = func(auth string) bool { return auth == "Bearer "+token }
	tokens := &stubTokens{tokens: []string{token}}
	runTransport(t, newSaaSTransport(t, r, tokens, nil))

	r.accept(t)
	if got, want := r.lastAuth(t), "Bearer "+token; got != want {
		t.Errorf("Authorization header = %q, want %q", got, want)
	}
}

// TestTransportMintsForEveryDial: a channel token lives 300 seconds and a
// daemon's socket lives for days, so the credential is read at the dial rather
// than captured when the transport was built. A transport that held one forever
// would come back from its first long outage with a token that expired while it
// was away — and then back off, and try the same dead token again.
//
// The relay here admits only the *second* token, so the first dial is refused:
// the two Authorization headers it recorded are the proof that the source was
// consulted twice and that what it said the second time is what went on the
// wire.
func TestTransportMintsForEveryDial(t *testing.T) {
	t.Parallel()
	r := newFakeRelay(t, "")
	r.admits = func(auth string) bool { return auth == "Bearer fresh" }
	tokens := &stubTokens{tokens: []string{"stale", "fresh"}}
	runTransport(t, newSaaSTransport(t, r, tokens, nil))

	r.accept(t)
	r.mu.Lock()
	auths := append([]string(nil), r.auths...)
	r.mu.Unlock()
	if len(auths) < 2 {
		t.Fatalf("the relay saw %d upgrades, want at least 2", len(auths))
	}
	if auths[0] != "Bearer stale" || auths[1] != "Bearer fresh" {
		t.Errorf("upgrades presented %q then %q, want the token source's first then second answer",
			auths[0], auths[1])
	}
}

// TestTransportRetriesWhenTheMintFails: the control plane being unreachable is
// an ordinary state — it is a different host from the relay, on a machine whose
// network just came back — and it must not be a reason to stop dialling. It
// must also not be a reason to dial *without* a credential: nothing reaches the
// relay at all while the mint is failing.
func TestTransportRetriesWhenTheMintFails(t *testing.T) {
	t.Parallel()
	r := newFakeRelay(t, "")
	r.admits = func(string) bool { return true }
	tokens := &stubTokens{err: errors.New("the control plane answered 500")}
	runTransport(t, newSaaSTransport(t, r, tokens, nil))

	deadline := time.Now().Add(waitFor)
	for tokens.count() < 2 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if got := tokens.count(); got < 2 {
		t.Errorf("the transport asked for a token %d times, want it to keep trying", got)
	}
	if got := r.attempts(); got != 0 {
		t.Errorf("the relay saw %d upgrades while every mint was failing, want 0", got)
	}
}

// TestTransportNeverLogsTheChannelToken is TestTransportNeverLogsTheSecret's
// twin for the hosted path. The dial is logged on every failure and every
// reconnect, and it is the one line in this package that has a live credential
// in scope.
func TestTransportNeverLogsTheChannelToken(t *testing.T) {
	t.Parallel()
	const token = "channel-token-must-never-be-logged"
	var buf syncBuffer
	log := slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))

	// Refused, so the failing-dial line is written with the token in scope.
	r := newFakeRelay(t, "")
	r.admits = func(string) bool { return false }
	tokens := &stubTokens{tokens: []string{token}}
	runTransport(t, newSaaSTransport(t, r, tokens, log))

	r.waitAttempts(t, 2)
	if strings.Contains(buf.String(), token) {
		t.Fatalf("the channel token reached the log:\n%s", buf.String())
	}
}

// TestNewRequiresExactlyOneCredential.
//
// Neither is the ordinary incomplete config. *Both* is the interesting one: it
// is what a hand-edited relay.json looks like when somebody linked a machine to
// flue.sh that had already been pointed at a relay of their own, and there is
// no honest way to guess which of the two they meant — the shared secret would
// be refused by a SaaS relay and the channel token by a self-hosted one, so
// picking either could silently take a working daemon off the internet. Refuse,
// and say so.
func TestNewRequiresExactlyOneCredential(t *testing.T) {
	t.Parallel()

	t.Run("neither", func(t *testing.T) {
		t.Parallel()
		_, err := New(Config{URL: "wss://relay.flue.sh/daemon", Origin: "https://relay.flue.sh"},
			&stubServer{}, noise.DHKey{}, nil, nil)
		if !errors.Is(err, ErrIncompleteConfig) {
			t.Errorf("New with no credential = %v, want it to wrap ErrIncompleteConfig", err)
		}
	})

	t.Run("both", func(t *testing.T) {
		t.Parallel()
		tr, err := New(Config{
			URL:    "wss://relay.flue.sh/daemon",
			Origin: "https://relay.flue.sh",
			Secret: "a-self-hosted-daemon-secret",
			Tokens: &stubTokens{tokens: []string{"a-hosted-channel-token"}},
		}, &stubServer{}, noise.DHKey{}, nil, nil)
		if err == nil {
			t.Fatal("New accepted both a shared secret and a token source")
		}
		if tr != nil {
			t.Error("New returned a transport alongside an error")
		}
		if !errors.Is(err, ErrConflictingConfig) {
			t.Errorf("New = %v, want it to wrap ErrConflictingConfig", err)
		}
		if strings.Contains(err.Error(), "a-self-hosted-daemon-secret") {
			t.Errorf("the error quotes the secret: %v", err)
		}
	})

	t.Run("a token source alone is enough", func(t *testing.T) {
		t.Parallel()
		tr, err := New(Config{
			URL:    "wss://relay.flue.sh/daemon",
			Origin: "https://relay.flue.sh",
			Tokens: &stubTokens{tokens: []string{"t"}},
		}, &stubServer{}, noise.DHKey{}, nil, nil)
		if err != nil || tr == nil {
			t.Fatalf("New with a token source = (%v, %v), want a transport", tr, err)
		}
	})
}
