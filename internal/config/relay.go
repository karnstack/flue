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

// Relay is how this daemon reaches a deployed relay: where to dial, the secret
// that authenticates the dial, and the origin the relay serves browsers on.
//
// It is written by whatever set the relay up and read by `flue serve` at
// startup. All three fields are needed for a working relay — see
// transport/relay.New, which is where "incomplete" is decided — and this
// package deliberately does not decide it: a file that exists says the user
// meant to have a relay, and telling them which field is missing is a better
// answer than pretending they never configured one.
type Relay struct {
	URL    string `json:"url"`
	Secret string `json:"secret"`
	Origin string `json:"origin"`
}

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
		// The error names the file and the offset, never the contents: this is
		// the one config file that holds a credential, and a parse error that
		// quoted the line it choked on would put it in a log.
		return Relay{}, false, fmt.Errorf("config: %s is not valid JSON: %w", relayFileName, err)
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
