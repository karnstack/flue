package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// relayFileName is where the relay configuration lives, beside the token in the
// config directory.
const relayFileName = "relay.json"

// Relay is how this daemon reaches a deployed relay: where to dial, what
// authenticates the dial, and the origin the relay serves browsers on.
//
// It is written by whatever set the relay up and read by `flue serve` at
// startup. This package deliberately does not decide whether a file is
// *complete* — see transport/relay.New, which is where that lives — because a
// file that exists says the user meant to have a relay, and telling them which
// field is missing is a better answer than pretending they never configured one.
//
// # Two shapes, one file
//
// URL and Origin always apply. What differs is the credential, and it is what
// tells the two kinds of relay apart:
//
//   - **Self-hosted** (`flue relay setup`): `Secret` is the DAEMON_SECRET the
//     deploy set on the user's own Worker. One long-lived string, shared by the
//     daemon and the relay, presented on every dial.
//
//   - **Hosted on flue.sh** (`flue link`): there is no shared secret on this
//     machine. `EnrollmentToken` is what the device-authorization handshake
//     handed back — the machine's permanent, revocable credential *for the
//     control plane* — and the daemon spends it, at `ControlPlane`, on
//     short-lived channel tokens that the relay actually checks. `DeviceID` is
//     this machine's name on the account, derived from its Noise static key.
//     The key the relay verifies with exists on exactly two Workers, and this
//     is not one of them.
//
// `Hosted` is the one place that distinction is decided; nothing else may
// re-derive it from a different field.
type Relay struct {
	URL    string `json:"url"`
	Origin string `json:"origin"`

	// Secret is the self-hosted relay's shared DAEMON_SECRET. Omitted from a
	// hosted relay.json, which has none.
	Secret string `json:"secret,omitempty"`

	// ControlPlane is the flue.sh origin this machine is linked to —
	// https://app.flue.sh, or wherever `flue link --app` pointed it. Where
	// channel tokens are minted.
	ControlPlane string `json:"control_plane,omitempty"`
	// DeviceID is this machine's id on the account: hex(sha256(noise static
	// public key))[:12], the same twelve characters the control plane derived
	// when it enrolled it.
	DeviceID string `json:"device_id,omitempty"`
	// EnrollmentToken is the machine's credential at the control plane. It does
	// not expire and it is not the thing the relay checks: it is presented to
	// the control plane, which answers with a channel token that lives five
	// minutes. Never logged, never in argv, and the reason this file is 0600.
	EnrollmentToken string `json:"enrollment_token,omitempty"`
}

// Hosted reports whether this configuration names flue.sh's relay rather than
// one the user deployed themselves.
//
// The enrollment token is the discriminator because it is the field that
// decides what a dial presents: with one, the daemon mints a channel token and
// bears that; without one, it bears `Secret`. A relay.json written before
// flue.sh existed has no enrollment token and keeps working unchanged, which is
// the other property this choice buys.
func (r Relay) Hosted() bool { return r.EnrollmentToken != "" }

// LoadRelay reads relay.json. ok is false when there is no relay configured at
// all, which is the ordinary state and not an error.
//
// An unreadable or unparseable file *is* an error, and the distinction matters:
// "there is no relay" and "there is a relay and I cannot read it" lead to the
// same daemon — one serving loopback only — but only the second is something
// the operator has to be told about, and reporting it as absence would hide a
// typo in a file they just edited.
//
// The file's mode is not policed the way the token's is. A loose mode on the
// token is evidence the secret leaked *and* a reason to mint a new one, which
// costs one browser session; the relay secret's other copy lives in a deployed
// Worker, so this process cannot regenerate it and refusing to read it would
// only take remote access away without making anything safer. SaveRelay writes
// 0600, and rotating a secret that has been exposed is the operator's move.
func LoadRelay() (Relay, bool, error) {
	dir, err := Dir()
	if err != nil {
		return Relay{}, false, err
	}
	b, err := os.ReadFile(filepath.Join(dir, relayFileName))
	if errors.Is(err, fs.ErrNotExist) {
		return Relay{}, false, nil
	}
	if err != nil {
		return Relay{}, false, err
	}
	var r Relay
	if err := json.Unmarshal(b, &r); err != nil {
		// "Could not be parsed" rather than "is not valid JSON", because both
		// faults land here: a syntax error, and a well-formed file whose secret
		// is a number. The wrapped error names the offset or the field.
		//
		// What it must never carry is any of the file's contents. This is the
		// one config file that holds a credential and this error reaches both
		// the daemon's log and `flue status`. encoding/json does not quote the
		// value it choked on, and nothing added here may start to.
		return Relay{}, false, fmt.Errorf("config: %s could not be parsed: %w", relayFileName, err)
	}
	return r, true, nil
}

// SaveRelay writes relay.json at 0600, replacing whatever was there.
//
// It goes through the same write-temp-then-rename path as the token, and for
// the same two reasons: the new secret is never visible at a mode the old file
// happened to carry, and a crash mid-write cannot leave a truncated file behind
// where a complete one was. See writeSecretAtomically.
func SaveRelay(r Relay) error {
	dir, err := Dir()
	if err != nil {
		return err
	}
	// Indented and newline-terminated because this is a file people edit by
	// hand — it is how a relay gets configured — and a single long line is a
	// worse thing to edit than three short ones.
	b, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	b = append(b, '\n')
	return writeSecretAtomically(dir, filepath.Join(dir, relayFileName), b)
}
