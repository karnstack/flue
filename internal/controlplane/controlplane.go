// Package controlplane is the daemon's client for flue.sh — the four calls a
// machine makes to the hosted control plane, and nothing else.
//
// It is deliberately not internal/cloudflare's neighbour in spirit: that
// package talks to Cloudflare's API to deploy a relay a user owns, and this one
// talks to app.flue.sh to link a machine to an account somebody has. The two
// share no shape and no credential.
//
// # The wire, which is unusual enough to state
//
// The endpoints are TanStack Start *server functions*, so three things are true
// that are true of almost no other HTTP API, and each one is a silent failure
// if it is got wrong:
//
//  1. **The URL is a content hash.** A server function lives at
//     `/_serverFn/<id>` where the id is
//     `sha256("<source file>--<name>_createServerFn_handler")`. Nothing in
//     either codebase spells it out, and a rename or a move in app/ changes the
//     address of an endpoint every installed daemon keeps posting to. The
//     derivation is `serverFnPath` below, its inputs are the two constants
//     beside it, and both are pinned against app/test/server-fn-ids.json — the
//     file the app's own e2e test checks the build against. See
//     TestServerFunctionPathsMatchTheApp for the order in which the two tests
//     fail, which is the whole point of having them.
//
//  2. **The body must be form-encoded.** Start reads an
//     `application/x-www-form-urlencoded` (or multipart) body as `FormData` and
//     hands it to the endpoint's validator; *any* other body it runs through
//     seroval's `fromJSON`, which wants seroval's own node shape and throws on
//     a plain object. So the obvious Go client — `json.Marshal` with
//     `Content-Type: application/json` — does not reach the handler at all: it
//     fails in Start's body parse, above it, and answers a serialized error
//     envelope rather than the JSON refusal it could have read.
//
//  3. **Every POST must carry an `Origin`.** The app installs CSRF middleware
//     over every server-fn RPC, and it refuses a POST that carries no origin
//     signal at all — which is exactly what a bare `http.Post` sends. Saying
//     which origin it is talking to costs nothing and is not a hole: CSRF
//     exists to stop a *browser* being made to speak with its user's ambient
//     credential, and none of these endpoints has an ambient credential to
//     borrow.
//
// In exchange, the three endpoints answer raw JSON — successes and refusals
// alike, including a 500 — which is the one thing that makes them readable from
// Go at all. See the note at the top of app/src/routes/enroll.tsx for the other
// half of this contract.
//
// # Credentials
//
// Three bearer secrets pass through this package: the device code (the key to a
// grant), the enrollment token (the machine's permanent credential), and the
// channel token (what the relay checks at the upgrade). None of them is ever
// logged, put in a URL, or formatted into an error — the response types below
// redact themselves, and no error carries a response body.
package controlplane

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// DefaultOrigin is where flue.sh's control plane lives. Overridable on
// `flue link` so a developer can point a daemon at a `vite dev` instance.
const DefaultOrigin = "https://app.flue.sh"

// enrollRouteFile is the app source file the three daemon-facing server
// functions are defined in. It is half of every URL this package posts to; see
// the package note, and TestServerFunctionPathsMatchTheApp.
const enrollRouteFile = "src/routes/enroll.tsx"

const (
	fnStartDeviceAuth = "startDeviceAuthFn"
	fnPollDeviceAuth  = "pollDeviceAuthFn"
	fnDaemonToken     = "daemonTokenFn"
)

// StartDeviceAuthPath, PollDeviceAuthPath and DaemonTokenPath are the paths the
// daemon posts to, relative to the control-plane origin. Exported so a test
// elsewhere can stand up a fake control plane that answers on the same
// addresses the real one does.
func StartDeviceAuthPath() string { return serverFnPath(enrollRouteFile, fnStartDeviceAuth) }
func PollDeviceAuthPath() string  { return serverFnPath(enrollRouteFile, fnPollDeviceAuth) }
func DaemonTokenPath() string     { return serverFnPath(enrollRouteFile, fnDaemonToken) }

// serverFnPath is Start's own derivation, in Go.
func serverFnPath(file, name string) string {
	sum := sha256.Sum256([]byte(file + "--" + name + "_createServerFn_handler"))
	return "/_serverFn/" + hex.EncodeToString(sum[:])
}

// requestTimeout bounds one control-plane call. Generous, because the calls are
// made from a reconnect loop that is already backing off, and finite because a
// host that accepts a connection and then says nothing must not park a `flue
// link` — or a dial — indefinitely.
const requestTimeout = 30 * time.Second

