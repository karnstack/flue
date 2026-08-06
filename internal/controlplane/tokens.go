package controlplane

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// RefreshMargin is how much of a channel token's life this source refuses to
// use.
//
// The relay verifies a token once, at the upgrade, and never again — so what
// has to be live is the token at the moment the handshake is checked, not the
// token when Token() returned. Between those two moments sits a TCP connect, a
// TLS handshake and an HTTP upgrade over whatever link the machine has, and the
// dial is allowed 30 seconds of it. A margin comfortably wider than that turns
// "the token expired mid-dial" from a rare 401-then-back-off into something
// that cannot happen; the cost is one extra mint per token's life.
const RefreshMargin = 90 * time.Second

// DaemonTokens hands out `role: 'daemon'` channel tokens for one enrolled
// machine, minting a fresh one from the control plane when the one it holds is
// close to expiring.
//
// It exists because the daemon deliberately cannot sign its own: only the
// control plane and the relay hold RELAY_SIGNING_SECRET, and a daemon that
// could sign could name any account it liked. What it holds instead is the
// enrollment token — permanent, revocable from the device directory, and the
// thing this type keeps for the life of the process and never says out loud.
//
// Caching is not an optimization here so much as a correctness choice about
// *when* the control plane is on the critical path. A source that minted per
// dial would put a round trip into every reconnect — which is to say, into
// exactly the moment the network is already unreliable — and would spend the
// endpoint's per-IP cap on a machine that is merely flapping.
type DaemonTokens struct {
	client     *Client
	deviceID   string
	enrollment string

	// now is the clock, a field so a test can move it rather than wait out a
	// five-minute TTL.
	now func() time.Time

	mu       sync.Mutex
	token    string
	expiry   time.Time
	relayURL string
}

// NewDaemonTokens builds a token source for one enrolled machine.
func NewDaemonTokens(client *Client, deviceID, enrollmentToken string) *DaemonTokens {
	return &DaemonTokens{
		client:     client,
		deviceID:   deviceID,
		enrollment: enrollmentToken,
		now:        time.Now,
	}
}

// String redacts everything. This value is reachable from the relay
// transport's Config, which is a struct somebody will eventually print.
func (d *DaemonTokens) String() string {
	return fmt.Sprintf("controlplane.DaemonTokens{deviceID:%s enrollment:<redacted> token:<redacted>}", d.deviceID)
}

// Token returns a channel token that will still be valid when a dial started
// now completes, minting a new one if the cached one is inside RefreshMargin of
// expiry.
//
// A failed mint is not cached: the control plane being unreachable is the state
// a daemon spends its reconnect loop in, and a source that remembered it would
// need a restart to come back. Nor is the old token thrown away on a failure —
// if it is still live, it is still the best thing to dial with.
func (d *DaemonTokens) Token(ctx context.Context) (string, error) {
	d.mu.Lock()
	defer d.mu.Unlock()

	if d.token != "" && d.now().Before(d.expiry.Add(-RefreshMargin)) {
		return d.token, nil
	}

	grant, err := d.client.DaemonToken(ctx, d.deviceID, d.enrollment)
	if err != nil {
		return "", fmt.Errorf("mint a relay token for this machine: %w", err)
	}
	if grant.Token == "" {
		return "", fmt.Errorf("the control plane minted an empty relay token for this machine")
	}

	d.token = grant.Token
	// A TTL the control plane did not send, or one that is nonsense, means the
	// cache cannot be trusted to expire: keep the token for this dial and mint
	// again on the next one rather than hold a credential of unknown life.
	if grant.ExpiresIn > 0 {
		d.expiry = d.now().Add(time.Duration(grant.ExpiresIn) * time.Second)
	} else {
		d.expiry = time.Time{}
	}
	d.relayURL = grant.RelayURL
	return d.token, nil
}

// RelayURL is the relay the control plane last named, or "" before the first
// successful mint.
//
// The address travels with the token rather than being read out of relay.json
// on every dial, so a control plane that moves its relay moves the daemons with
// it. `flue link` records the first one it is told about so the daemon has
// somewhere to dial before it has minted anything.
func (d *DaemonTokens) RelayURL() string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.relayURL
}
