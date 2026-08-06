//go:build !dev

// Package relaybundle carries the built relay Worker inside the flue binary,
// so that `flue relay setup` can deploy it into a user's own Cloudflare account
// with no Node, no wrangler, and no checkout — the same promise the embedded
// web app makes for the daemon's UI.
//
// The directory this package lives in is also the Worker's source tree. The Go
// files here are this one and its `dev`-tagged counterpart; everything else is
// esbuild's input and output.
package relaybundle

import (
	"bytes"
	_ "embed"
)

// module is the bundled Worker: relay/src/index.ts through esbuild, ESM, with
// `cloudflare:workers` left external for the runtime to provide.
//
// The build fails outright when relay/dist/index.js is absent, which is the
// intended ordering — `make build` runs `make relay` first. dist is gitignored
// and must stay that way: a committed bundle is a build output that drifts from
// the source beside it, and the only thing worse than no relay is a relay two
// releases behind the daemon that dials it.
//
//go:embed dist/index.js
var module []byte

// Module returns the built Worker.
//
// It returns a copy. The embedded bundle is a package-level []byte, which is
// mutable, so handing out the backing array would let any caller's slice
// arithmetic corrupt every later deploy in the process — a 16 KiB copy on a
// path that runs once per `flue relay setup` is not a cost worth reasoning
// about, and the alternative is a comment nobody reads.
func Module() []byte { return bytes.Clone(module) }
