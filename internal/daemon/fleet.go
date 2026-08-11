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
// So the daemon does the two things only it can do, on its own origin, behind
// the session token: it fetches the directory itself and hands the bytes over
// unchanged, and it enrols the browser as a device of this fleet.
//
// This surface is loopback-only by construction rather than by check, the same
// property relayui.go relies on: this daemon binds 127.0.0.1, and a relay
// forwards exactly one piece of HTTP (pairing). Every other remote interaction
// rides the Noise channel's wire protocol, which has no operation that reaches
// these paths — and for the enrolment endpoint below that is not a convenience
// but the whole of its safety argument.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"time"

	"github.com/karnstack/flue/internal/fleet"
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

// EnrolPath is `POST /api/fleet/enrol`: the browser on this machine's own
// origin asks to become a device of this machine's fleet, and this daemon —
// which holds the fleet key — says yes.
//
// # Why a loopback browser needs enrolling at all
//
// Pairing exists to turn a stranger into a device. The tab on
// http://127.0.0.1:7717 is not a stranger: it already holds the session
// cookie, which is a machine-local credential that spawns shells. What it does
// not hold is a *fleet* identity — a device key this fleet has certified — and
// without one it can reach this machine and no other, because every sibling
// admits a roaming device on the certificate the device presents in its
// handshake (spec/fleet-trust.md, rule 2). Before this endpoint the only way
// to get one was to run the QR ceremony between a browser and the daemon it
// was already talking to, which is a thing no user would think to do and which
// no screen offers.
//
// # Why this grants no new authority
//
// The claim has to be made precisely, because "an endpoint that mints a fleet
// certificate" sounds like an escalation. It is not, and the reason is that the
// caller already holds strictly more:
//
//   - A client that can open /ws on loopback can send wire.Spawn, whose Cmd is
//     handed to session.Registry.Spawn as argv and executed (conn.go →
//     internal/session/registry.go, which runs exec.Command(argv[0],
//     argv[1:]...)), with the output streamed back.
//   - So it can run `cat ~/.config/flue/relay.json`, which holds the fleet
//     key's seed.
//   - Holding the seed, it can mint a certificate for any key it likes, valid
//     on every machine in the fleet, without asking this daemon anything.
//
// This endpoint therefore collapses three steps into one for the honest case
// and changes nothing whatsoever for the dishonest one. The credential that
// gates it — the session token, through withAuth — is the same credential that
// gates the shell. There is no configuration in which this is reachable and
// that is not.
//
// # Why it is HTTP and never the wire protocol
//
// This is the constraint that matters most, and it is the one relayui.go
// states for the Cloudflare token: a loopback-only surface gets no wire
// equivalent. A `wire.Enrol` message would be reachable from every
// relay-origin device, because the wire protocol is exactly what a relay
// forwards — and it would let any already-admitted device mint a fleet
// certificate for a key of *its* choosing, which is a real escalation:
// admission to one machine would become the power to manufacture admission to
// every machine, for keys nobody has ever proved they hold. The argument above
// does not cover that case, because a relay-origin device cannot read
// relay.json. HTTP on loopback is the boundary, and nothing may move this off
// it.
//
// # What stops a page on another loopback port
//
// Nothing new, and nothing needed to be added. withAuth runs the transport's
// checkProvenance (internal/transport/local): the Host must be one of this
// daemon's two (so DNS rebinding is refused), a present Origin must be one of
// this daemon's own (so http://127.0.0.1:3000 is refused), and a present
// Sec-Fetch-Site must be same-origin or none — a co-resident port's fetch is
// "same-site", which is refused. methodPolicy answers every OPTIONS 405, so no
// preflight can ever succeed and no cross-origin JSON POST can be made at all.
const EnrolPath = "/api/fleet/enrol"

// maxEnrolBytes bounds the enrolment request. The whole document is a 32-byte
// key in base64; four kilobytes is generous, and it is what the pairing POST
// allows for a strictly larger body.
const maxEnrolBytes = 4 << 10

// enrolRequest is what the loopback UI posts: its own device public key, and
// nothing else.
//
// No label, deliberately. The row this creates is described by the daemon
// rather than by the caller — see enrolLabel — because this is the one device
// row whose meaning an operator has to be able to read off a Devices screen
// without thinking, on a machine that may not be the one it belongs to.
type enrolRequest struct {
	// PublicKey is the browser's Noise static public key, 32 bytes in standard
	// base64 — the same encoding, under the same field name, as the pairing
	// POST uses for the same thing.
	PublicKey string `json:"publicKey"`
}