// maxResponseBytes bounds a response body. Everything these endpoints send is
// a few hundred bytes; the limit is a backstop against a host that is not the
// control plane.
const maxResponseBytes = 64 << 10

// Client is one daemon's connection to one control plane.
//
// The zero value is not usable: Origin has to name the host, because the same
// string is both the address that is dialled and the `Origin` header the CSRF
// check compares it against.
type Client struct {
	// Origin is the control plane's origin — scheme and host, no path.
	Origin string

	// HTTP is the client every call goes through. Nil means the package's own,
	// which is the ordinary case; a test substitutes one.
	//
	// Whatever is set here must not follow redirects. Every request this
	// package makes carries a credential in its body, and net/http's default
	// client re-sends a POST body on a 307/308 — so a control plane that
	// answered with one would have the daemon hand its enrollment token to
	// wherever it pointed. A redirect is never a valid answer from a server
	// function, so refusing costs nothing.
	HTTP *http.Client
}

// noRedirects is the default transport: the standard client, minus the one
// behaviour that could move a credential somewhere it was not sent.
var noRedirects = &http.Client{
	Timeout: requestTimeout,
	CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	},
}

func (c *Client) http() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return noRedirects
}

// Grant is what `startDeviceAuth` answers: a code for the human and one for the
// daemon.
type Grant struct {
	// UserCode is what the person reads off the terminal and types into the
	// browser, formatted XXXX-XXXX.
	UserCode string `json:"userCode"`
	// DeviceCode is this daemon's bearer secret for the grant, and the only key
	// to the poll. Never printed; see String.
	DeviceCode string `json:"deviceCode"`
	// VerificationURL is where to send the person, chosen by the control plane
	// from the request the daemon made.
	VerificationURL string `json:"verificationUrl"`
	// VerificationURLComplete is the same page with the code in the query, so a
	// link lands with the field filled. Following it approves nothing.
	VerificationURLComplete string `json:"verificationUrlComplete"`
	// ExpiresIn is how many seconds the grant lives.
	ExpiresIn int `json:"expiresIn"`
	// Interval is how many seconds the control plane asks to be left between
	// polls.
	Interval int `json:"interval"`
}

// String redacts the device code. This value is exactly the kind of thing that
// ends up in a `%+v` while somebody is debugging a link that would not
// complete, and the device code is a live credential for as long as the grant
// is open.
func (g Grant) String() string {
	return fmt.Sprintf("controlplane.Grant{UserCode:%s DeviceCode:<redacted> VerificationURL:%s ExpiresIn:%d Interval:%d}",
		g.UserCode, g.VerificationURL, g.ExpiresIn, g.Interval)
}

// The statuses `pollDeviceAuth` answers with.
const (
	// StatusPending: nobody has approved the code yet. Keep polling.
	StatusPending = "pending"
	// StatusApproved: the grant is done with. DeviceToken is present exactly
	// once — on the poll that minted the device — and empty on every poll after
	// it. An approved poll with no token is not an error and not a retry: it
	// means the response carrying the token was lost, and the only way back is
	// to start over.
	StatusApproved = "approved"
	// StatusExpired covers every dead end without distinguishing them: no such
	// grant, an aged-out one, one that was already spent.
	StatusExpired = "expired"
	// StatusConflict: this machine's key already belongs to another account,
	// and nothing was written. It has to be removed from that account first.
	StatusConflict = "conflict"
)

// Poll is what `pollDeviceAuth` answers.
type Poll struct {
	Status      string `json:"status"`
	DeviceID    string `json:"deviceId"`
	DeviceToken string `json:"deviceToken"`
}

// String redacts the enrollment token — the one credential in this package that
// is written to disk and kept for the life of the machine.
func (p Poll) String() string {
	token := "<absent>"
	if p.DeviceToken != "" {
		token = "<redacted>"
	}
	return fmt.Sprintf("controlplane.Poll{Status:%s DeviceID:%s DeviceToken:%s}", p.Status, p.DeviceID, token)
}

// ChannelGrant is what `daemonToken` answers: the credential the relay checks
// at the upgrade, where to present it, and how long it is good for.
type ChannelGrant struct {
	Token    string `json:"token"`
	RelayURL string `json:"relayUrl"`
	// ExpiresIn is seconds. The token is opaque to this daemon — only the
	// control plane and the relay share the key it is signed with — so this is
	// the only thing that says when to mint another.
	ExpiresIn int `json:"expiresIn"`
}

