package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
)

// The Remote screen's relay endpoints. The daemon owns the HTTP surface —
// auth, method policy, body bounds — and an injected RelayUI (wired up by
// cmd/flue, which owns the embedded bundles and the config files) does the
// deploying. The split keeps this package free of any Cloudflare knowledge.
//
// These endpoints exist on the loopback origin only, by construction rather
// than by check: the daemon binds 127.0.0.1, and a relay forwards exactly one
// piece of HTTP (pairing) — every other remote interaction rides the Noise
// channel's wire protocol, which has no operation that reaches these paths.
// That is the property that makes a Cloudflare API token acceptable in a
// request body here at all. It must never be given a wire-protocol
// equivalent: a token typed into a remote tab would ride the relay, and a
// hostile relay origin serving that tab its JavaScript could read it.
const (
	RelayInfoPath   = "/api/relay/info"
	RelayDeployPath = "/api/relay/deploy"
	RelayUpdatePath = "/api/relay/update"
	// RelayJoinPath answers the join line for adding another machine — the
	// same string the deploy result shows, rebuilt from relay.json on demand.
	// It carries both of the relay's credentials — the `DAEMON_SECRET` the
	// Worker also holds, and the fleet key's seed, which nothing but this
	// fleet's own machines ever holds (spec/fleet-trust.md) — which is why it
	// is its own endpoint behind a click rather than a field on Info that
	// every page load would fetch: they should cross into a page exactly when
	// a human asked to see them. Loopback + auth is the boundary that makes
	// even that acceptable — the cookie behind withAuth already spawns
	// shells, so a page that can call this could do worse.
	RelayJoinPath = "/api/relay/join"
	// RelayAddressPath takes {"address": "wss://..."} and repoints relay.json
	// at a custom domain the user routed to the Worker themselves. No
	// Cloudflare call, no token; a POST because it mutates.
	RelayAddressPath = "/api/relay/address"
)

// maxRelayUIBodyBytes bounds a deploy request: a token, an account id, a
// worker name. Eight kilobytes is generous for all three.
const maxRelayUIBodyBytes = 8 << 10

// RelayUIStatus is what GET /api/relay/info reports: enough for the Remote
// screen to decide which of connect / update / nothing to offer. It carries
// no secret — the join secret stays in relay.json and in the one-time deploy
// result.
type RelayUIStatus struct {
	// Configured says relay.json exists and parsed.
	Configured bool   `json:"configured"`
	Origin     string `json:"origin,omitempty"`
	Worker     string `json:"worker,omitempty"`
	// Problems are the faults that stop this daemon dialling the relay.json
	// it has — the same list, in the same words, `flue status` and `flue
	// relay status` print. Empty for a healthy file and for a machine with
	// no relay at all.
	//
	// It exists because Configured answers a narrower question than the
	// screen is asking. A file that parses is configured; a file the
	// transport refuses is not *usable*; and reporting the first as though
	// it were the second is exactly how an upgrade that silently ended
	// remote access looked from every surface flue has — one stderr warning
	// at startup, and three status reports all saying it was fine.
	Problems []string `json:"problems,omitempty"`
	// CanDeploy is false in a dev build, which embeds no Worker; Reason is
	// the sentence the UI shows instead of a button.
	CanDeploy       bool   `json:"can_deploy"`
	CanDeployReason string `json:"can_deploy_reason,omitempty"`
	// Version is this binary's; DeployedVersion is what the relay serves.
	// Normally that is what its /api/health reported — empty when
	// unreachable or unstamped — except right after a deploy this daemon
	// performed, when it is the stamp the daemon shipped: the edge keeps
	// serving the previous Worker for a while after the API accepts a new
	// one, and a health read taken in that window would re-offer an update
	// that just succeeded. The UI offers an update when the two differ.
	Version         string `json:"version"`
	DeployedVersion string `json:"deployed_version,omitempty"`
	// HasToken says a Cloudflare token is stored (config/cloudflare.json), so
	// deploy and update need no token in the request; AccountName is the
	// account it deploys into. The token itself is never in any response.
	HasToken    bool   `json:"has_token"`
	AccountName string `json:"account_name,omitempty"`

	// Transport and TransportOrigin are the relay leg's live state, straight
	// from the daemon (SetRelayStatus) rather than from any config file. They
	// exist because the welcome's relay snapshot is per-connection: a tab
	// greeted while the daemon was still dialling never hears "connected" on
	// that socket, and polling this is how the Remote screen and the Pair
	// gate catch up without a reconnect. Filled by the handler, not the
	// service — the handler is the one on the Server that holds the state.
	Transport       string `json:"transport,omitempty"`
	TransportOrigin string `json:"transport_origin,omitempty"`

	// Directory is the fleet directory as this daemon last saw it, or nil on a
	// daemon that is not reading one (no relay, or a relay from before the
	// directory existed). It is the second half of the answer to "is my fleet
	// wired up": Transport says this machine can be *reached*, and this says
	// it can hear what the other machines have signed — which is what a
	// revocation travels on.
	Directory *DirectoryCounts `json:"directory,omitempty"`
}