// enrolAnswer is what a successful enrolment hands back: enough for the browser
// to be a fleet device, and not one byte more.
//
// FleetPub is the *public* half and can never be anything else. The seed lives
// in relay.json and in the join line; a browser that held it could mint
// certificates for the whole fleet, and while the argument on EnrolPath shows
// this caller could already read that file, there is a difference between "a
// credential is reachable by whoever can run a shell" and "a credential is
// handed to every tab and written into IndexedDB". The first is the trust
// model; the second is a fleet-wide signing key at rest in the place
// `script-src 'self'` exists to protect.
type enrolAnswer struct {
	DeviceID string `json:"deviceId"`
	// DeviceCert is the fleet device certificate this machine signed for the
	// key. Standard base64 with padding, which is what encoding/json writes a
	// []byte as — the same shape the pairing answer's deviceCert has.
	DeviceCert []byte `json:"deviceCert"`
	// FleetPub is the fleet public key, for the browser to pin. It is the
	// anchor every machine certificate in the directory is checked against, and
	// it arrives here for the reason it rides the QR in a ceremony: from a
	// party that is not an intermediary.
	FleetPub []byte `json:"fleetPub"`
	// MachineID is this machine's id on the relay — the id the certificate
	// above names as `pairedOn`, read from the same live source in the same
	// breath, so the browser's record and the blob cannot disagree.
	MachineID string `json:"machineId"`
}

// enrolLabel is what this machine's own browser is called on every Devices
// screen in the fleet.
//
// It names the machine, because the row turns up somewhere surprising: the
// moment this browser reaches machine B, B admits it on its certificate and
// writes a row of its own (AddFromFleetCert), so B's Devices screen lists a
// device belonging to A.
//
// The name goes into the certificate B reads it from, which is what makes the
// wording load-bearing rather than cosmetic: whatever this returns is signed
// here and rendered *there*, on a machine where the word "this" points at
// something else. It said "<host> — this machine's browser" once, and on B that
// reads as a claim about B. So the label states the machine and nothing
// relative, and every screen in the fleet can render it without knowing where
// it was written.
//
// Through DeviceLabel like every other device name, so one rule bounds and
// normalises a hostname just as it does a name a human typed.
func enrolLabel(hostname string) string {
	if hostname == "" {
		return DeviceLabel("browser")
	}
	return DeviceLabel("Browser on " + hostname)
}

