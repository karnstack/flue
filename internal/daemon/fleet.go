package daemon

// fleet.go is the loopback surface a browser on this machine's own origin
// needs before it can be a member of the fleet at all.
//
// The gap it fills is narrow and was invisible for a long time. A browser that
// paired over the relay holds everything: a device key, a fleet-signed
// certificate, the pinned fleet public key, and a `GET /directory` it reads
// straight off the relay origin. A browser the user opened on
// http://127.0.0.1:7717 holds none of it. It never ran a ceremony — it did not
// need one, the session cookie is its credential — so it has no device
// certificate to present to any sibling machine, and it cannot even read the
// directory to find out that siblings exist: `GET /directory` is a
// cross-origin fetch from the loopback tab and the Worker answers it with no
// `Access-Control-Allow-Origin`, so the browser rejects the response before a
// single byte reaches readDirectory. The Content-Security-Policy is not the
// blocker — LocalCSPFor already names the relay origin — CORS is, and it is
// not a policy this daemon can relax from here.
//
// So the daemon does what only it can do, on its own origin, behind the
// session token: it fetches the directory itself and hands the bytes over
// unchanged.
//
// This surface is loopback-only by construction rather than by check, the same
// property relayui.go relies on: this daemon binds 127.0.0.1, and a relay
// forwards exactly one piece of HTTP (pairing). Every other remote interaction
// rides the Noise channel's wire protocol, which has no operation that reaches
// these paths.

import (
	"context"
	"net/http"
)

// FleetDirectoryPath is `GET /api/fleet/directory`: the relay's fleet
// directory, fetched by this daemon and handed to this daemon's own UI.
//
// It exists because the browser cannot make that read for itself. The tab is
// on http://127.0.0.1:7717 and the directory is on https://<relay>, so the
// fetch is cross-origin; the Worker sends no `Access-Control-Allow-Origin` on
// any route, so the browser discards the answer and `readDirectory` reports
// "no machines" — its answer to every fault, by design. A loopback tab
// therefore showed a fleet of one, on a machine that was fully joined, with
// nothing anywhere saying why.
//
// Why this rather than a CORS header on the Worker. The header would be the
// smaller change and it would work — but only for relays deployed by a flue
// new enough to carry it, which means every existing fleet needs a `flue relay
// update` before its loopback tabs come right, and the failure until then is
// the same silent "no machines". This proxy works against a relay deployed by
// any version, because it speaks the leg this daemon already holds. It also
// adds nothing to the relay's public surface: the bytes go to a caller that is
// already authenticated on loopback, rather than to every origin on the
// internet.
//
// **Verbatim, and that word is the security property.** The body this hands
// back is the relay's answer byte for byte, which means the browser goes on
// verifying every blob in it under the fleet public key it pinned — exactly as
// it does when it reads the relay directly. This daemon is transport here and
// nothing else. It does not parse, filter, re-sign or vouch for a single
// entry, and it must never start to: a directory the daemon had "checked"
// would be one the browser could be tempted to trust on the daemon's say-so,
// and the whole point of the fleet key is that no intermediary — relay or
// daemon — can mint or edit what it signed.
const FleetDirectoryPath = "/api/fleet/directory"

// DirectorySnapshot reads the fleet directory as the relay serves it and
// returns the response body unchanged.
//
// A func rather than an interface for the same reason SetDirectoryCounts takes
// one: it is installed by whoever starts the relay legs, and this package must
// not depend on a transport. The context is the request's, so a browser that
// navigated away stops a read that is still in flight.
//
// An error is an honest answer and the only one available: the relay is
// unreachable, or refused, or is not one that has a directory. None of them is
// something this daemon can paper over, and a fabricated empty directory would
// be indistinguishable to the browser from a fleet of one.
type DirectorySnapshot func(ctx context.Context) ([]byte, error)

// SetDirectorySnapshot installs the reader. Nil — a daemon with no relay, and
// every daemon a test constructs — leaves the endpoint answering 404, which is
// the truthful answer: this machine is not reading a directory, so there is no
// directory here to read.
func (s *Server) SetDirectorySnapshot(read DirectorySnapshot) {
	s.fleetPubMu.Lock()
	defer s.fleetPubMu.Unlock()
	s.directorySnapshot = read
}

func (s *Server) currentDirectorySnapshot() DirectorySnapshot {
	s.fleetPubMu.Lock()
	defer s.fleetPubMu.Unlock()
	return s.directorySnapshot
}

// handleFleetDirectory answers GET FleetDirectoryPath. Behind withAuth; a pure
// read, which is what lets it stay a GET on a surface where every mutation has
// to be a POST.
//
// Three answers and no fourth. A daemon with no directory leg is a 404 — there
// is nothing here, and saying so is what lets the browser fall back to the
// machines it already knows rather than waiting. A relay that could not be
// read is a 502, because the fault is upstream of this daemon and the caller
// should be able to tell "no fleet" from "fleet unreachable". Otherwise: the
// relay's bytes, untouched.
func (s *Server) handleFleetDirectory(w http.ResponseWriter, r *http.Request) {
	read := s.currentDirectorySnapshot()
	if read == nil {
		http.NotFound(w, r)
		return
	}
	body, err := read(r.Context())
	if err != nil {
		// Logged rather than reflected: the text names the relay's URL and the
		// transport error, and the caller has no use for either. What it needs
		// is the status.
		s.logger().Warn("could not read the fleet directory for this machine's own UI", "err", err)
		http.Error(w, "the fleet directory could not be read", http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	// The same header the relay serves this document under, and for the same
	// reason: a directory served from a cache is a revocation served late.
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(body)
}
