package config

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// relayFileName is where the relay configuration lives, beside the token in the
// config directory.
const relayFileName = "relay.json"

// Relay is how this daemon reaches a deployed relay: where to dial, what
// authenticates the dial, and the origin the relay serves browsers on.
//
// It is written by `flue relay setup` and read by `flue serve` at startup.
// This package deliberately does not decide whether a file is *complete* —
// see transport/relay.New, which is where that lives — because a file that
// exists says the user meant to have a relay, and telling them which field is
// missing is a better answer than pretending they never configured one.
type Relay struct {
	// URL is the bare wss:// address of the relay — host only, no path. The
	// transport appends /daemon/<machine id> itself, so the file never holds a
	// path that could disagree with the id beside it.
	URL    string `json:"url"`
	Origin string `json:"origin"`

	// Secret is the relay's shared DAEMON_SECRET: the deploy set it on the
	// user's own Worker, and the daemon presents it on every dial. Never
	// logged, never in argv, and the reason this file is 0600.
	Secret string `json:"secret,omitempty"`

	// MachineID is the slot this machine holds on the relay: the <id> in the
	// /daemon/<id> leg the daemon dials and the /client/<id> URLs browsers
	// open. Minted by `flue relay setup` and `flue relay join` (MintMachineID),
	// never typed by hand — which is why it is a slug and the name below is
	// not.
	MachineID string `json:"machine_id"`
	// MachineName is the human label for this machine — free text, shown in
	// machine lists; it rides the pairing link's query (`n=`, so the pairing
	// browser can label the machine), never any path the relay routes on.
	MachineName string `json:"machine_name"`
}

// Machine-id shape. The relay refuses ids outside its grammar with a 404
// (relay/src/index.ts, one lowercase slug of at most 63 characters), so
// everything here exists to make a mint from any hostname land inside it.
const (
	// machineIDHostChars is how much of the sanitized hostname an id keeps.
	// Enough to recognise the machine in a list; short enough that the id
	// stays readable and nowhere near the relay's 63-character ceiling.
	machineIDHostChars = 24
	// machineIDRandBytes is the entropy after the hostname, hex-encoded. Two
	// bytes is not a credential — the id is public, it appears in URLs — it is
	// what keeps two machines that share a hostname from silently replacing
	// each other on the relay.
	machineIDRandBytes = 2
)

// MintMachineID makes the id a machine joins the relay under:
// `<hostname sanitized, truncated to 24>-<4 lowercase hex>`.
//
// The hostname part is for the human reading a machine list; the hex is for
// the relay, where the id is the routing key and a collision means the second
// machine evicts the first from its hub. r is crypto/rand.Reader everywhere
// but tests, which inject fixed bytes to pin the format.
func MintMachineID(hostname string, r io.Reader) string {
	host := sanitizeHostname(hostname)
	if host == "" {
		// A hostname of dots, dashes or characters no slug can keep. The id
		// still has to start [a-z0-9] and say something.
		host = "machine"
	}
	var raw [machineIDRandBytes]byte
	if _, err := io.ReadFull(r, raw[:]); err != nil {
		// crypto/rand.Read cannot fail (it panics in the runtime if the
		// kernel's randomness is unavailable), so the only reader that can
		// land here is a test's, and a short id minted from a broken reader
		// should fail loudly rather than register on a relay.
		panic(fmt.Sprintf("config: reading randomness for a machine id: %v", err))
	}
	return host + "-" + hex.EncodeToString(raw[:])
}

// sanitizeHostname folds a hostname into the id grammar: lowercased, spaces
// and dots to dashes — they are hostname punctuation, and keeping a boundary
// reads better than gluing the words — and everything else outside [a-z0-9-]
// dropped. Trimmed and truncated so the result can head a valid id.
func sanitizeHostname(hostname string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(hostname) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-':
			b.WriteRune(r)
		case r == ' ', r == '.':
			b.WriteByte('-')
		}
	}
	// Leading dashes would break the ^[a-z0-9] anchor; trailing ones — from
	// ".local", or from the truncation landing on a boundary — just read badly
	// next to the dash the hex suffix adds.
	s := strings.TrimLeft(b.String(), "-")
	if len(s) > machineIDHostChars {
		s = s[:machineIDHostChars] // ASCII by construction, so bytes are runes
	}
	return strings.TrimRight(s, "-")
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