// handleEnrol answers POST EnrolPath.
//
// The order is the pairing handler's order minus the ceremony: method, then a
// registry to write to, then the request's shape, then whether this machine
// can sign for the fleet at all, then the registry itself.
//
// Idempotent by the lookup rather than by the write. A browser calls this on
// every load — it has no way to know whether the daemon it is talking to has
// seen it before, and asking is the cheapest way to find out — so the first
// thing done with the key is FindByKey, and an enrolled device is answered with
// the row and the certificate it already has. Devices.Add is deliberately not
// idempotent (it records a ceremony, which must never happen twice), so
// reaching it a second time for one browser would be an error where there is no
// problem.
func (s *Server) handleEnrol(w http.ResponseWriter, r *http.Request) {
	// methodPolicy names this path postable, which widens it to GET-or-POST;
	// this narrows it back. A GET must never enrol — it is the one method a
	// redirect can launder — and repeating the check locally means the rule
	// survives this handler being mounted somewhere the middleware does not
	// wrap.
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.identity.Devices == nil {
		// A daemon constructed without a registry has nowhere to record this,
		// and that is its own fault rather than the caller's — the status a
		// missing authenticator gets, for the same reason.
		http.Error(w, errNoDeviceRegistry.Error(), http.StatusServiceUnavailable)
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, maxEnrolBytes+1))
	if err != nil || len(body) > maxEnrolBytes {
		http.Error(w, "request body unreadable or too large", http.StatusBadRequest)
		return
	}
	var req enrolRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, "request body is not the expected JSON", http.StatusBadRequest)
		return
	}
	key, err := base64.StdEncoding.DecodeString(req.PublicKey)
	if err != nil || len(key) != 32 {
		http.Error(w, "publicKey must be 32 bytes of standard base64", http.StatusBadRequest)
		return
	}

	// Read at the moment of signing, like every other signing path here:
	// relay.json is written by another process while this one runs, so a key
	// captured earlier is a key that was right until it mattered.
	fi := s.fleetIdentity()
	switch {
	case !fi.Key.Valid():
		// Honest, and a refusal rather than a half-enrolment. Registering the
		// key with no certificate would put a row on the Devices screen that
		// admits this browser to exactly the machine it could already reach,
		// and would leave the browser believing it holds a fleet identity it
		// does not. 409 rather than 500: nothing is broken, this machine is
		// simply not part of a fleet.
		http.Error(w, "this machine holds no fleet key; run the join line from `flue relay setup` on this machine", http.StatusConflict)
		return
	case fi.MachineID == "":
		// A fleet key and no place on the relay. `pairedOn` is a machine id,
		// and one naming the empty machine is a blob no reader can attribute
		// and nothing can line up against the machine certs beside it — the
		// same refusal the pairing ceremony makes, for the same reason.
		http.Error(w, "this machine holds a fleet key but has no machine id on the relay; check `flue status`", http.StatusConflict)
		return
	}

	// The revocation list, before anything is written. FindByKey answers "not
	// found" for a revoked key rather than "revoked", and Devices.Add does not
	// consult the list at all — so without this, enrolling a key the operator
	// had just cut off would write a fresh registry row for it and put the
	// revoked browser back on every Devices screen as a device that cannot
	// connect anywhere. A revocation permanently outranks a certificate
	// (spec/fleet-trust.md); un-revoking is a new key, which for a browser
	// means clearing its storage.
	revoked, err := s.identity.Devices.IsRevoked(key)
	if err != nil {
		http.Error(w, "the device registry could not be read", http.StatusInternalServerError)
		return
	}
	if revoked {
		http.Error(w, "this browser's device key has been revoked; clear this site's storage to enrol under a fresh key", http.StatusForbidden)
		return
	}

	dev, found, err := s.identity.Devices.FindByKey(key)
	if err != nil {
		http.Error(w, "the device registry could not be read", http.StatusInternalServerError)
		return
	}

	var cert []byte
	if found {
		// Already enrolled. The stored blob is handed back rather than
		// re-minted, so a certificate stays one artifact for the life of a
		// pairing — which is what lets the browser compare what it holds
		// against what it is offered. A row with no cert (registered before
		// this machine had a fleet key) is filled in by the same back-fill the
		// welcome uses.
		cert = dev.Cert
		if len(cert) == 0 {
			cert = s.backfillFleetCert(dev)
		}
		if len(cert) == 0 {
			http.Error(w, "this device is registered but its fleet certificate could not be minted", http.StatusInternalServerError)
			return
		}
	} else {
		label := enrolLabel(s.hostname)
		cert, err = fi.Key.Sign(fleet.DeviceCert{
			Device:   key,
			Name:     label,
			PairedOn: fi.MachineID,
			IAT:      time.Now().Unix(),
		})
		if err != nil {
			s.logger().Error("could not mint a fleet certificate for this machine's own browser", "err", err)
			http.Error(w, "could not mint a fleet certificate", http.StatusInternalServerError)
			return
		}
		dev, err = s.identity.Devices.Add(label, key, cert)
		if err != nil {
			s.logger().Error("could not register this machine's own browser", "err", err)
			http.Error(w, "the device registry could not be written", http.StatusInternalServerError)
			return
		}
		s.logger().Info("enrolled this machine's own browser as a fleet device",
			"device", dev.ID, "label", dev.Label, "pairedOn", fi.MachineID)
		// Nothing is published to the fleet directory, exactly as the pairing
		// ceremony publishes nothing: device certificates go to the device they
		// are about and nowhere else (spec/fleet-trust.md, "Device certificates
		// are deliberately not in the directory"). The other machines learn of
		// this browser when it presents the certificate in its handshake.
		//
		// The Devices screen on this machine is showing a list that just gained
		// a row, and the tab that caused it is not the only one looking.
		s.broadcastDeviceList()
	}

	// Not cached anywhere: this is a credential.
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, enrolAnswer{
		DeviceID:   dev.ID,
		DeviceCert: cert,
		// The public half. Never the seed — see enrolAnswer.
		FleetPub:  fi.Key.Public(),
		MachineID: fi.MachineID,
	})
}
