package relaydeploy

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// One Worker, two configurations, and nothing but prose keeping them level.
//
// `pnpm dev` and the vitest pool read relay/wrangler.jsonc; a user's relay is
// deployed from the constants in this package, which never read that file. Both
// have to describe the same Worker, and neither fails on its own when they stop
// doing so — the failure surfaces as a developer and a user running different
// relays, or worse.
//
// The migration history is the sharpest edge. Cloudflare records the applied
// tag against the deployed script, and internal/cloudflare sends only the steps
// *behind* that tag. A `v3` added to wrangler.jsonc alone would leave every
// `flue relay update` believing v2 is the end of the history: the account
// reports v2, the client finds v2 last, sends nothing, and the new class is
// never created — silently, because the deploy succeeds. The equivalent guard
// for the `_headers` document lives at cmd/flue/relay_test.go
// (TestRelayAssetHeadersMatchTheWranglerCopy) and exists for the same reason.

// wranglerConfig is the part of relay/wrangler.jsonc this package has a twin
// for. Everything else in that file is `pnpm dev`'s business alone.
type wranglerConfig struct {
	Name              string `json:"name"`
	Main              string `json:"main"`
	CompatibilityDate string `json:"compatibility_date"`
	Assets            struct {
		Binding        string   `json:"binding"`
		RunWorkerFirst []string `json:"run_worker_first"`
	} `json:"assets"`
	DurableObjects struct {
		Bindings []struct {
			Name      string `json:"name"`
			ClassName string `json:"class_name"`
		} `json:"bindings"`
	} `json:"durable_objects"`
	Migrations []struct {
		Tag              string   `json:"tag"`
		NewSQLiteClasses []string `json:"new_sqlite_classes"`
	} `json:"migrations"`
	RateLimits []struct {
		Name        string `json:"name"`
		NamespaceID string `json:"namespace_id"`
		Simple      struct {
			Limit  int `json:"limit"`
			Period int `json:"period"`
		} `json:"simple"`
	} `json:"ratelimits"`
}

func readWrangler(t *testing.T) wranglerConfig {
	t.Helper()
	path := filepath.Join("..", "..", "relay", "wrangler.jsonc")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading %s: %v", path, err)
	}
	var cfg wranglerConfig
	if err := json.Unmarshal(stripJSONComments(raw), &cfg); err != nil {
		t.Fatalf("parsing %s: %v", path, err)
	}
	return cfg
}

// stripJSONComments turns JSONC into JSON by blanking `//` and `/* */`
// comments. Comments are replaced with spaces rather than removed so that byte
// offsets in a parse error still point at the right place in the original.
//
// String literals are tracked, because a comment marker inside one is not a
// comment — "https://example" is the case that matters here, and a stripper
// that missed it would cut the rest of a real line away.
func stripJSONComments(in []byte) []byte {
	out := make([]byte, len(in))
	copy(out, in)
	const (
		code = iota
		inString
		inLine
		inBlock
	)
	state := code
	for i := 0; i < len(in); i++ {
		c := in[i]
		switch state {
		case code:
			switch {
			case c == '"':
				state = inString
			case c == '/' && i+1 < len(in) && in[i+1] == '/':
				state = inLine
				out[i], out[i+1] = ' ', ' '
				i++
			case c == '/' && i+1 < len(in) && in[i+1] == '*':
				state = inBlock
				out[i], out[i+1] = ' ', ' '
				i++
			}
		case inString:
			if c == '\\' && i+1 < len(in) {
				i++
				continue
			}
			if c == '"' {
				state = code
			}
		case inLine:
			if c == '\n' {
				state = code
				continue
			}
			out[i] = ' '
		case inBlock:
			if c == '*' && i+1 < len(in) && in[i+1] == '/' {
				out[i], out[i+1] = ' ', ' '
				i++
				state = code
				continue
			}
			if c != '\n' {
				out[i] = ' '
			}
		}
	}
	return out
}

// TestMigrationHistoryMatchesTheWranglerCopy is the guard that matters most: a
// step added to one list and not the other is a class that a wrangler deploy
// creates and a `flue relay setup` does not, or the reverse — and on the update
// path it fails silently, because the client trusts the last tag in its own
// history to be the end of the story.
func TestMigrationHistoryMatchesTheWranglerCopy(t *testing.T) {
	cfg := readWrangler(t)
	if len(cfg.Migrations) != len(Migrations) {
		t.Fatalf("wrangler.jsonc has %d migrations, relaydeploy has %d:\n%+v\nvs\n%+v",
			len(cfg.Migrations), len(Migrations), cfg.Migrations, Migrations)
	}
	for i, want := range Migrations {
		got := cfg.Migrations[i]
		// The tag is part of the contract, not a label: Cloudflare records it
		// against the deployed script, so two tools deploying one Worker have
		// to name the same history.
		if got.Tag != want.Tag {
			t.Errorf("migration %d: wrangler tag %q, relaydeploy tag %q", i, got.Tag, want.Tag)
		}
		if !reflect.DeepEqual(got.NewSQLiteClasses, want.NewSQLiteClasses) {
			t.Errorf("migration %s: wrangler creates %v, relaydeploy creates %v",
				want.Tag, got.NewSQLiteClasses, want.NewSQLiteClasses)
		}
	}
}