// String redacts the channel token.
func (g ChannelGrant) String() string {
	return fmt.Sprintf("controlplane.ChannelGrant{Token:<redacted> RelayURL:%s ExpiresIn:%d}",
		g.RelayURL, g.ExpiresIn)
}

// Error is a refusal the control plane spelled out, carrying the status it
// came with.
//
// The message is the control plane's own, because those strings are written to
// be read by whoever runs the daemon ("too many enrolments from this address",
// "the device key must be 32 bytes"). It is not passed through *verbatim*: it
// is a string chosen by whatever answered, and where it goes is a terminal the
// operator is watching (cmd/flue/main.go prints it to stderr with no escaping)
// and the daemon's log (internal/transport/relay logs it on every failed dial).
// So it is clipped and stripped on the way in — see `printable`, and
// `printableCode` in cmd/flue/link.go, which does the same for the other two
// server-chosen strings this flow prints. What is never passed through at all
// is a response *body* that is not one of these; see `post`.
type Error struct {
	Status  int
	Message string
}

func (e *Error) Error() string {
	if e.Message == "" {
		return fmt.Sprintf("the control plane answered %d", e.Status)
	}
	return fmt.Sprintf("the control plane answered %d: %s", e.Status, e.Message)
}

// Retryable reports whether waiting and asking again could plausibly work.
//
// 429 is the refusal that is *only* about time, and 5xx is somebody else's
// outage; everything else is about this daemon — a key that is not a key, an
// enrollment that has been revoked — and no amount of retrying changes it.
// Telling the two apart is what stops a daemon spinning on a typo or giving up
// on a full bucket.
func (e *Error) Retryable() bool {
	return e.Status == http.StatusTooManyRequests || e.Status >= 500
}

// StartDeviceAuth opens a grant: the daemon's half of RFC 8628's handshake.
// Unauthenticated, because the machine has no credential yet.
func (c *Client) StartDeviceAuth(ctx context.Context, label, publicKey string) (Grant, error) {
	var out Grant
	err := c.post(ctx, StartDeviceAuthPath(), url.Values{
		"label":     {label},
		"publicKey": {publicKey},
	}, &out)
	return out, err
}

// PollDeviceAuth asks what happened to a grant. The device code is the whole
// credential.
func (c *Client) PollDeviceAuth(ctx context.Context, deviceCode string) (Poll, error) {
	var out Poll
	err := c.post(ctx, PollDeviceAuthPath(), url.Values{"deviceCode": {deviceCode}}, &out)
	return out, err
}

// DaemonToken swaps this machine's enrollment token for a short-lived
// `role: 'daemon'` channel token to dial the relay with.
//
// The enrollment token travels in the body, never the URL: the upgrade and
// every hop in front of it write URLs to logs, and this one is the credential
// that does not expire.
func (c *Client) DaemonToken(ctx context.Context, deviceID, enrollmentToken string) (ChannelGrant, error) {
	var out ChannelGrant
	err := c.post(ctx, DaemonTokenPath(), url.Values{
		"deviceId":        {deviceID},
		"enrollmentToken": {enrollmentToken},
	}, &out)
	return out, err
}

