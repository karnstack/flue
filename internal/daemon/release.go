package daemon

import (
	"context"
	"net/http"
	"sync"
)

// ReleasePath answers one question: is there a flue newer than this one?
//
// Loopback only, like the relay endpoints beside it, and for a reason that is
// about the answer rather than about secrecy. Upgrading flue means replacing a
// binary on the machine the daemon runs on — a browser cannot do it from
// anywhere, and a phone reading a laptop's fleet over the relay least of all.
// An endpoint that only the machine's own tab can reach is the honest shape
// for a fact only the machine's own operator can act on.
//
// It is also the only place in the app that talks to a third party. The check
// runs here rather than in the tab deliberately: one machine asks GitHub on an
// interval, instead of every open tab asking on every load — including remote
// tabs, which would be telling GitHub about a flue instance from whatever
// network the reader happens to be on.
const ReleasePath = "/api/flue/release"

// ReleaseStatus is what GET ReleasePath reports.
//
// Latest is empty until a check has succeeded, and stays empty for a daemon
// that cannot reach GitHub. That is not an error state to render: a version
// nobody could look up is not news, and a tab that said "could not check for
// updates" would be reporting on the app's plumbing rather than on flue.
type ReleaseStatus struct {
	// Current is this daemon's own version — "dev" for a source build.
	Current string `json:"current"`
	// Latest is the newest published release, without its leading v.
	Latest string `json:"latest,omitempty"`
	// URL is that release's page, for a reader who wants the notes.
	URL string `json:"url,omitempty"`
	// Update says Latest is genuinely newer than Current. A build ahead of
	// the newest tag — anything from main — is not behind, and neither is a
	// "dev" build, which corresponds to no release and so cannot be compared
	// to one.
	Update bool `json:"update"`
}

// ReleaseChecker is the service behind the endpoint. cmd/flue implements it;
// this package holds no knowledge of GitHub, of tags, or of how often to ask.
type ReleaseChecker interface {
	// Release answers from cache and refreshes out of band. It must not block
	// on the network: this is behind a page load.
	Release(ctx context.Context) ReleaseStatus
}

// releaseState is the injected checker, set after construction like relayUI.
type releaseState struct {
	mu      sync.Mutex
	checker ReleaseChecker
}

// SetReleaseChecker installs the checker. Nil — a Server nobody wired, which
// is every test harness that does not care — leaves the endpoint answering
// 404, and the sidebar simply never offers an upgrade.
func (s *Server) SetReleaseChecker(c ReleaseChecker) {
	s.release.mu.Lock()
	defer s.release.mu.Unlock()
	s.release.checker = c
}

func (s *Server) currentReleaseChecker() ReleaseChecker {
	s.release.mu.Lock()
	defer s.release.mu.Unlock()
	return s.release.checker
}

// handleRelease answers GET ReleasePath. Behind withAuth; a pure read.
func (s *Server) handleRelease(w http.ResponseWriter, r *http.Request) {
	c := s.currentReleaseChecker()
	if c == nil {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	writeJSON(w, c.Release(r.Context()))
}
