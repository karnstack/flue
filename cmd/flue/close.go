package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"

	"github.com/karnstack/flue/internal/daemon"
	"github.com/karnstack/flue/internal/transport/local"
)

// errCloseUsage answers a bare `flue close`, which could mean either form and
// so gets both. A sentinel rather than a plain error because cmdClose exits 2
// on it — the code main uses for an unknown command, and the right one for
// "you have not said what to close".
var errCloseUsage = errors.New("usage: flue close <id>...  |  flue close --all")

// errUnknownSessions reports that at least one named id closed nothing. The
// per-id lines have already gone to stderr by the time it is returned, so
// cmdClose turns it into a bare exit 1 rather than printing it again.
var errUnknownSessions = errors.New("some sessions were not found")

// cmdClose owns the exit codes runClose cannot: 2 for a usage error and 1 for
// unknown ids, both already explained on stderr. Everything else flows back
// to main's ordinary error path.
func cmdClose(args []string) error {
	err := runClose(os.Stdout, os.Stderr, args)
	switch {
	case errors.Is(err, errCloseUsage):
		fmt.Fprintln(os.Stderr, "flue:", err)
		os.Exit(2)
	case errors.Is(err, errUnknownSessions):
		os.Exit(1)
	}
	return err
}

// runClose ends sessions on the local daemon: every one under --all, the
// named ones otherwise. The writers are the seam — same pattern as statusTo —
// so the tests read both streams without capturing the process's own.
//
// A daemon that is not running is answered with a notice and success, not a
// failure: the user asked for no sessions, and no daemon means exactly that.
// Unknown ids are the one partial outcome — each is named on stderr, the rest
// are closed and counted, and errUnknownSessions carries the failure out.
func runClose(stdout, stderr io.Writer, args []string) error {
	fs := flag.NewFlagSet("close", flag.ContinueOnError)
	fs.SetOutput(stderr)
	all := fs.Bool("all", false, "close every session, running and exited")
	if err := fs.Parse(args); err != nil {
		return errCloseUsage
	}
	ids := fs.Args()
	if !*all && len(ids) == 0 {
		return errCloseUsage
	}

	port, ok := ourDaemon()
	if !ok {
		fmt.Fprintln(stdout, "daemon not running; nothing to close")
		return nil
	}
	token, err := loadToken()
	if err != nil {
		return fmt.Errorf("load auth token: %w", err)
	}

	closed, missing, err := postSessionsClose(port, token, *all, ids)
	if err != nil {
		return err
	}
	for _, id := range missing {
		fmt.Fprintf(stderr, "flue: no such session: %s\n", id)
	}
	noun := "sessions"
	if closed == 1 {
		noun = "session"
	}
	fmt.Fprintf(stdout, "  ✓ closed %d %s\n", closed, noun)
	if len(missing) > 0 {
		return errUnknownSessions
	}
	return nil
}

// postSessionsClose asks the daemon to close sessions and relays its answer.
// The shape mirrors fetchSessions — token in a header, status checked before
// the body is decoded, the body bounded — because it is talking to the same
// daemon under the same rules.
func postSessionsClose(port int, token string, all bool, ids []string) (closed int, missing []string, err error) {
	body, err := json.Marshal(map[string]any{"all": all, "ids": ids})
	if err != nil {
		return 0, nil, err
	}
	u := &url.URL{
		Scheme: "http",
		Host:   fmt.Sprintf("127.0.0.1:%d", port),
		Path:   daemon.SessionsClosePath,
	}
	req, err := http.NewRequest(http.MethodPost, u.String(), bytes.NewReader(body))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(local.HeaderName, token)
	resp, err := probeClient.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusUnauthorized:
		return 0, nil, errTokenRejected
	default:
		return 0, nil, fmt.Errorf("daemon on 127.0.0.1:%d answered %s", port, resp.Status)
	}

	var out struct {
		Closed  int      `json:"closed"`
		Missing []string `json:"missing"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxListingBytes)).Decode(&out); err != nil {
		return 0, nil, fmt.Errorf("decode close answer: %w", err)
	}
	return out.Closed, out.Missing, nil
}