// DirectoryCounts is what this daemon last read out of the fleet directory.
//
// Entries is what the relay claimed; Verified is how much of it carried a
// signature under this fleet's key, and the gap between the two is the only
// interesting number here — a relay serving blobs this fleet did not sign is
// either a fleet key that has rotated or a relay that is not the one this
// machine thinks it is.
//
// It is a layout shared with internal/transport/relay (DirectoryCounts there),
// converted rather than imported: this package must not depend on a transport,
// which is the same reason RelayUI is an interface.
type DirectoryCounts struct {
	Connected   bool `json:"connected"`
	Entries     int  `json:"entries"`
	Verified    int  `json:"verified"`
	Machines    int  `json:"machines"`
	Devices     int  `json:"devices"`
	Revocations int  `json:"revocations"`
}

// SetDirectoryCounts installs the reader for the line above. A func rather
// than a value because the numbers change under a socket this package does not
// own, and a snapshot pushed on every change would be a push per revocation
// for a field nothing subscribes to.
func (s *Server) SetDirectoryCounts(read func() DirectoryCounts) {
	s.fleetPubMu.Lock()
	defer s.fleetPubMu.Unlock()
	s.directoryCounts = read
}

func (s *Server) directoryStatus() *DirectoryCounts {
	s.fleetPubMu.Lock()
	read := s.directoryCounts
	s.fleetPubMu.Unlock()
	if read == nil {
		return nil
	}
	c := read()
	return &c
}

// RelayUIAccount is one Cloudflare account a token can reach, for the picker.
type RelayUIAccount struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// RelayUIDeployRequest is the POST body for deploy and update. Token may be
// empty when one is stored (config/cloudflare.json) — the service falls back
// to it; a token that does arrive here is stored on success, by product
// decision, so the next update is a click. Either way the token never rides
// a response and never reaches a log.
type RelayUIDeployRequest struct {
	Token     string `json:"token"`
	AccountID string `json:"account_id,omitempty"`
	Worker    string `json:"worker,omitempty"`
}

// RelayUIDeployResult is what a deploy or update answers. NeedsAccount is the
// one non-terminal shape: the token reaches several accounts and the UI must
// ask which, then POST again with account_id set.
type RelayUIDeployResult struct {
	NeedsAccount bool             `json:"needs_account,omitempty"`
	Accounts     []RelayUIAccount `json:"accounts,omitempty"`

	// Steps are the ✓ lines, in order — the same sentences the CLI prints.
	Steps  []string `json:"steps,omitempty"`
	Origin string   `json:"origin,omitempty"`
	// JoinCommand is the hand-off line for other machines, carrying both of
	// the credentials a machine needs to join: the daemon secret and the
	// fleet key's seed. Shown once, like the CLI's; it is not retrievable
	// from Status — RelayJoinPath rebuilds it, behind a click, for the same
	// reason.
	JoinCommand string `json:"join_command,omitempty"`
	// RestartNeeded is true when a relay transport was already running in
	// this daemon: the new relay.json takes effect on the next restart, and
	// the UI must say so instead of pretending.
	RestartNeeded bool `json:"restart_needed,omitempty"`
}

// RelayUI is the service behind the endpoints. Implementations own every
// long-running or stateful part: the Cloudflare calls, relay.json, and
// starting the transport after a first deploy.
type RelayUI interface {
	Status(ctx context.Context) RelayUIStatus
	Provision(ctx context.Context, req RelayUIDeployRequest) (RelayUIDeployResult, error)
	Update(ctx context.Context, req RelayUIDeployRequest) (RelayUIDeployResult, error)
	// JoinCommand rebuilds the hand-off line from relay.json; ok is false
	// when no relay is configured.
	JoinCommand(ctx context.Context) (cmd string, ok bool, err error)
	// SetAddress repoints relay.json at a new host for the same Worker — the
	// custom-domain move. It returns the new origin; the transport follows
	// on the next daemon start, which the result must say.
	SetAddress(ctx context.Context, address string) (RelayUIDeployResult, error)
}

// ErrRelayUIBadRequest marks a service failure the caller caused — a missing
// token, an account id the token cannot see, a bad worker name — so the
// handler can answer 400 rather than 502. Wrap it.
var ErrRelayUIBadRequest = errors.New("bad relay request")

// SetRelayUI installs the deploy service. Nil (a Server nobody wired) leaves
// the endpoints answering 404, which is also what a dev harness that
// constructs a bare Server gets.
func (s *Server) SetRelayUI(ui RelayUI) {
	s.relayUIMu.Lock()
	defer s.relayUIMu.Unlock()
	s.relayUI = ui
}

