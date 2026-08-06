//go:build !dev

package relaybundle

import (
	"bytes"
	"testing"
)

// TestModuleIsTheBuiltWorker guards the one failure //go:embed cannot catch.
// A missing relay/dist/index.js fails the build outright, which is the point
// of embedding it — but an empty file, or one left behind by a build that died
// halfway, embeds perfectly happily and would deploy a Worker that answers
// nothing.
//
// DaemonHub is the check because it is the name the deploy's migration and
// Durable Object binding both refer to (cmd/flue/relay.go): a bundle that does
// not export it produces a Worker Cloudflare rejects, or worse, accepts with a
// binding pointing at a class that is not there.
func TestModuleIsTheBuiltWorker(t *testing.T) {
	mod := Module()
	if len(mod) == 0 {
		t.Fatal("Module() is empty; build the worker with `cd relay && pnpm build`")
	}
	if !bytes.Contains(mod, []byte("DaemonHub")) {
		t.Fatal("Module() does not mention DaemonHub; relay/dist/index.js is stale — rebuild it with `cd relay && pnpm build`")
	}
}

// TestModuleDoesNotAliasTheEmbeddedBytes: the embedded bundle is a package
// global and a []byte is mutable, so handing the same backing array to every
// caller would let one of them corrupt every later deploy in the process.
func TestModuleDoesNotAliasTheEmbeddedBytes(t *testing.T) {
	first := Module()
	first[0] = 'X'
	if second := Module(); second[0] == 'X' {
		t.Fatal("Module() returns the embedded slice itself; a caller can scribble on the bundle")
	}
}