// post makes one server-function call: form-encoded, with an Origin, reading
// the raw JSON back.
func (c *Client) post(ctx context.Context, path string, form url.Values, out any) error {
	origin, err := NormalizeOrigin(c.Origin)
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, origin+path, strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	// The three headers the wire requires. See the package note; getting any of
	// them wrong is a refusal that looks like something else.
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Origin", origin)
	// What the browser's own RPC client sends. Not load-bearing today — the
	// path is enough to route — but it is what marks the request as a server-fn
	// call rather than a document request, and sending it costs nothing.
	req.Header.Set("X-TSR-ServerFn", "true")
	req.Header.Set("Accept", "application/json")

	resp, err := c.http().Do(req)
	if err != nil {
		return fmt.Errorf("reach the control plane at %s: %w", origin, err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return fmt.Errorf("read the control plane's answer (%s): %w", printable(resp.Status), err)
	}

	// Refusals are JSON too, and the message inside one is written for the
	// operator. Anything that is not JSON did not come from one of these three
	// endpoints — a redirect, a CSRF 403 from the middleware in front of them,
	// an error page from something in the way — and its body is bytes chosen by
	// whatever answered, so it never reaches a terminal or a log.
	if resp.StatusCode != http.StatusOK {
		var refusal struct {
			Error string `json:"error"`
		}
		if err := json.Unmarshal(body, &refusal); err != nil || refusal.Error == "" {
			return &Error{Status: resp.StatusCode}
		}
		return &Error{Status: resp.StatusCode, Message: printable(refusal.Error)}
	}

	if err := json.Unmarshal(body, out); err != nil {
		// Deliberately not "%w" on the decode error either: encoding/json quotes
		// the input it choked on in some of its messages.
		return fmt.Errorf("the control plane answered %s with something that is not the JSON this daemon speaks", printable(resp.Status))
	}
	return nil
}

// maxServerMessage bounds a string the control plane chose, in bytes, before it
// is allowed near a terminal or a log.
//
// Two hundred is roughly twice the longest refusal the deployed control plane
// writes, so a real message arrives whole. The bound is not about screen width:
// the body it comes out of is capped at 64 KiB (`maxResponseBytes`), and 64 KiB
// of anything on one log line — once per failed dial, forever, since the relay
// transport retries — is a log nobody reads and a disk somebody pays for.
const maxServerMessage = 200

// printable is what a string chosen by whatever answered has to survive before
// this daemon prints or logs it.
//
// The two things it removes are separate problems with the same source.
//
// **Control and escape characters**, because the destination is a terminal. A
// carriage return rewrites the line above it; an ESC moves the cursor, repaints
// the screen, retitles the window, or on some emulators answers back into the
// shell. `flue link` prints this string to stderr with no escaping
// (cmd/flue/main.go), so a control plane — or anything that has got in front of
// one — could write anywhere on the operator's screen, including over the
// output of whatever they run next. Dropped rather than escaped: an escaped
// control character is noise in a sentence meant to be read, and there is no
// refusal a real control plane writes that needs one. `unicode.IsPrint` is the
// test, so the direction-override characters (Cf) that make a message read
// backwards go too, and invalid UTF-8 with them.
//
// **Length**, because the destination is also a log. See `maxServerMessage`.
//
// Not `printableCode`'s treatment (cmd/flue/link.go), which refuses the whole
// string rather than cleaning it, and that difference is deliberate: a user code
// is typed back in, so a code with one wrong byte is not a code and printing
// part of it would be worse than saying so. A refusal is prose, and prose with
// its escape sequences removed is still the sentence somebody needs to read.
func printable(raw string) string {
	var b strings.Builder
	for _, r := range raw {
		if !unicode.IsPrint(r) {
			continue
		}
		if b.Len()+utf8.RuneLen(r) > maxServerMessage {
			// Clipped on a rune boundary, and said so: a sentence that stops
			// mid-word without a mark reads like the control plane wrote it
			// that way.
			b.WriteString("…")
			break
		}
		b.WriteRune(r)
	}
	return b.String()
}

// NormalizeOrigin turns whatever an operator typed into the exact string that
// is both dialled and sent as the Origin header.
//
// They have to be the same string or the CSRF check refuses the POST, and the
// most likely way for them to differ is the trailing slash somebody pastes out
// of a browser's address bar. A path, a query or a fragment is refused rather
// than trimmed: an operator who typed one meant something this client cannot
// honour, and silently ignoring it would send their daemon somewhere else.
//
// http:// is accepted, not just https://, because `vite dev` serves the control
// plane over it and refusing would mean nobody could develop this flow. It is
// not treated as equivalent: every credential in this package travels in a body
// over that connection, so `flue link` prints a cleartext warning for an origin
// that is not https — see warnIfCleartext there.
//
// Exported so `flue link` can settle on one spelling before it writes one into
// relay.json — a stored origin that differs from the one this client sends is a
// 403 the next time the daemon needs a token.
func NormalizeOrigin(raw string) (string, error) {
	trimmed := strings.TrimSuffix(strings.TrimSpace(raw), "/")
	if trimmed == "" {
		return "", errors.New("no control-plane origin: nothing to link this machine to")
	}
	u, err := url.Parse(trimmed)
	if err != nil {
		return "", fmt.Errorf("the control-plane origin %q is not a URL: %w", raw, err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", fmt.Errorf("the control-plane origin %q needs an https:// scheme (http:// is accepted for local development)", raw)
	}
	if u.Host == "" {
		return "", fmt.Errorf("the control-plane origin %q names no host", raw)
	}
	if u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return "", fmt.Errorf("the control-plane origin %q must be a scheme and a host and nothing else", raw)
	}
	return u.Scheme + "://" + u.Host, nil
}