func (s *Server) currentRelayUI() RelayUI {
	s.relayUIMu.Lock()
	defer s.relayUIMu.Unlock()
	return s.relayUI
}

// handleRelayInfo answers GET RelayInfoPath. Behind withAuth; a pure read.
func (s *Server) handleRelayInfo(w http.ResponseWriter, r *http.Request) {
	ui := s.currentRelayUI()
	if ui == nil {
		http.NotFound(w, r)
		return
	}
	st := ui.Status(r.Context())
	s.relayMu.Lock()
	st.Transport, st.TransportOrigin = s.relayStatus, s.relayOrigin
	s.relayMu.Unlock()
	// Filled by the handler for the same reason Transport is: it is live state
	// this Server holds, not something the deploy service could know.
	st.Directory = s.directoryStatus()
	writeJSON(w, st)
}

// handleRelayJoin answers GET RelayJoinPath: the join line, secret included.
// Behind withAuth; a read of relay.json, mutating nothing.
func (s *Server) handleRelayJoin(w http.ResponseWriter, r *http.Request) {
	ui := s.currentRelayUI()
	if ui == nil {
		http.NotFound(w, r)
		return
	}
	cmd, ok, err := ui.JoinCommand(r.Context())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if !ok {
		http.Error(w, "no relay is configured", http.StatusNotFound)
		return
	}
	writeJSON(w, map[string]string{"join_command": cmd})
}

// handleRelayAddress answers POST RelayAddressPath: a local file rewrite,
// with the same method guard as the deploys and no credential in the body.
func (s *Server) handleRelayAddress(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	ui := s.currentRelayUI()
	if ui == nil {
		http.NotFound(w, r)
		return
	}
	var req struct {
		Address string `json:"address"`
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxRelayUIBodyBytes+1))
	if err != nil || len(body) > maxRelayUIBodyBytes {
		http.Error(w, "request body unreadable or too large", http.StatusBadRequest)
		return
	}
	if err := json.Unmarshal(body, &req); err != nil || req.Address == "" {
		http.Error(w, "request body is not the expected JSON", http.StatusBadRequest)
		return
	}
	res, err := ui.SetAddress(r.Context(), req.Address)
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, ErrRelayUIBadRequest) {
			status = http.StatusBadRequest
		}
		http.Error(w, err.Error(), status)
		return
	}
	writeJSON(w, res)
}

// handleRelayDeploy and handleRelayUpdate answer POSTs named in
// methodPolicy's allowlist. Behind withAuth, which also enforces provenance:
// a browser POST here carries an Origin, and only this daemon's own origins
// pass.
func (s *Server) handleRelayDeploy(w http.ResponseWriter, r *http.Request) {
	s.serveRelayMutation(w, r, func(ctx context.Context, ui RelayUI, req RelayUIDeployRequest) (RelayUIDeployResult, error) {
		return ui.Provision(ctx, req)
	})
}

func (s *Server) handleRelayUpdate(w http.ResponseWriter, r *http.Request) {
	s.serveRelayMutation(w, r, func(ctx context.Context, ui RelayUI, req RelayUIDeployRequest) (RelayUIDeployResult, error) {
		return ui.Update(ctx, req)
	})
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func (s *Server) serveRelayMutation(w http.ResponseWriter, r *http.Request, run func(context.Context, RelayUI, RelayUIDeployRequest) (RelayUIDeployResult, error)) {
	// methodPolicy names these paths postable, which widens them to
	// GET-or-POST; this narrows them back. A GET here is someone probing, and
	// a mutation must never have a GET spelling.
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	ui := s.currentRelayUI()
	if ui == nil {
		http.NotFound(w, r)
		return
	}
	var req RelayUIDeployRequest
	body, err := io.ReadAll(io.LimitReader(r.Body, maxRelayUIBodyBytes+1))
	if err != nil || len(body) > maxRelayUIBodyBytes {
		http.Error(w, "request body unreadable or too large", http.StatusBadRequest)
		return
	}
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, "request body is not the expected JSON", http.StatusBadRequest)
		return
	}

	// An empty token is allowed through: the service falls back to the stored
	// one and refuses — as a bad request — when there is neither.
	res, err := run(r.Context(), ui, req)
	if err != nil {
		// The error text reaches the screen of the person who typed the
		// token; it never carries the token (nothing downstream echoes it —
		// the same guarantee `flue relay setup` makes in a terminal).
		status := http.StatusBadGateway
		if errors.Is(err, ErrRelayUIBadRequest) {
			status = http.StatusBadRequest
		}
		http.Error(w, err.Error(), status)
		return
	}
	writeJSON(w, res)
}