// TestDurableObjectBindingsMatchTheWranglerCopy: a binding present in one and
// not the other is a Worker that reads `env.DIRECTORY` on one deploy and
// `undefined` on the other. The Worker fails closed on a missing DIRECTORY
// (503 on /directory), which is the good case; a *class* mismatch is the bad
// one, and Cloudflare only catches it if no migration ever created the class.
func TestDurableObjectBindingsMatchTheWranglerCopy(t *testing.T) {
	cfg := readWrangler(t)
	got := map[string]string{}
	for _, b := range cfg.DurableObjects.Bindings {
		got[b.Name] = b.ClassName
	}
	if !reflect.DeepEqual(got, DOBindings) {
		t.Errorf("wrangler.jsonc binds %v, the deploy binds %v", got, DOBindings)
	}
	// Every class a binding names must also be introduced by some migration, on
	// both sides at once: a binding to a class no migration created is the
	// 10061 that killed `flue relay update`.
	created := map[string]bool{}
	for _, m := range Migrations {
		for _, c := range m.NewSQLiteClasses {
			created[c] = true
		}
	}
	for name, class := range DOBindings {
		if !created[class] {
			t.Errorf("binding %s names class %s, which no migration creates", name, class)
		}
	}
}

// TestRunWorkerFirstMatchesTheWranglerCopy: a path the asset router answers
// before the Worker does is a route that silently becomes the SPA. The bare
// entries are the subtle half — "/directory" *is* the route, and "/daemon"
// alone must reach the Worker's 404 rather than the app shell.
func TestRunWorkerFirstMatchesTheWranglerCopy(t *testing.T) {
	cfg := readWrangler(t)
	if !reflect.DeepEqual(cfg.Assets.RunWorkerFirst, RunWorkerFirst) {
		t.Errorf("run_worker_first differs\n--- wrangler.jsonc ---\n%v\n--- relaydeploy ---\n%v",
			cfg.Assets.RunWorkerFirst, RunWorkerFirst)
	}
	if cfg.Assets.Binding != AssetsBinding {
		t.Errorf("assets.binding = %q, the deploy sends %q", cfg.Assets.Binding, AssetsBinding)
	}
}

// TestDeployMetadataMatchesTheWranglerCopy covers the rest of the twinned
// surface in one place: the compatibility date, the script name the default
// worker is deployed under, and the rate rule's three numbers.
func TestDeployMetadataMatchesTheWranglerCopy(t *testing.T) {
	cfg := readWrangler(t)
	if cfg.CompatibilityDate != CompatibilityDate {
		t.Errorf("compatibility_date = %q, the deploy sends %q", cfg.CompatibilityDate, CompatibilityDate)
	}
	if cfg.Name != DefaultWorker {
		t.Errorf("wrangler name = %q, DefaultWorker = %q", cfg.Name, DefaultWorker)
	}
	if len(cfg.RateLimits) != 1 {
		t.Fatalf("wrangler.jsonc declares %d rate limiters, the deploy sends 1", len(cfg.RateLimits))
	}
	rl := cfg.RateLimits[0]
	if rl.Name != RateLimitBinding || rl.NamespaceID != rateLimitNamespaceID ||
		rl.Simple.Limit != rateLimitRequests || rl.Simple.Period != rateLimitPeriodSecs {
		t.Errorf("rate rule differs: wrangler %s/%s %d per %ds, deploy %s/%s %d per %ds",
			rl.Name, rl.NamespaceID, rl.Simple.Limit, rl.Simple.Period,
			RateLimitBinding, rateLimitNamespaceID, rateLimitRequests, rateLimitPeriodSecs)
	}
}

// TestStripJSONCommentsLeavesStringsAlone: the stripper is only trustworthy if
// a comment marker inside a string survives, which is what a URL in a config
// file is made of.
func TestStripJSONCommentsLeavesStringsAlone(t *testing.T) {
	in := []byte(`{
  // a line comment
  "url": "https://example.test/x", /* trailing block */
  "escaped": "a \" then // not a comment",
  /* a
     block */
  "n": 1
}`)
	var got map[string]any
	if err := json.Unmarshal(stripJSONComments(in), &got); err != nil {
		t.Fatalf("stripped JSONC does not parse: %v\n%s", err, stripJSONComments(in))
	}
	if got["url"] != "https://example.test/x" {
		t.Errorf("url = %q, want the whole URL: // inside a string is not a comment", got["url"])
	}
	if got["escaped"] != `a " then // not a comment` {
		t.Errorf("escaped = %q", got["escaped"])
	}
}
