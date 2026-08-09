package config

import (
	"encoding/json"
	"flag"
	"os"
	"regexp"
	"strings"
	"testing"
)

var update = flag.Bool("update", false, "regenerate testdata/relay/machine-ids.json")

// machineIDFixturePath is the cross-language contract for the machine-id MAC
// tag: this package generates it, the Worker's suite walks it
// (relay/test/machineid.test.ts), and the two implementations of
// HMAC-SHA256(secret, "flue-machine-id/"+slug) are thereby pinned to each
// other — the same role testdata/relay/frames.json plays for the framing.
const machineIDFixturePath = "../../testdata/relay/machine-ids.json"

type machineIDFixtureFile struct {
	Cases []machineIDFixtureCase `json:"cases"`
}

// machineIDFixtureCase is one (secret, slug) pair with the tag and the full
// id they must produce. The secret rides in cleartext because none of these
// are credentials: they exist to pin arithmetic.
type machineIDFixtureCase struct {
	Name   string `json:"name"`
	Secret string `json:"secret"`
	Slug   string `json:"slug"`
	Tag    string `json:"tag"`
	ID     string `json:"id"`
}

// machineIDFixtureCases are the (secret, slug) pairs the fixture pins; tags
// and ids are derived at regeneration time. The slugs cover the mint's edges:
// the hostname fallback, a single character of hostname, the 24-character
// truncation ceiling, consecutive dashes (a hostname like "a .b" sanitizes to
// them), and a slug that is itself hex-shaped — the case a parser that hunts
// for "the hex part" instead of "the last 9 characters" gets wrong. Two
// entries share a slug under different secrets, which is what pins that the
// secret is actually in the MAC. "test-secret" is deliberately the secret the
// relay vitest pool binds (relay/vitest.config.ts), so the Worker suite
// exercises the same values its own router runs under.
func machineIDFixtureCases() []machineIDFixtureCase {
	pairs := []struct{ name, secret, slug string }{
		{"ordinary", "test-secret", "karns-macbook-pro-a1b2"},
		{"hostname-fallback", "test-secret", "machine-ff00"},
		{"single-char-host", "test-secret", "a-0000"},
		{"truncated-24", "test-secret", strings.Repeat("a", 24) + "-ffff"},
		{"digit-led", "test-secret", "0g-b2c3"},
		{"inner-double-dash", "test-secret", "a--b-1a2b"},
		{"hex-shaped-slug", "test-secret", "deadbeef-cafe"},
		{"same-slug-other-secret", "wqLmxN2NKlWNy2qk_tt1kaB4-JJqMRC0lYAllcnrRlk", "karns-macbook-pro-a1b2"},
	}
	cases := make([]machineIDFixtureCase, 0, len(pairs))
	for _, p := range pairs {
		tag := MachineIDTag(p.secret, p.slug)
		cases = append(cases, machineIDFixtureCase{
			Name:   p.name,
			Secret: p.secret,
			Slug:   p.slug,
			Tag:    tag,
			ID:     p.slug + "-" + tag,
		})
	}
	return cases
}

// TestMachineIDFixture re-derives every committed case on every run — which is
// what catches a drifted prefix or truncation — and, with -update, rewrites
// the file. The committed file is the artifact; the Worker asserts against it
// without regenerating.
func TestMachineIDFixture(t *testing.T) {
	derived := machineIDFixtureCases()

	if *update {
		b, err := json.MarshalIndent(machineIDFixtureFile{Cases: derived}, "", "  ")
		if err != nil {
			t.Fatalf("marshalling the fixture: %v", err)
		}
		b = append(b, '\n')
		if err := os.WriteFile(machineIDFixturePath, b, 0o644); err != nil {
			t.Fatalf("writing %s: %v", machineIDFixturePath, err)
		}
	}

	raw, err := os.ReadFile(machineIDFixturePath)
	if err != nil {
		t.Fatalf("reading %s (regenerate with -update): %v", machineIDFixturePath, err)
	}
	var committed machineIDFixtureFile
	if err := json.Unmarshal(raw, &committed); err != nil {
		t.Fatalf("decoding %s: %v", machineIDFixturePath, err)
	}
	if len(committed.Cases) != len(derived) {
		t.Fatalf("%s carries %d cases, this package derives %d; regenerate with -update", machineIDFixturePath, len(committed.Cases), len(derived))
	}

	// Every id in the fixture must be inside the grammar every consumer
	// enforces (relay/src/index.ts MACHINE_ID, internal/transport/relay
	// machineIDRe) — a fixture that pinned an unroutable id would pin a bug.
	idRe := regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,53}-[0-9a-f]{8}$`)

	for i, want := range committed.Cases {
		got := derived[i]
		if got != want {
			t.Errorf("case %q: this package derives %+v, the committed fixture says %+v; regenerate with -update if the change is intended", want.Name, got, want)
		}
		if !idRe.MatchString(want.ID) {
			t.Errorf("case %q: id %q is outside the machine-id grammar", want.Name, want.ID)
		}
	}
}
