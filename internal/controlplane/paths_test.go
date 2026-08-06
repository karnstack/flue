package controlplane

import (
	"encoding/json"
	"os"
	"testing"
)

// pinnedPaths is app/test/server-fn-ids.json — the one written-down copy of the
// three URLs this package posts to.
type pinnedPaths struct {
	Functions map[string]struct {
		File string `json:"file"`
		Path string `json:"path"`
	} `json:"functions"`
}

// TestServerFunctionPathsMatchTheApp is the Go half of a cross-language
// contract, and the reason this package hardcodes anything at all.
//
// TanStack Start addresses a server function at /_serverFn/<id>, where the id
// is sha256("<source file>--<name>_createServerFn_handler"). Nothing in either
// codebase spells the resulting URL: the app's own tests read it back out of
// the build, and this package computes it from two strings. So a rename or a
// move in app/src/routes/enroll.tsx changes the address of an endpoint that
// every *already installed* flue is going to keep posting to — a break that
// ships to users and shows up as a 404 nobody can explain.
//
// app/test/server-fn-ids.json is the file both sides check against, and the
// order is what makes the coupling impossible to forget: the app's
// enroll-e2e.test.ts fails first (the build no longer serves the pinned path),
// and updating the JSON to match then fails this test until the constants below
// are updated with it.
func TestServerFunctionPathsMatchTheApp(t *testing.T) {
	t.Parallel()

	b, err := os.ReadFile("../../app/test/server-fn-ids.json")
	if err != nil {
		t.Fatalf("read the pinned server-function ids: %v", err)
	}
	var pinned pinnedPaths
	if err := json.Unmarshal(b, &pinned); err != nil {
		t.Fatalf("parse the pinned server-function ids: %v", err)
	}

	for name, got := range map[string]string{
		"startDeviceAuthFn": StartDeviceAuthPath(),
		"pollDeviceAuthFn":  PollDeviceAuthPath(),
		"daemonTokenFn":     DaemonTokenPath(),
	} {
		want, ok := pinned.Functions[name]
		if !ok {
			t.Errorf("app/test/server-fn-ids.json no longer pins %s", name)
			continue
		}
		if want.File != enrollRouteFile {
			t.Errorf("%s now lives in %s, but this package derives its URL from %s",
				name, want.File, enrollRouteFile)
		}
		if got != want.Path {
			t.Errorf("%s path = %s, the app pins %s", name, got, want.Path)
		}
	}

	if n := len(pinned.Functions); n != 3 {
		t.Errorf("the app pins %d daemon-facing server functions, this package knows 3", n)
	}
}

// TestServerFnPathDerivation pins the derivation itself against a value
// computed outside this program:
//
//	printf 'src/routes/enroll.tsx--startDeviceAuthFn_createServerFn_handler' | shasum -a 256
//
// The test above compares two files that could, in principle, both be wrong in
// the same way. This one says what the formula is.
func TestServerFnPathDerivation(t *testing.T) {
	t.Parallel()

	const want = "/_serverFn/c35a8f2c42d27479930cf4c680f912de3e36a1e0086f50ca3cc4da268f9890e3"
	if got := serverFnPath("src/routes/enroll.tsx", "startDeviceAuthFn"); got != want {
		t.Errorf("serverFnPath = %s, want %s", got, want)
	}
}
