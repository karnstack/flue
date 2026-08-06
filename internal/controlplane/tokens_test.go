package controlplane

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

// mintingControlPlane answers DaemonToken with a fresh token every time and
// counts how often it was asked. Which is the whole subject of this file: a
// daemon that minted a token per dial would be minting one per reconnect
// storm, and a daemon that never re-minted would present an expired one.
type mintingControlPlane struct {
	*fakeControlPlane
	mints   int
	ttl     int
	refuse  int // the status to answer with, if non-zero
	mintsMu sync.Mutex
}

func newMintingControlPlane(t *testing.T, ttl int) *mintingControlPlane {
	t.Helper()
	m := &mintingControlPlane{fakeControlPlane: newFakeControlPlane(t), ttl: ttl}
	m.ts.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		m.mintsMu.Lock()
		m.mints++
		n := m.mints
		refuse := m.refuse
		m.mintsMu.Unlock()
		if refuse != 0 {
			writeJSON(w, refuse, `{"error":"enroll: this machine is not enrolled"}`)
			return
		}
		writeJSON(w, http.StatusOK, fmt.Sprintf(
			`{"token":"channel-token-%d","relayUrl":"wss://relay.flue.sh","expiresIn":%d}`, n, m.ttl))
	})
	return m
}

func (m *mintingControlPlane) count() int {
	m.mintsMu.Lock()
	defer m.mintsMu.Unlock()
	return m.mints
}

func (m *mintingControlPlane) refuseWith(status int) {
	m.mintsMu.Lock()
	defer m.mintsMu.Unlock()
	m.refuse = status
}

// newTestTokens builds a token source whose clock the test drives.
func newTestTokens(m *mintingControlPlane, now *time.Time) *DaemonTokens {
	d := NewDaemonTokens(m.client(), "abc123abc123", testEnrollmentToken)
	d.now = func() time.Time { return *now }
	return d
}

// TestDaemonTokensReusesALiveToken: the relay verifies a token at the upgrade
// and never again, so a daemon that is already holding a good one has nothing
// to gain by asking for another — and plenty to lose. Every mint is a
// round-trip to the control plane on the path that gets the daemon back online
// after a network flap, and it is counted against the endpoint's per-IP cap.
func TestDaemonTokensReusesALiveToken(t *testing.T) {
	t.Parallel()
	m := newMintingControlPlane(t, 300)
	now := time.Now()
	d := newTestTokens(m, &now)

	start := now
	first, err := d.Token(context.Background())
	if err != nil {
		t.Fatalf("Token: %v", err)
	}
	for i := 0; i < 5; i++ {
		now = now.Add(30 * time.Second)
		again, err := d.Token(context.Background())
		if err != nil {
			t.Fatalf("Token: %v", err)
		}
		if again != first {
			t.Fatalf("Token minted a second token %s into a 300s TTL", now.Sub(start))
		}
	}
	if got := m.count(); got != 1 {
		t.Errorf("the control plane was asked %d times for one live token, want 1", got)
	}
}

// TestDaemonTokensRefreshesBeforeExpiry: the token is minted with a 300-second
// TTL and the daemon has to hand a *live* one to the dial. Waiting for it to
// actually expire would mean the first dial after every quiet spell is a 401
// followed by a backoff — so the margin is what makes a refresh invisible.
func TestDaemonTokensRefreshesBeforeExpiry(t *testing.T) {
	t.Parallel()
	m := newMintingControlPlane(t, 300)
	now := time.Now()
	d := newTestTokens(m, &now)

	first, err := d.Token(context.Background())
	if err != nil {
		t.Fatalf("Token: %v", err)
	}

	// Inside the margin, and the token is still good on the wire — but a dial
	// started now could still be handshaking when it dies, so it is replaced.
	now = now.Add(300*time.Second - RefreshMargin/2)
	second, err := d.Token(context.Background())
	if err != nil {
		t.Fatalf("Token: %v", err)
	}
	if second == first {
		t.Fatalf("Token reused a credential with under %s left", RefreshMargin)
	}
	if got := m.count(); got != 2 {
		t.Errorf("the control plane was asked %d times, want 2", got)
	}
}

// TestDaemonTokensDoesNotCacheAFailure: the control plane being down is the
// state a daemon spends its reconnect loop in, and a source that remembered a
// failure would need a restart to come back.
func TestDaemonTokensDoesNotCacheAFailure(t *testing.T) {
	t.Parallel()
	m := newMintingControlPlane(t, 300)
	now := time.Now()
	d := newTestTokens(m, &now)

	m.refuseWith(http.StatusInternalServerError)
	if _, err := d.Token(context.Background()); err == nil {
		t.Fatal("Token returned a token from a 500")
	}
	m.refuseWith(0)
	if _, err := d.Token(context.Background()); err != nil {
		t.Fatalf("Token did not recover once the control plane did: %v", err)
	}
}

// TestDaemonTokensNeverLeaksACredential: this type holds the enrollment token
// for the life of the process and hands out channel tokens. Neither may reach
// an error string, which is the one place either could end up in a log — the
// transport logs whatever the dial returned.
func TestDaemonTokensNeverLeaksACredential(t *testing.T) {
	t.Parallel()
	m := newMintingControlPlane(t, 300)
	m.refuseWith(http.StatusUnauthorized)
	now := time.Now()
	d := newTestTokens(m, &now)

	_, err := d.Token(context.Background())
	if err == nil {
		t.Fatal("Token returned a token from a 401")
	}
	if strings.Contains(err.Error(), testEnrollmentToken) {
		t.Fatalf("the error quotes the enrollment token: %v", err)
	}
	if s := fmt.Sprintf("%v/%+v", d, d); strings.Contains(s, testEnrollmentToken) {
		t.Fatalf("formatting a DaemonTokens printed the enrollment token: %s", s)
	}
}

// TestDaemonTokensReportsTheRelayItWasToldAbout: the relay URL travels with the
// token, so a control plane moved to a new relay moves its daemons with it
// rather than needing every relay.json re-written.
func TestDaemonTokensReportsTheRelayItWasToldAbout(t *testing.T) {
	t.Parallel()
	m := newMintingControlPlane(t, 300)
	now := time.Now()
	d := newTestTokens(m, &now)

	if _, err := d.Token(context.Background()); err != nil {
		t.Fatalf("Token: %v", err)
	}
	if got := d.RelayURL(); got != "wss://relay.flue.sh" {
		t.Errorf("RelayURL = %q, want wss://relay.flue.sh", got)
	}
}

// TestDaemonTokensIsSafeForConcurrentUse: the transport calls Token from its
// dial path, and nothing stops a caller from having more than one. Run under
// -race, this is the assertion.
func TestDaemonTokensIsSafeForConcurrentUse(t *testing.T) {
	t.Parallel()
	m := newMintingControlPlane(t, 300)
	now := time.Now()
	d := newTestTokens(m, &now)

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := d.Token(context.Background()); err != nil {
				t.Errorf("Token: %v", err)
			}
		}()
	}
	wg.Wait()
}
